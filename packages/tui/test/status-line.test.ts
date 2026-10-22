import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Loader } from "../src/components/loader.ts";
import {
	configureStatusLinePolicy,
	DEFAULT_STATUS_LINE_POLICY,
	getStatusLinePolicy,
	OnChangeCounterCache,
} from "../src/status-line.ts";

// Behavior pins for the status-line seam (1615 P2+P6). These FAIL if the fork's
// throttled status line regresses (counters, spinner cadence, frame semantics).
// Sparkline semantics (measured finding): no sparkline widget exists upstream or in the
// fork; the seam exposes no sparkline sampling, and the spinner frames carry no
// sparkline glyphs — pinned below.

const ui = { requestRender() {} };

function makeLoader(indicator?: { frames?: string[]; intervalMs?: number }): Loader {
	return new Loader(
		ui as never,
		(s) => s,
		(s) => s,
		"msg",
		indicator,
	);
}

test("policy defaults sit in the 1–2 Hz band (P2) with a 500 ms counter bound (P6)", () => {
	assert.equal(DEFAULT_STATUS_LINE_POLICY.spinnerTickMs, 500);
	assert.equal(DEFAULT_STATUS_LINE_POLICY.counterRefreshMs, 500);
	assert.ok(DEFAULT_STATUS_LINE_POLICY.spinnerTickMs >= 250 && DEFAULT_STATUS_LINE_POLICY.spinnerTickMs <= 1000);
});

test("loader default tick follows the seam: one frame per policy tick, none before it", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	try {
		const loader = makeLoader();
		loader.start();
		const first = loader.render(80)[1];
		mock.timers.tick(200);
		assert.equal(
			loader.render(80)[1],
			first,
			"no frame may advance before the policy tick (would fail at the old 80 ms cadence)",
		);
		mock.timers.tick(300);
		assert.notEqual(loader.render(80)[1], first, "the spinner must still animate at the policy tick");
		loader.stop();
	} finally {
		mock.timers.reset();
	}
});

test("explicit intervalMs (plugin knob) still wins over the policy default", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	try {
		const loader = makeLoader({ frames: ["a", "b"], intervalMs: 80 });
		loader.start();
		assert.ok(loader.render(80)[1].includes("a"));
		mock.timers.tick(80);
		assert.ok(loader.render(80)[1].includes("b"), "pinned 80 ms cadence must be honored verbatim");
		loader.stop();
	} finally {
		mock.timers.reset();
	}
});

test("frame-cycle semantics survive: wrap-around and verbatim custom frames", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	try {
		const loader = makeLoader({ frames: ["x", "y"], intervalMs: 500 });
		loader.start();
		assert.ok(loader.render(80)[1].includes("x"));
		mock.timers.tick(500);
		assert.ok(loader.render(80)[1].includes("y"));
		mock.timers.tick(500);
		assert.ok(loader.render(80)[1].includes("x"), "frames must wrap around");
		loader.stop();
	} finally {
		mock.timers.reset();
	}
});

test("spinner frames carry no sparkline glyphs (sparkline semantics: none by design)", () => {
	const loader = makeLoader();
	loader.start();
	const text = loader.render(80)[1];
	assert.ok(!/[▁▂▃▄▅▆▇█]/.test(text));
	loader.stop();
});

test("configureStatusLinePolicy is the extension seam and merges patches", () => {
	try {
		const before = getStatusLinePolicy();
		const after = configureStatusLinePolicy({ spinnerTickMs: 1000 });
		assert.equal(after.spinnerTickMs, 1000);
		assert.equal(after.counterRefreshMs, before.counterRefreshMs);
	} finally {
		configureStatusLinePolicy({ ...DEFAULT_STATUS_LINE_POLICY });
	}
});

test("OnChangeCounterCache passes exact values and refreshes on change/TTL only", () => {
	let now = 0;
	const cache = new OnChangeCounterCache<number, number>(() => now);
	let computes = 0;
	const compute = (): number => {
		computes += 1;
		return 4242;
	};
	assert.equal(cache.get(1, 500, compute), 4242, "counter values must pass through verbatim");
	assert.equal(cache.get(1, 500, compute), 4242);
	assert.equal(computes, 1, "no recompute before the TTL with an unchanged key");
	now = 500;
	assert.equal(cache.get(1, 500, compute), 4242);
	assert.equal(computes, 2, "recompute at the TTL bound");
	assert.equal(cache.get(2, 500, compute), 4242);
	assert.equal(computes, 3, "recompute immediately on key change");
});
