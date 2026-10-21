import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createThinPresentation } from "msqa/thin-presentation";

// Adversarial scheduler probes of the actual compiled renderer. Delayed legs
// are explicit test doubles, NOT native SDK or streaming acceptance evidence.
test("compiled renderer refuses old generation observe after disconnect/re-attach", async () => {
	let releaseOld;
	const oldState = new Promise((resolve) => { releaseOld = resolve; });
	let generation = 0;
	const seen = [];
	const presentation = createThinPresentation({ surfaceId: "qa-stale", pollMs: 0, onState: (lines) => seen.push(...lines),
		create: () => {
			const attached = ++generation;
			return { sessionId: "qa-stale", submit: async () => undefined, close: async () => undefined,
				observe: async () => attached === 1 ? oldState : ["generation-two-owned-state"] };
		},
	});
	try {
		presentation.component.render(80);
		await delay(0);
		assert.equal(presentation.attachGeneration, 1);
		const pendingOld = presentation.refresh();
		await presentation.exit();
		presentation.component.render(80);
		await delay(0);
		assert.equal(presentation.attachGeneration, 2);
		await presentation.refresh();
		releaseOld(["generation-one-foreign-state"]);
		await pendingOld;
		assert(seen.includes("generation-two-owned-state"));
		assert(!seen.includes("generation-one-foreign-state"), "Old observation must not reach onState after new attach");
		assert(!presentation.component.render(80).join("\n").includes("generation-one-foreign-state"), "Old observation must not paint");
	} finally { releaseOld([]); await presentation.exit(); presentation.dispose(); }
});

test("compiled renderer generation/window/disposal are behavioral, not flag-only", async () => {
	let creates = 0;
	let closes = 0;
	const presentation = createThinPresentation({ surfaceId: "qa-window", window: 4, pollMs: 0,
		create: () => { creates++; return { sessionId: "qa-window", submit: async () => undefined,
			observe: async () => ["entry-0", "entry-1", "entry-2", "entry-3", "entry-4", "entry-5"],
			close: async () => { closes++; } }; },
	});
	assert.equal(creates, 0);
	presentation.component.render(80);
	await delay(0);
	await presentation.refresh();
	presentation.setGeometry({ rows: 10, cols: 80, viewportTop: 1, mode: "main" });
	const frame = presentation.component.render(80).join("\n");
	assert(!frame.includes("entry-0"), "Outside window entry must not materialize");
	assert(!frame.includes("entry-5"), "Viewport anchoring must exclude later entry");
	assert(frame.includes("entry-4"), "Window retains its own anchor");
	await presentation.exit();
	await presentation.exit();
	assert.equal(closes, 1);
	presentation.dispose();
	await assert.rejects(presentation.submit("after-dispose"), /disposed|closed/i);
});
