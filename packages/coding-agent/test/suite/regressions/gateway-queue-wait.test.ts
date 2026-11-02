import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Gateway (Throttler) queue bounce: a 503 stamped with x-anthropic-throttle-queue-timeout: 1.
function queuedBounce(retryAfterMs?: number) {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "503 proxy queue wait exceeded; slots saturated — retrying will re-enter the fair queue",
		}),
		gatewayQueued: true,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

describe("gateway queue wait", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("(a) waits out stamped bounces without spending the retry budget or keeping errors in history", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([queuedBounce(), queuedBounce(), queuedBounce(), fauxAssistantMessage("served")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("queue_wait_start").map((event) => event.waitCount)).toEqual([1, 2, 3]);
		expect(harness.eventsOfType("queue_wait_end")).toHaveLength(3);
		expect(harness.session.retryAttempt).toBe(0);
		const errorsInHistory = harness.session.messages.filter(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		expect(errorsInHistory).toEqual([]);
	});

	it("(b) honors Retry-After on an ordinary 503", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const delays: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "auto_retry_start") return;
			delays.push(event.delayMs);
			harness.session.abortRetry(); // the delay is what is under test; do not sleep for it
		});
		harness.setResponses([
			{
				...fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
				retryAfterMs: 7000,
			},
			fauxAssistantMessage("late"),
		]);

		await harness.session.prompt("test");

		expect(delays).toEqual([7000]);
	});

	it("(c) an un-stamped 503 still uses the normal retry budget", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("queue_wait_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
	});

	it("(d) fails with the normal error once the turn's queue wait would exceed maxQueueWaitMs", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxQueueWaitMs: 500 } },
		});
		harnesses.push(harness);
		harness.setResponses([queuedBounce(), fauxAssistantMessage("never reached")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("queue_wait_start")).toEqual([]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
	});
});
