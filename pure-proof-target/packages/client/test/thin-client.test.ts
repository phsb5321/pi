import type { RemoteServiceTransport } from "@earendil-works/chord";
import { describe, expect, test } from "vitest";
import { createSessionInvoke, createThinClient, type Invoke } from "../src/thin-client.ts";

/** Mini engine on the canary seam: `submit` appends, `observe` returns the transcript. */
function miniEngine(): { invoke: Invoke; transcript: string[] } {
	const transcript: string[] = [];
	const invoke: Invoke = async ({ member, args }) => {
		if (member === "submit") {
			transcript.push(String(args?.[0] ?? ""));
			return { ok: true };
		}
		if (member === "observe") return [...transcript];
		throw new Error(`mini engine: unknown member ${member}`);
	};
	return { invoke, transcript };
}

describe("thin-client leg (canary seam)", () => {
	test("round-trips submit/observe through the factory shape", async () => {
		const { invoke, transcript } = miniEngine();
		const client = createThinClient("s1", invoke);
		expect(client.sessionId).toBe("s1");
		await client.submit("one");
		await client.submit("two");
		expect(await client.observe()).toEqual(["one", "two"]);
		expect(transcript).toEqual(["one", "two"]);
	});

	test("serializes concurrent submits in submission order", async () => {
		const seen: string[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const invoke: Invoke = async ({ member, args }) => {
			if (member === "submit") {
				await gate; // hold every submit until all are queued
				seen.push(String(args?.[0] ?? ""));
				return { ok: true };
			}
			if (member === "observe") return [...seen];
			throw new Error(`unknown ${member}`);
		};
		const client = createThinClient("s1", invoke);
		const submissions = ["1", "2", "3", "4", "5"].map((text) => client.submit(text));
		release?.();
		await Promise.all(submissions);
		expect(seen).toEqual(["1", "2", "3", "4", "5"]);
		expect(await client.observe()).toEqual(["1", "2", "3", "4", "5"]);
	});

	test("close is idempotent, drains in-flight submits, then rejects", async () => {
		const { invoke } = miniEngine();
		const client = createThinClient("s1", invoke);
		const inflight = client.submit("last");
		await client.close();
		await client.close(); // idempotent
		await inflight; // drained before close resolved
		expect(await createThinClient("s2", invoke).observe()).toContain("last");
		await expect(client.submit("late")).rejects.toThrow(/closed/);
		await expect(client.observe()).rejects.toThrow(/closed/);
	});

	test("observe validates the payload shape", async () => {
		const bad: Invoke = async ({ member }) => (member === "observe" ? ({ not: "a list" } as never) : undefined);
		const client = createThinClient("s1", bad);
		await expect(client.observe()).rejects.toThrow(/non-string\[\]/);
	});

	test("createSessionInvoke bridges the wire transport into the factory shape", async () => {
		const calls: unknown[] = [];
		const transport = {
			invoke: async (call: unknown) => {
				calls.push(call);
				return { ok: true };
			},
			subscribe: () => {
				throw new Error("unused");
			},
		} as unknown as RemoteServiceTransport;
		const invoke = createSessionInvoke(transport);
		await invoke({ member: "submit", args: ["hello"] });
		await invoke({ member: "observe" });
		expect(calls).toEqual([
			{ serviceId: "canary.session", member: "submit", args: ["hello"] },
			{ serviceId: "canary.session", member: "observe", args: [] },
		]);
	});
});
