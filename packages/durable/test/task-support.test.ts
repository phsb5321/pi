import { afterEach, expect, it, vi } from "vitest";
import { eventually } from "./task-support.ts";

afterEach(() => vi.useRealTimers());

it("eventually permits work beyond 200 scheduler turns within its deadline", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const started = performance.now();
	const result = eventually(() => performance.now() - started >= 500);
	await vi.advanceTimersByTimeAsync(501);
	await result;
});

it("eventually rejects an unmet condition at its bounded monotonic deadline", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const result = expect(eventually(() => false)).rejects.toThrow("Condition was not reached");
	await vi.advanceTimersByTimeAsync(2_000);
	await result;
	expect(performance.now()).toBe(2_000);
});
