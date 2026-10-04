import type { JsonValue } from "@earendil-works/chord";
import type { RequestEnvelope, ServerId } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { attachSession, attachSessions, requireSessionTarget } from "../src/client-attach.ts";
import { createLazyThinClient } from "../src/thin-client.ts";
import { Client, DisconnectedError, type SessionTarget } from "../src/index.ts";
import { MemoryByteServer } from "./support.ts";

const serverId: ServerId = "00000000-0000-4000-8000-000000000001";

interface ServiceShape {
	serviceId: string;
	member: string;
	args: JsonValue[];
}

/**
 * Synthetic host implementing the frozen server contract
 * (`SessionRouter.attachClientNow` + `echoEngineShell`):
 * - attach is idempotent: re-attaching the same session is a no-op (same
 *   route, no second `attachment` publish);
 * - attaching a different session publishes a new `attachmentId`;
 * - `echo` returns `{echoed: call}`; `state` returns the session's live echo
 *   count (per-session isolation across hosted sessions).
 */
class ContractHost {
	readonly attachmentPublishes: Array<{ sessionId: string; attachmentId: string } | null> = [];
	readonly echoCounts = new Map<string, number>();
	readonly transcripts = new Map<string, string[]>();
	private attachmentSequence = 0;
	private readonly routes = new Map<MemoryByteServer, SessionTarget | undefined>();

	respondAll(server: MemoryByteServer, cursor: { index: number }): void {
		while (cursor.index < server.messages.length) {
			const message = server.messages[cursor.index++]!;
			if (message.type !== "request") continue;
			this.#respond(server, message);
		}
	}

	#respond(server: MemoryByteServer, request: RequestEnvelope): void {
		const service = request.call as unknown as ServiceShape;
		const ok = (result: JsonValue | null): void => {
			server.send({ type: "response", id: request.id, ok: true, result });
		};
		const fail = (code: string): void => {
			server.send({ type: "response", id: request.id, ok: false, error: { code, message: code } });
		};
		if (service.serviceId === "pi.session-management" && service.member === "attach") {
			const sessionId = service.args[0] as string;
			const current = this.routes.get(server);
			if (current?.sessionId === sessionId) {
				ok(null); // idempotent: same route, no publish (server contract)
				return;
			}
			const target: SessionTarget = {
				serverId,
				sessionId,
				attachmentId: `attachment-${++this.attachmentSequence}`,
			};
			this.routes.set(server, target);
			this.attachmentPublishes.push({ sessionId, attachmentId: target.attachmentId });
			server.send({ type: "attachment", attachment: target });
			ok(null);
			return;
		}
		if (service.serviceId === "pi.session-management" && service.member === "detach") {
			this.routes.set(server, undefined);
			this.attachmentPublishes.push(null);
			server.send({ type: "attachment", attachment: null });
			ok(null);
			return;
		}
		const route = this.routes.get(server);
		const requested = request.target as SessionTarget;
		if (
			route === undefined ||
			route.sessionId !== requested.sessionId ||
			route.attachmentId !== requested.attachmentId
		) {
			fail("session-not-attached");
			return;
		}
		if (service.member === "echo") {
			this.echoCounts.set(route.sessionId, (this.echoCounts.get(route.sessionId) ?? 0) + 1);
			ok({ echoed: request.call } as unknown as JsonValue); // echoEngineShell shape
			return;
		}
		if (service.member === "state") {
			ok({ state: this.echoCounts.get(route.sessionId) ?? 0 });
			return;
		}
		if (service.member === "submit") {
			// ThinClient seam members (canary engine shape): transcript append.
			const lines = this.transcripts.get(route.sessionId) ?? [];
			lines.push(String(service.args[0] ?? ""));
			this.transcripts.set(route.sessionId, lines);
			ok({ ok: true });
			return;
		}
		if (service.member === "observe") {
			ok([...(this.transcripts.get(route.sessionId) ?? [])] as unknown as JsonValue);
			return;
		}
		fail("unsupported");
	}
}

interface Connection {
	readonly server: MemoryByteServer;
	readonly client: Client;
}

/** One connection with a background host pump (responds as requests arrive). */
async function openConnection(host: ContractHost): Promise<Connection> {
	const server = new MemoryByteServer();
	const cursor = { index: 0 };
	const client = await Client.connect({ serverId, transportFactory: (handlers) => server.connect(handlers) });
	const pump = async (): Promise<void> => {
		for (;;) {
			await server.waitForMessages(cursor.index + 1);
			host.respondAll(server, cursor);
		}
	};
	void pump();
	return { server, client };
}

/** Lazy presentation on a synthetic connection (shared setup for the lazy cases). */
function lazyOn(
	host: ContractHost,
	sessionId = "session-a",
): { lazy: ReturnType<typeof createLazyThinClient>; connects: () => number; connection: () => Client | undefined } {
	let connects = 0;
	let connection: Client | undefined;
	const lazy = createLazyThinClient({
		sessionId,
		connect: async () => {
			connects += 1;
			connection = (await openConnection(host)).client;
			return connection;
		},
	});
	return { lazy, connects: () => connects, connection: () => connection };
}

describe("client-attach contract (headless, synthetic host)", () => {
	test("attaches to two hosted sessions and round-trips echo/state per session", async () => {
		const host = new ContractHost();
		const sessions = await attachSessions({
			sessionIds: ["session-a", "session-b"],
			connect: async () => (await openConnection(host)).client,
		});
		// Two hosted sessions take two connections (one route per connection).
		expect(sessions.map((session) => session.sessionId)).toEqual(["session-a", "session-b"]);
		expect(new Set(sessions.map((session) => session.target?.attachmentId)).size).toBe(2);
		expect(host.attachmentPublishes).toHaveLength(2);

		// echo/state round-trips through the chord service transport, isolated per session.
		const [a, b] = sessions;
		await a!.invoke({ serviceId: "canary.echo", member: "echo", args: ["a1"] });
		await a!.invoke({ serviceId: "canary.echo", member: "echo", args: ["a2"] });
		await b!.invoke({ serviceId: "canary.echo", member: "echo", args: ["b1"] });
		const stateA = await a!.invoke({ serviceId: "canary.echo", member: "state", args: [] });
		const stateB = await b!.invoke({ serviceId: "canary.echo", member: "state", args: [] });
		expect(stateA).toEqual({ state: 2 });
		expect(stateB).toEqual({ state: 1 });
	});

	test("idempotent attach: re-attaching the same session keeps the route", async () => {
		const host = new ContractHost();
		const { client } = await openConnection(host);
		const session = await attachSession(client, "session-a");
		const attachmentId = session.target?.attachmentId;
		const again = await attachSession(client, "session-a");
		expect(again.target?.attachmentId).toBe(attachmentId);
		expect(host.attachmentPublishes).toHaveLength(1); // idempotent no-op, per server contract
	});

	test("idempotent attach: racing duplicate attaches publish exactly one route", async () => {
		const host = new ContractHost();
		const { client } = await openConnection(host);
		const [first, second] = await Promise.all([
			attachSession(client, "session-a"),
			attachSession(client, "session-a"),
		]);
		expect(first.target?.attachmentId).toBe(second.target?.attachmentId);
		expect(host.attachmentPublishes).toHaveLength(1);
	});

	test("stale-route rejection: a superseded attachmentId is refused", async () => {
		const host = new ContractHost();
		const { client } = await openConnection(host);
		const sessionA = await attachSession(client, "session-a");
		const staleId = sessionA.target?.attachmentId;
		await attachSession(client, "session-b"); // supersedes the route
		await expect(
			client.request(
				{ serverId, sessionId: "session-a", attachmentId: staleId! },
				{ serviceId: "canary.echo", member: "echo", args: ["stale"] },
			),
		).rejects.toThrow(/session-not-attached/);
	});

	test("detach semantics: route is dropped, calls are rejected, re-attach restores", async () => {
		const host = new ContractHost();
		const { client } = await openConnection(host);
		const session = await attachSession(client, "session-a");
		await session.detach();
		expect(client.attachment).toBeUndefined();
		expect(() => requireSessionTarget(client, "session-a")).toThrow(DisconnectedError);
		expect(host.attachmentPublishes.at(-1)).toBeNull();

		const restored = await attachSession(client, "session-a");
		expect(restored.target?.sessionId).toBe("session-a");
		expect(host.attachmentPublishes.at(-1)).not.toBeNull();
	});

	test("route switch: attaching a different session publishes a new attachmentId", async () => {
		const host = new ContractHost();
		const { client } = await openConnection(host);
		const sessionA = await attachSession(client, "session-a");
		const attachmentIdA = sessionA.target?.attachmentId;
		const sessionB = await attachSession(client, "session-b");
		expect(sessionB.target?.attachmentId).not.toBe(attachmentIdA);
		expect(host.attachmentPublishes.filter(Boolean)).toHaveLength(2);
	});

	test("lazy presentation holds no state until first use", async () => {
		const host = new ContractHost();
		const { lazy, connects } = lazyOn(host);
		expect(connects()).toBe(0); // no connection, no attach, no presentation state
		await lazy.submit("first");
		expect(connects()).toBe(1);
		expect(await lazy.observe()).toEqual(["first"]);
		expect(connects()).toBe(1);
		expect(host.attachmentPublishes).toHaveLength(1);
	});

	test("lazy first-use races attach exactly once (idempotent)", async () => {
		const host = new ContractHost();
		const { lazy, connects } = lazyOn(host);
		await Promise.all([lazy.submit("a"), lazy.observe(), lazy.submit("b")]);
		expect(connects()).toBe(1);
		expect(host.attachmentPublishes).toHaveLength(1);
		expect(await lazy.observe()).toEqual(["a", "b"]);
	});

	test("lazy close before first use is a zero-cost no-op", async () => {
		const host = new ContractHost();
		const { lazy, connects } = lazyOn(host);
		await lazy.close();
		expect(connects()).toBe(0);
		expect(host.attachmentPublishes).toHaveLength(0);
		await expect(lazy.submit("late")).rejects.toThrow(/closed/);
		await expect(lazy.observe()).rejects.toThrow(/closed/);
	});

	test("lazy close after use detaches and disconnects exactly once", async () => {
		const host = new ContractHost();
		const { lazy, connection } = lazyOn(host);
		await lazy.submit("kept");
		await lazy.close();
		await lazy.close(); // idempotent
		expect(host.attachmentPublishes.at(-1)).toBeNull();
		expect(connection()?.connected).toBe(false);
		await expect(lazy.observe()).rejects.toThrow(/closed/);
	});
});
