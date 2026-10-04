import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DURABLE_MEMBERS, ResidencyClient, toThinClient } from "../src/experimental/durable/thin-residency-binding.ts";

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
