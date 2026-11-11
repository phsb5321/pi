import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("waitForIdle during settlement hooks and nested deferred turns", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("waits through hooks, nested settlement, and the remaining outer deferred turn", async () => {
		const entered = [latch(), latch(), latch()];
		const released = [latch(), latch(), latch()];
		const idleInHooks: boolean[] = [];
		let settled = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async (_event, ctx) => {
						const index = settled++;
						idleInHooks.push(ctx.isIdle());
						if (index === 0) {
							pi.sendUserMessage("first deferred turn");
							pi.sendUserMessage("second deferred turn");
						}
						entered[index].release();
						await released[index].promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
		]);
		const running = harness.session.prompt("initial request");
		try {
			await entered[0].promise;
			let firstReturned = false;
			const waiting = harness.session.waitForIdle().then(() => {
				firstReturned = true;
			});
			await Promise.resolve();
			expect(firstReturned).toBe(false);
			released[0].release();
			await entered[1].promise;
			expect(firstReturned).toBe(false);
			released[1].release();
			await entered[2].promise;
			expect(firstReturned).toBe(false);
			let lateReturned = false;
			const lateWaiting = harness.session.waitForIdle().then(() => {
				lateReturned = true;
			});
			await Promise.resolve();
			expect(lateReturned).toBe(false);
			released[2].release();
			await Promise.all([running, waiting, lateWaiting]);
			expect(idleInHooks).toEqual([true, true, true]);
			expect(getUserTexts(harness)).toEqual(["initial request", "first deferred turn", "second deferred turn"]);
		} finally {
			for (const release of released) release.release();
			await running;
		}
	});

	it("releases idle waiters after a settlement subscriber throws without retaining settlement depth", async () => {
		const entered = latch();
		const released = latch();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						entered.release();
						await released.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") throw new Error("settlement subscriber failed");
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		const running = harness.session.prompt("request");
		await entered.promise;
		const waiting = harness.session.waitForIdle();
		released.release();
		await expect(running).rejects.toThrow("settlement subscriber failed");
		await waiting;
		expect(harness.session.isIdle).toBe(true);
		await harness.session.waitForIdle();
	});
});
