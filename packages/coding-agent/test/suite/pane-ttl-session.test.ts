import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { isPaneBusy, PaneTtl, type PaneTtlTimer } from "../../src/core/pane-ttl.ts";
import { createHarness, type Harness } from "./harness.ts";

const MIN = 60_000;
const quietUi = { hasOpenDialog: () => false, hasDraft: () => false };

/** The real AgentSession drives the busy signals. Only the clock and the interval are fake. */
function watch(harness: Harness, ttlMin: number) {
	let now = 0;
	const ticks: Array<() => void> = [];
	const expired: number[] = [];
	const ttl = new PaneTtl({
		ttlMs: ttlMin * MIN,
		isBusy: () => isPaneBusy(harness.session, quietUi),
		onExpire: (idleMs) => expired.push(idleMs),
		now: () => now,
		schedule: (tick): PaneTtlTimer => {
			ticks.push(tick);
			return { cancel: () => ticks.splice(ticks.indexOf(tick), 1) };
		},
	});
	ttl.start();
	harness.session.subscribe(() => ttl.touch());
	return {
		expired,
		advance(ms: number) {
			now += ms;
			for (const tick of [...ticks]) tick();
		},
	};
}

/** A tool that runs until the test releases it, so the test controls how long "work" lasts. */
function makeSlowTool() {
	let release: () => void = () => {};
	let signalStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const slowTool: AgentTool = {
		name: "slow",
		label: "slow",
		description: "waits for the test",
		parameters: Type.Object({}),
		execute: async () => {
			signalStarted();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	return { slowTool, started, release: () => release() };
}

describe("pane TTL against a real AgentSession", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A harness whose first model reply calls the slow tool, followed by the given replies. */
	async function slowToolPane(ttlMin: number, replies: string[]) {
		const { slowTool, started, release } = makeSlowTool();
		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
			...replies.map((reply) => fauxAssistantMessage(reply)),
		]);
		return { harness, pane: watch(harness, ttlMin), started, release };
	}

	it("does not expire during a long tool, then expires after the quiet time", async () => {
		const { harness, pane, started, release } = await slowToolPane(10, ["finished"]);

		const run = harness.session.prompt("go");
		await started;
		expect(harness.session.isStreaming).toBe(true);
		pane.advance(5 * 60 * MIN); // five hours inside one tool
		expect(pane.expired).toEqual([]);

		release();
		await run;
		expect(harness.session.isStreaming).toBe(false);
		pane.advance(9 * MIN);
		expect(pane.expired).toEqual([]);
		pane.advance(1 * MIN);
		expect(pane.expired).toHaveLength(1);
	});

	it("does not expire during a retry wait after a 429-style error", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 150 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
			fauxAssistantMessage("recovered"),
		]);
		const pane = watch(harness, 10);
		const during: Array<{ retrying: boolean; busy: boolean }> = [];
		harness.session.subscribe((event) => {
			if (event.type !== "auto_retry_start") return;
			// _retryAbortController is set just after this event, so sample inside the backoff sleep.
			setTimeout(() => {
				during.push({ retrying: harness.session.isRetrying, busy: isPaneBusy(harness.session, quietUi) });
				pane.advance(2 * 60 * MIN); // far past the TTL while the wait is active
			}, 50);
		});

		await harness.session.prompt("go");

		expect(during).toEqual([{ retrying: true, busy: true }]);
		expect(harness.session.isRetrying).toBe(false);
		expect(pane.expired).toEqual([]);
		pane.advance(10 * MIN);
		expect(pane.expired).toHaveLength(1);
	});

	it("does not expire while a follow-up is queued behind a running tool", async () => {
		const { harness, pane, started, release } = await slowToolPane(1, ["first", "second"]);

		const run = harness.session.prompt("go");
		await started;
		await harness.session.followUp("then this");
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(isPaneBusy(harness.session, quietUi)).toBe(true);
		pane.advance(30 * MIN);
		expect(pane.expired).toEqual([]);

		release();
		await run;
		pane.advance(1 * MIN);
		expect(pane.expired).toHaveLength(1);
	});
});
