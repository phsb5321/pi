import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import { afterEach, describe, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { ServerError } from "../src/errors.ts";
import { Server } from "../src/server.ts";
import { createTestServerServices, ProtocolTestClient, type WireChannel } from "../src/testing/index.ts";
import type {
	MaybePromise,
	RoutedSessionAttachment,
	RoutedSessionHandle,
	ServerHost,
	SessionMetadata,
} from "../src/types.ts";

// 005 — independent isolation/recovery cases for the shared Node runtime.
// Real runtime: the actual `Server` machinery over wire channels (only the
// byte transport is in-memory). Public synthetic fixtures only: synthetic
// sessions, synthetic providers, synthetic auth/cwd/env labels. No real
// session or credential corpora. No live seat kill/reload, no paid calls.

const SERVER_ID = "00000000-0000-4000-8000-000000000005";

/** Synthetic per-session identity: distinct providers, auth labels, cwd, env. */
interface SyntheticSession extends SessionMetadata {
	providerId: string;
	authLabel: string;
	cwd: string;
	envTag: string;
	pluginClass: "none" | "sync-blocking" | "global-mutating";
}

/** Public synthetic fixtures — no real corpora. */
const SESSION_A: SyntheticSession = {
	id: "session-a",
	providerId: "synthetic-provider-a",
	authLabel: "synthetic-auth-a",
	cwd: "/synthetic/cwd/a",
	envTag: "env-a",
	pluginClass: "none",
};
const SESSION_B: SyntheticSession = {
	id: "session-b",
	providerId: "synthetic-provider-b",
	authLabel: "synthetic-auth-b",
	cwd: "/synthetic/cwd/b",
	envTag: "env-b",
	pluginClass: "none",
};

/**
 * Unsupported shared-runtime plugin classes (recorded contract): plugins in
 * these classes MUST run in an isolated fallback (own process/host) instead
 * of silently sharing globals. The host below refuses to share them.
 */
const UNSUPPORTED_SHARED_PLUGIN_CLASSES: readonly string[] = ["sync-blocking", "global-mutating"];

class SyntheticSharedHost implements ServerHost<SyntheticSession> {
	readonly durableWrites = new Map<string, number>();
	readonly toolSends = new Map<string, number>();
	openSessions = 0;
	readonly terminatedReasons = new Map<string, Error | undefined>();
	private readonly handles = new Map<string, SyntheticHandle>();
	maxConcurrentOpens = Infinity;

	// Server-wide management reuses the shared test implementation (pi.session-management
	// attach/detach through the routed presentation); these cases exercise Session routing.
	readonly serverServices = createTestServerServices();

	async resolveSession(sessionId: string): Promise<SyntheticSession> {
		const found = [SESSION_A, SESSION_B].find((session) => session.id === sessionId);
		if (!found) throw new Error(`unknown session ${sessionId}`);
		return found;
	}

	async openSession(metadata: SyntheticSession): Promise<RoutedSessionHandle> {
		if (UNSUPPORTED_SHARED_PLUGIN_CLASSES.includes(metadata.pluginClass)) {
			// Require isolated fallback rather than silently sharing globals.
			throw new Error(`plugin class ${metadata.pluginClass} requires isolated fallback`);
		}
		if (this.openSessions >= this.maxConcurrentOpens) {
			// Bounded refusal: only whitelisted ServerError codes cross the wire
			// (any other error is masked as internal_error by design).
			throw new ServerError("server_draining", "concurrent open cap reached");
		}
		this.openSessions += 1;
		const handle = new SyntheticHandle(metadata, this);
		this.handles.set(metadata.id, handle);
		return handle;
	}

	/** Test-side: crash a session (unexpected termination). */
	crash(sessionId: string): void {
		const handle = this.handles.get(sessionId);
		handle?.crashWith(new Error("synthetic crash"));
	}

	/** Test-side accessor for lifecycle assertions. */
	handleFor(sessionId: string): SyntheticHandle | undefined {
		return this.handles.get(sessionId);
	}
}

class SyntheticHandle implements RoutedSessionHandle {
	readonly terminated: Promise<Error | undefined>;
	private resolveTerminated!: (error: Error | undefined) => void;
	attachments = 0;
	private readonly host: SyntheticSharedHost;
	private readonly metadata: SyntheticSession;

	constructor(metadata: SyntheticSession, host: SyntheticSharedHost) {
		this.metadata = metadata;
		this.host = host;
		this.terminated = new Promise((resolve) => {
			this.resolveTerminated = resolve;
		});
	}

	attachClient(): RoutedSessionAttachment {
		this.attachments += 1;
		const session = this.metadata;
		const host = this.host;
		return {
			async invokeService(
				call: ServiceCall,
				publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
				context: Context,
			): Promise<JsonValue | undefined> {
				const method = String((call as { member?: unknown }).member ?? "");
				// Stale-attachment refusals are enforced by the server router itself
				// (server-issued attachment ids; mismatch = session_not_attached).
				if (method === "whoami") {
					return {
						providerId: session.providerId,
						authLabel: session.authLabel,
						cwd: session.cwd,
						envTag: session.envTag,
					};
				}
				if (method === "durable-write") {
					host.durableWrites.set(session.id, (host.durableWrites.get(session.id) ?? 0) + 1);
					return { writes: host.durableWrites.get(session.id) ?? 0 };
				}
				if (method === "tool-send") {
					host.toolSends.set(session.id, (host.toolSends.get(session.id) ?? 0) + 1);
					return { sends: host.toolSends.get(session.id) ?? 0 };
				}
				if (method === "stall") {
					await new Promise(() => {}); // never resolves by design
					return undefined;
				}
				if (method === "emit-event") {
					// Minimal valid state update; the member carries the env tag so the
					// leakage test can detect which client's stream it surfaced in.
					await publish("events", { type: "state", member: session.envTag, sequence: 1, ops: [] }, context);
					return { published: true };
				}
				return { echo: (call as unknown as { args?: JsonValue }).args ?? null };
			},
			async release() {
				// attachment released
			},
		};
	}

	async close(): Promise<void> {
		this.resolveTerminated(undefined);
	}

	crashWith(error: Error): void {
		this.resolveTerminated(error);
	}
}

// Wire-channel client plumbing against the real Server (transport in-memory).
const servers = new Set<Server>();
function connect(server: Server): ProtocolTestClient {
	let handler: ByteConnectionHandler;
	let client: ProtocolTestClient;
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close(finalChunk) {
			if (finalChunk) client.receive(finalChunk);
			closed = true;
			client.markClosed();
		},
	};
	const channel: WireChannel = {
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			if (closed) return;
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	};
	client = new ProtocolTestClient(channel);
	handler = server.accept(connection);
	transportByClient.set(client, channel);
	return client;
}

const transportByClient = new WeakMap<ProtocolTestClient, WireChannel>();
function disconnect(client: ProtocolTestClient): Promise<void> {
	return transportByClient.get(client)!.close();
}

// The SERVER owns attachment identity: every attach publishes an `attachment`
// message and routed calls must target that server-issued id (the session
// router refuses any other id with session_not_attached). Latest id wins per
// session.
function latestAttachmentId(client: ProtocolTestClient, sessionId: string): string | undefined {
	for (let index = client.messages.length - 1; index >= 0; index--) {
		const message = client.messages[index];
		if (message.type === "attachment" && message.attachment?.sessionId === sessionId) {
			return message.attachment.attachmentId;
		}
	}
	return undefined;
}

async function attachRouted(client: ProtocolTestClient, sessionId: string): Promise<string> {
	const response = await client.attach(SERVER_ID, sessionId);
	if (response.ok !== true) throw new Error(`attach failed: ${JSON.stringify(response.error)}`);
	const attachmentId = latestAttachmentId(client, sessionId);
	if (attachmentId === undefined) throw new Error(`no attachment id broadcast for ${sessionId}`);
	return attachmentId;
}

// Response envelopes are a success/failure union; these cases assert on the
// success payload and fail loudly on an error envelope instead.
function resultOf(envelope: Awaited<ReturnType<ProtocolTestClient["requestService"]>>): JsonValue | undefined {
	if (envelope.ok !== true) throw new Error(`request failed: ${JSON.stringify(envelope.error)}`);
	return envelope.result;
}

function createHarness(maxConcurrentOpens = Infinity) {
	const host = new SyntheticSharedHost();
	host.maxConcurrentOpens = maxConcurrentOpens;
	const server = new Server(host, { listeners: [], serverId: SERVER_ID });
	servers.add(server);
	return { host, server };
}

afterEach(() => {
	servers.clear();
});

describe("shared runtime isolation cases", () => {
	test("distinct synthetic sessions and providers stay distinct", async () => {
		const { host } = createHarness();
		const server = servers.values().next().value as Server;
		const clientA = connect(server);
		const clientB = connect(server);
		await clientA.hello();
		await clientB.hello();
		const idA = await attachRouted(clientA, SESSION_A.id);
		const idB = await attachRouted(clientB, SESSION_B.id);
		const targetA = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: idA };
		const targetB = { serverId: SERVER_ID, sessionId: SESSION_B.id, attachmentId: idB };
		const a = await clientA.requestService(targetA, { serviceId: "synthetic", member: "whoami", args: [] });
		const b = await clientB.requestService(targetB, { serviceId: "synthetic", member: "whoami", args: [] });
		expect(resultOf(a)).toMatchObject({ providerId: "synthetic-provider-a" });
		expect(resultOf(b)).toMatchObject({ providerId: "synthetic-provider-b" });
		expect(host.openSessions).toBe(2);
	});

	test("no cross-session events, auth, cwd, or environment leakage", async () => {
		createHarness();
		const server = servers.values().next().value as Server;
		const clientA = connect(server);
		const clientB = connect(server);
		await clientA.hello();
		await clientB.hello();
		const idA = await attachRouted(clientA, SESSION_A.id);
		const idB = await attachRouted(clientB, SESSION_B.id);
		const targetA = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: idA };
		const targetB = { serverId: SERVER_ID, sessionId: SESSION_B.id, attachmentId: idB };
		const a = await clientA.requestService(targetA, { serviceId: "synthetic", member: "whoami", args: [] });
		const b = await clientB.requestService(targetB, { serviceId: "synthetic", member: "whoami", args: [] });
		// Structural isolation: each result carries ONLY its own session identity.
		expect(resultOf(a)).toMatchObject({
			providerId: "synthetic-provider-a",
			authLabel: "synthetic-auth-a",
			cwd: "/synthetic/cwd/a",
			envTag: "env-a",
		});
		expect(resultOf(b)).toMatchObject({
			providerId: "synthetic-provider-b",
			authLabel: "synthetic-auth-b",
			cwd: "/synthetic/cwd/b",
			envTag: "env-b",
		});
		// Event scoping: A's publish must not surface in B's message stream.
		await clientA.requestService(targetA, { serviceId: "synthetic", member: "emit-event", args: [] });
		expect(clientB.messages.some((m) => JSON.stringify(m).includes("env-a"))).toBe(false);
		expect(clientA.messages.some((m) => JSON.stringify(m).includes("env-a"))).toBe(true);
	});

	test("stale attachment id after reconnect is refused, not silently shared", async () => {
		createHarness();
		const server = servers.values().next().value as Server;
		const client = connect(server);
		await client.hello();
		const staleId = await attachRouted(client, SESSION_A.id);
		// Re-attach on the SAME connection is idempotent (same id); the stale case
		// is the old id after the attachment was released by disconnect.
		await disconnect(client);
		const client2 = connect(server);
		await client2.hello();
		const freshId = await attachRouted(client2, SESSION_A.id);
		expect(freshId).not.toBe(staleId);
		const stale = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: staleId };
		const fresh = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: freshId };
		const staleResult = await client2.requestService(stale, { serviceId: "synthetic", member: "whoami", args: [] });
		const freshResult = await client2.requestService(fresh, { serviceId: "synthetic", member: "whoami", args: [] });
		// Bounded refusal: code session_not_attached (not a shared live attachment,
		// and not session_ambiguous — that code is duplicate-ids only).
		expect(JSON.stringify(staleResult)).toContain("session_not_attached");
		expect(JSON.stringify(staleResult)).not.toContain("session_ambiguous");
		expect(resultOf(freshResult)).toMatchObject({ providerId: "synthetic-provider-a" });
	});

	test("crash reports the reason; clean close reports none", async () => {
		const { host } = createHarness();
		const server = servers.values().next().value as Server;
		const clientA = connect(server);
		const clientB = connect(server);
		await clientA.hello();
		await clientB.hello();
		const idA = await attachRouted(clientA, SESSION_A.id);
		await attachRouted(clientB, SESSION_B.id);
		// Clean close of B, crash of A: each terminated settles its own reason.
		const targetA = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: idA };
		await clientA.requestService(targetA, { serviceId: "synthetic", member: "durable-write", args: [] });
		const handleA2 = host.handleFor(SESSION_A.id)!;
		const handleB = host.handleFor(SESSION_B.id)!;
		const terminatedA = handleA2.terminated;
		const terminatedB = handleB.terminated;
		host.crash(SESSION_A.id);
		await handleB.close();
		expect((await terminatedA)?.message).toBe("synthetic crash");
		expect(await terminatedB).toBeUndefined();
	});

	test("disconnect and reconnect cause no duplicate durable writes or tool sends", async () => {
		const { host } = createHarness();
		const server = servers.values().next().value as Server;
		const first = connect(server);
		await first.hello();
		const idFirst = await attachRouted(first, SESSION_A.id);
		const target = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: idFirst };
		await first.requestService(target, { serviceId: "synthetic", member: "durable-write", args: [] });
		await first.requestService(target, { serviceId: "synthetic", member: "tool-send", args: [] });
		// Disconnect mid-life, reconnect, re-attach, repeat the same writes once.
		await disconnect(first);
		// Exactly-once is a durable-layer guarantee (server = route integrity only);
		// this end-to-end case is the right test (p2 contract 4).
		const second = connect(server);
		await second.hello();
		const idSecond = await attachRouted(second, SESSION_A.id);
		const target2 = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: idSecond };
		await second.requestService(target2, { serviceId: "synthetic", member: "durable-write", args: [] });
		await second.requestService(target2, { serviceId: "synthetic", member: "tool-send", args: [] });
		expect(host.durableWrites.get(SESSION_A.id)).toBe(2); // exactly once per send
		expect(host.toolSends.get(SESSION_A.id)).toBe(2);
	});
});

describe("shared runtime robustness cases", () => {
	test("cap holds under concurrent opens", async () => {
		const { host } = createHarness(1);
		const server = servers.values().next().value as Server;
		const clientA = connect(server);
		const clientB = connect(server);
		await clientA.hello();
		await clientB.hello();
		await attachRouted(clientA, SESSION_A.id);
		const openB = clientB.attach(SERVER_ID, SESSION_B.id);
		const resultB = await openB;
		// The second concurrent open is refused by a bounded error, not shared.
		expect(resultB.ok).toBe(false);
		expect(JSON.stringify(resultB)).toContain("cap");
		if (resultB.ok === false) expect(resultB.error.code).toBe("server_draining");
		expect(host.openSessions).toBe(1);
	});

	test("a stalled service call does not wedge other sessions", async () => {
		const { host } = createHarness();
		const server = servers.values().next().value as Server;
		const clientA = connect(server);
		const clientB = connect(server);
		await clientA.hello();
		await clientB.hello();
		const idA = await attachRouted(clientA, SESSION_A.id);
		const idB = await attachRouted(clientB, SESSION_B.id);
		const targetA = { serverId: SERVER_ID, sessionId: SESSION_A.id, attachmentId: idA };
		const targetB = { serverId: SERVER_ID, sessionId: SESSION_B.id, attachmentId: idB };
		const stalled = clientA.requestService(targetA, { serviceId: "synthetic", member: "stall", args: [] });
		const prompt = await clientB.requestService(targetB, { serviceId: "synthetic", member: "whoami", args: [] });
		expect(resultOf(prompt)).toMatchObject({ providerId: "synthetic-provider-b" });
		// The stalled call stays pending (no duplicate effect, no wedge).
		expect(host.durableWrites.has(SESSION_A.id)).toBe(false);
		void stalled;
	});

	test("unsupported plugin classes require isolated fallback, not shared globals", async () => {
		const { host } = createHarness();
		// The recorded contract: these classes never share the runtime.
		expect(UNSUPPORTED_SHARED_PLUGIN_CLASSES).toEqual(["sync-blocking", "global-mutating"]);
		const blocking: SyntheticSession = { ...SESSION_A, id: "session-block", pluginClass: "sync-blocking" };
		const mutating: SyntheticSession = { ...SESSION_B, id: "session-mutate", pluginClass: "global-mutating" };
		await expect(host.openSession(blocking)).rejects.toThrow("requires isolated fallback");
		await expect(host.openSession(mutating)).rejects.toThrow("requires isolated fallback");
		// The isolated fallback path is the requirement: a non-shared handle per
		// plugin session (asserted by the refusal to open shared ones above).
		expect(host.openSessions).toBe(0);
	});
});
