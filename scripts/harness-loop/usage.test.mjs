import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage } from "./usage.mjs";

const W = { startInclusive: "2026-10-29T17:31:00.000Z", endExclusive: "2026-10-30T17:31:00.000Z" };
const at = (iso, extra = {}) => ({ timestamp: iso, ...extra });

test("window is start-inclusive and end-exclusive by event timestamp", () => {
	const r = summarizeUsage(
		[
			at("2026-10-29T17:30:59.999Z", { usage: { input: 1 } }), // before
			at("2026-10-29T17:31:00.000Z", { usage: { input: 2 } }), // start, included
			at("2026-10-30T17:30:59.999Z", { usage: { input: 4 } }), // last ms, included
			at("2026-10-30T17:31:00.000Z", { usage: { input: 8 } }), // end, excluded
		],
		W,
	);
	assert.equal(r.records.inWindow, 2);
	assert.equal(r.records.outOfWindow, 2);
	assert.equal(r.fields.input.total, 6);
});

test("Date and epoch-ms bounds are accepted and equal to ISO bounds", () => {
	const entries = [at("2026-10-29T18:00:00.000Z", { usage: { output: 3 } })];
	const a = summarizeUsage(entries, W);
	const b = summarizeUsage(entries, {
		startInclusive: new Date(W.startInclusive),
		endExclusive: Date.parse(W.endExclusive),
	});
	assert.deepEqual(a, b);
});

test("invalid window is rejected", () => {
	assert.throws(() => summarizeUsage([], { startInclusive: W.endExclusive, endExclusive: W.startInclusive }), RangeError);
	assert.throws(() => summarizeUsage([], { startInclusive: "nope", endExclusive: W.endExclusive }), RangeError);
	assert.throws(() => summarizeUsage({}, W), TypeError);
});

test("missing usage is counted, not treated as zero tokens", () => {
	const r = summarizeUsage([at("2026-10-30T00:00:00.000Z"), at("2026-10-30T01:00:00.000Z", { usage: { input: 5 } })], W);
	assert.equal(r.records.withoutUsage, 1);
	assert.equal(r.records.withUsage, 1);
	assert.equal(r.fields.input.present, 1);
	assert.equal(r.fields.output.present, 0);
	assert.equal(r.fields.output.total, 0);
});

test("reasoning is separate and never added to output or totalTokens", () => {
	const r = summarizeUsage(
		[at("2026-10-30T00:00:00.000Z", { usage: { output: 10, reasoning: 7, totalTokens: 10 } })],
		W,
	);
	assert.equal(r.fields.output.total, 10);
	assert.equal(r.fields.reasoning.total, 7);
	assert.equal(r.fields.totalTokens.total, 10); // reported as provided
});

test("provider overlap: cache fields are summed as provided, not recomputed", () => {
	const r = summarizeUsage(
		[at("2026-10-30T00:00:00.000Z", { usage: { input: 100, cacheRead: 900, cacheWrite: 50, cacheWrite1h: 0, totalTokens: 1050 } })],
		W,
	);
	assert.equal(r.fields.cacheRead.total, 900);
	assert.equal(r.fields.cacheWrite1h.present, 1);
	assert.equal(r.fields.totalTokens.total, 1050);
});

test("malformed values are counted, never coerced", () => {
	const r = summarizeUsage(
		[
			null,
			"text",
			[1],
			at("not-a-date", { usage: { input: 1 } }),
			at("2026-10-30T00:00:00.000Z", { usage: { input: "5", output: -1, cacheRead: Number.NaN, reasoning: 2 } }),
		],
		W,
	);
	assert.equal(r.records.malformed, 3);
	assert.equal(r.records.unknownTimestamp, 1);
	assert.equal(r.fields.input.invalid, 1);
	assert.equal(r.fields.input.present, 0);
	assert.equal(r.fields.output.invalid, 1);
	assert.equal(r.fields.cacheRead.invalid, 1);
	assert.equal(r.fields.reasoning.total, 2);
});

test("retries, outcomes and unknown attempts are counted", () => {
	const r = summarizeUsage(
		[
			at("2026-10-30T00:00:00.000Z", { attempt: 1, outcome: "error", usage: { input: 1 } }),
			at("2026-10-30T00:01:00.000Z", { attempt: 2, outcome: "success", usage: { input: 1 } }),
			at("2026-10-30T00:02:00.000Z", { outcome: "refused" }),
			at("2026-10-30T00:03:00.000Z", {}),
		],
		W,
	);
	assert.deepEqual(r.outcomes, { success: 1, error: 1, refused: 1, other: 0, unknown: 1 });
	assert.equal(r.attempts.retries, 1);
	assert.equal(r.attempts.maxAttempt, 2);
	assert.equal(r.attempts.unknownAttempt, 2);
});

test("API estimated cost is separate and does not affect token totals", () => {
	const r = summarizeUsage(
		[
			at("2026-10-30T00:00:00.000Z", { usage: { input: 1 }, cost: { total: 0.25 } }),
			at("2026-10-30T00:01:00.000Z", { usage: { input: 1 }, cost: "bad" }),
		],
		W,
	);
	assert.equal(r.apiEstimatedCost.total, 0.25);
	assert.equal(r.apiEstimatedCost.present, 1);
	assert.equal(r.apiEstimatedCost.invalid, 1);
	assert.equal(r.fields.input.total, 2);
});

test("append-stable: records after the pinned end do not change the result", () => {
	const base = [at("2026-10-30T00:00:00.000Z", { usage: { input: 3 } })];
	const before = summarizeUsage(base, W);
	const after = summarizeUsage([...base, at("2026-10-31T09:00:00.000Z", { usage: { input: 99 } })], W);
	// records.total is the supplied-input length by design; every window-scoped figure must match.
	assert.equal(after.records.total, before.records.total + 1);
	assert.equal(after.records.outOfWindow, before.records.outOfWindow + 1);
	const { total: _bt, outOfWindow: _bo, ...bRest } = before.records;
	const { total: _at, outOfWindow: _ao, ...aRest } = after.records;
	assert.deepEqual(aRest, bRest);
	assert.deepEqual(after.fields, before.fields);
	assert.deepEqual(after.outcomes, before.outcomes);
	assert.deepEqual(after.apiEstimatedCost, before.apiEstimatedCost);
});

test("input array is not mutated", () => {
	const entries = [at("2026-10-30T00:00:00.000Z", { usage: { input: 1 } })];
	const snapshot = JSON.stringify(entries);
	summarizeUsage(entries, W);
	assert.equal(JSON.stringify(entries), snapshot);
});
