// GHP-MODEL-FENCE-01 (GPT Web r01): provider-invocation guard, tests R1-R5 plus positive control.
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createInvocationFence, type InvocationAdmission } from "../src/core/model-invocation-fence.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { testModel } from "./model-runtime-test-utils.ts";

const BASE = "https://example.test/v1";

async function setup(overrides: Partial<InvocationAdmission> | null, session = "s1") {
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const calls = { count: 0 };
	for (const provider of ["fake-a", "fake-b"]) {
		runtime.registerProvider(provider, {
			baseUrl: BASE,
			apiKey: "k",
			api: "openai-completions",
			streamSimple: () => {
				calls.count++;
				throw new Error("provider reached");
			},
			models: [testModel("m1"), testModel("m2")],
		});
	}
	const state = {
		admission: overrides
			? ({
					seatId: "seat",
					sessionId: "s1",
					provider: "fake-a",
					modelId: "m1",
					api: "openai-completions",
					baseUrl: BASE,
					attemptId: "a1",
					revision: 1,
					expiresAt: Date.now() + 60_000,
					...overrides,
				} as InvocationAdmission)
			: undefined,
		session,
	};
	runtime.setInvocationGuard(
		createInvocationFence({ admission: () => state.admission, sessionId: () => state.session }),
	);
	const run = async (provider: string, id: string) => {
		const result = await runtime.completeSimple(runtime.getModel(provider, id)!, { messages: [] });
		return result.errorMessage ?? "";
	};
	return { run, calls, state };
}

describe("model invocation fence", () => {
	it("R1 refuses a wrong model with zero provider calls", async () => {
		const { run, calls } = await setup({});
		expect(await run("fake-a", "m2")).toContain("wrong-model");
		expect(calls.count).toBe(0);
	});

	it("R2 refuses a stale admission after session drift", async () => {
		const { run, calls, state } = await setup({});
		state.session = "s2";
		expect(await run("fake-a", "m1")).toContain("session-drift");
		expect(calls.count).toBe(0);
	});

	it("R3 refuses missing and expired admission", async () => {
		const missing = await setup(null);
		expect(await missing.run("fake-a", "m1")).toContain("missing-admission");
		const expired = await setup({ expiresAt: Date.now() - 1 });
		expect(await expired.run("fake-a", "m1")).toContain("missing-admission");
		expect(missing.calls.count + expired.calls.count).toBe(0);
	});

	it("R4 refuses a different provider or endpoint with the same model id", async () => {
		const { run, calls, state } = await setup({});
		expect(await run("fake-b", "m1")).toContain("provider-mismatch");
		state.admission = { ...state.admission!, baseUrl: "https://other.test/v1" };
		expect(await run("fake-a", "m1")).toContain("provider-mismatch");
		expect(calls.count).toBe(0);
	});

	it("R5 refuses automatic replay of an attempt that may have reached the transport", async () => {
		const { run, calls } = await setup({});
		expect(await run("fake-a", "m1")).toContain("provider reached");
		expect(calls.count).toBe(1);
		expect(await run("fake-a", "m1")).toContain("uncertain-effect");
		expect(calls.count).toBe(1);
	});

	it("positive control reaches the provider exactly once", async () => {
		const { run, calls } = await setup({});
		expect(await run("fake-a", "m1")).toContain("provider reached");
		expect(calls.count).toBe(1);
	});
});
