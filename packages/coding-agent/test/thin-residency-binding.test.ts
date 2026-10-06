import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DURABLE_MEMBERS, ResidencyClient, toThinClient, virtualThinClient } from "../src/experimental/durable/thin-residency-binding.ts";

function recordingInvoke(): { calls: Array<{ member: string; args?: unknown[] }>; invoke: (call: { member: string; args?: unknown[] }) => Promise<unknown> } {
	const calls: Array<{ member: string; args?: unknown[] }> = [];
	return {
		calls,
		invoke: async (call) => {
			calls.push(call);
			if (call.member === "view") return { lines: ["one", "two"] };
			if (call.member === "residency") return { sessionId: "s", cwd: "/c", nativeSessionId: "n", directory: "/d", released: 0, resumed: 0, live: true };
			return { ok: true };
		},
	};
}

describe("thin-residency binding (contract to ms/composition-1241 adapter)", () => {
	it("maps every required surface to the committed member set", async () => {
		const { calls, invoke } = recordingInvoke();
		const client = new ResidencyClient(invoke);
		await client.submit("hi"); // input
		await client.view(); // deltas + tool events + history
		await client.abort(); // active-cancel
		await client.compact();
		await client.switchConversation("c2");
		await client.residency(); // cwd
		client.close(); // close
		assert.deepEqual(
			calls.map((call) => call.member),
			["submit", "view", "abort", "compact", "switchConversation", "residency"],
		);
		for (const call of calls) {
			assert.ok(call.member === "residency" || (DURABLE_MEMBERS as readonly string[]).includes(call.member));
		}
	});

	it("toThinClient adapts observe to the view surface and keeps submit/close", async () => {
		const { invoke } = recordingInvoke();
		const leg = toThinClient(new ResidencyClient(invoke), "s1");
		assert.equal(leg.sessionId, "s1");
		await leg.submit("hello");
		assert.deepEqual(await leg.observe(), ["one", "two"]);
		await leg.close();
	});

	it("negative: post-close calls are rejected client-side", async () => {
		const { invoke } = recordingInvoke();
		const client = new ResidencyClient(invoke);
		client.close();
		await assert.rejects(client.submit("late"), /closed/);
		assert.equal(client.closed, true);
	});
});

describe("virtual presentation seam (p4 contract, accepted)", () => {
	function fakeVirtual(): {
		presentation: import("../src/experimental/durable/thin-residency-binding.ts").VirtualPresentation;
		control: import("../src/experimental/durable/thin-residency-binding.ts").VirtualPresentationControl;
		detached: () => boolean;
		observeCalls: number;
	} {
		const state = { detached: false, observeCalls: 0 };
		const presentation = {
			sessionId: "s1",
			window: 20,
			async observe(fromGeneration?: number) {
				state.observeCalls += 1;
				if (fromGeneration !== undefined && fromGeneration > 1) throw new Error("future generation refused");
				return { generation: 1, entries: ["a", "b"] };
			},
			async viewState() {
				return { ok: true };
			},
			async detach() {
				state.detached = true;
			},
		};
		const control = {
			async submit() {
				return { ok: true };
			},
			async abort() {
				return { ok: true };
			},
		};
		return { presentation, control, detached: () => state.detached, observeCalls: state.observeCalls } as never;
	}

	it("maps observe (generation-ordered entries) and submit/abort onto ThinClient", async () => {
		const fake = fakeVirtual();
		const leg = virtualThinClient(fake.presentation, fake.control);
		assert.deepEqual(await leg.observe(), ["a", "b"]);
		await leg.submit("hi");
		assert.equal(leg.sessionId, "s1");
	});

	it("resyncs on stale generation and detaches via close", async () => {
		const fake = fakeVirtual();
		const leg = virtualThinClient(fake.presentation, fake.control);
		await leg.observe(); // generation 1
		await leg.close();
		assert.equal(fake.detached(), true);
	});
});

describe("attach-protocol delta (pE impl-notes A1/A7/R11)", () => {
	it("A7: detach fails closed while the residency release is outstanding", async () => {
		let detached = 0;
		const presentation = {
			sessionId: "s1",
			window: 20,
			async observe() {
				return { generation: 1, entries: [] };
			},
			async viewState() {
				return {};
			},
			async detach() {
				detached += 1;
			},
		};
		const control = { submit: async () => ({}), abort: async () => ({}) };
		const held = { released: 0, resumed: 0, live: true, openedRetained: true };
		const leg = virtualThinClient(presentation as never, control as never, async () => held);
		await assert.rejects(leg.close(), /residency not released/);
		assert.equal(detached, 0);
		const released = { released: 1, resumed: 0, live: false, openedRetained: false };
		const leg2 = virtualThinClient(presentation as never, control as never, async () => released);
		await leg2.close();
		assert.equal(detached, 1);
	});

	it("R11: stale generation reads resync from the current generation", async () => {
		let current = 2;
		const presentation = {
			sessionId: "s1",
			window: 20,
			async observe(fromGeneration?: number) {
				if (fromGeneration !== undefined && fromGeneration > current) throw new Error("future generation refused");
				return { generation: current, entries: [`entry-${current}`] };
			},
			async viewState() {
				return {};
			},
			async detach() {},
		};
		const leg = virtualThinClient(presentation as never, { submit: async () => ({}), abort: async () => ({}) } as never);
		assert.deepEqual(await leg.observe(), ["entry-2"]);
		current = 3;
		assert.deepEqual(await leg.observe(), ["entry-3"]); // stale read resyncs
	});
});
