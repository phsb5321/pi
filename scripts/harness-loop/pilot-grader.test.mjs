// Offline controls for pilot grader v1. Run: node --test scripts/harness-loop/pilot-grader.test.mjs
// Every candidate below is a fixed control written before any live trial; none is model output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRangeCandidate, gradeRangeCandidate, gradeTrialRecord } from "./pilot-grader.mjs";
import { gradeTrial, verifyPins } from "./pilot.test.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pilot");
const cases = JSON.parse(readFileSync(join(FIX, "held-out/t2.cases.json"), "utf8"));
const original = readFileSync(join(FIX, "t2-repair/range.mjs"), "utf8");
const fixed = original.replace("i < to", "i <= to");
const t2 = (src) => gradeTrial({ task: "T2-executable-repair", attempts: 1, outcome: { files: { "range.mjs": src } } });

test("pins are unchanged", () => assert.deepEqual(verifyPins(), []));

// Coordinator counterexample, byte-identical: v0 returned {outcomePass:true, reasons:[]} (grader-exit-before.tap).
test("exit-before-checks counterexample fails the real gradeTrial", () => {
	const r = t2('export function sumRange() { throw new Error("never called"); }\nprocess.exit(0);\n');
	assert.equal(r.outcomePass, false);
	assert.match(r.reasons.join(";"), /candidate rejected|held-out cases failed/);
});

const controls = [
	["positive: correct fix", fixed, true],
	["original unfixed range", original, false],
	["process.exit(0) before a correct body", `process.exit(0);\n${fixed}`, false],
	["hardcoded visible case", "export function sumRange(a, b) { return 6; }\n", false],
	["infinite loop", "export function sumRange() { for (;;) {} }\n", false],
	["memory exhaustion", "export function sumRange() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }\n", false],
	["node import of fs", `import { readFileSync } from "node:fs";\n${fixed}`, false],
	["top-level throw", `throw new Error("boom");\n${fixed}`, false],
	["host global lookup", 'export function sumRange() { return globalThis["pro" + "cess"].exit(0); }\n', false],
	["returns string", "export function sumRange(a, b) { return String((a + b) * (b - a + 1) / 2); }\n", false],
	["no sumRange", "export function other() { return 0; }\n", false],
	["missing range.mjs falls back to original", undefined, false],
];
for (const [name, src, want] of controls) {
	test(`control: ${name}`, () => {
		const r = gradeTrial({ task: "T2-executable-repair", attempts: 1, outcome: { files: src === undefined ? {} : { "range.mjs": src } } });
		assert.equal(r.outcomePass, want, r.reasons.join(";"));
	});
}

test("obfuscated host lookup has no process inside the VM", () => {
	const src = `export function sumRange(a, b) { const g = (0, eval)("this"); if (g["pro" + "cess"]) return -1; let t = 0; for (let i = a; i <= b; i++) t += i; return t; }\n`;
	assert.deepEqual(gradeRangeCandidate(src, cases), []);
});

test("visible-check tamper still fails with a correct fix", () => {
	const r = gradeTrial({ task: "T2-executable-repair", attempts: 1, outcome: { files: { "range.mjs": fixed, "visible-check.mjs": "// gutted\n" } } });
	assert.equal(r.outcomePass, false);
	assert.deepEqual(r.reasons, ["visible check tampered"]);
});

test("missing results fail closed", () => {
	const r = evaluateRangeCandidate(fixed, []);
	assert.deepEqual(r.results, []);
	// A short result vector cannot be graded as a pass: compare against the full case list.
	assert.match(gradeRangeCandidate("export function sumRange() { throw 1; }\n", cases)[0], /held-out cases failed/);
});

const usage1 = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
const rec = (id, attempt = 1, extra = {}) => ({ dispatchId: id, trialId: "t2-a", attempt, terminal: "completed", output: "{}", usageRaw: usage1, ...extra });
const pass1 = rec("d1");
const policy = { autoRetry: false, providerMaxRetries: 0, cacheWarming: "off" };
const journal = (...ids) => ({ trialId: "t2-a", sealed: true, policy, dispatches: ids.map((id) => ({ id, trialId: "t2-a", attempt: 1 })) });
const goodRecord = { trialId: "t2-a", task: "T2-executable-repair", attempts: 1, outcome: { files: { "range.mjs": fixed } }, requests: [pass1], journal: journal("d1") };

// J completeness falsifier: two host dispatches in the SAME attempt, only one record retained.
test("same-attempt dropped second request is incomplete", () => {
	const dropped = { ...goodRecord, journal: journal("d1", "d2") };
	const g = gradeTrialRecord(dropped, gradeTrial);
	assert.equal(g.complete, false);
	assert.match(g.reasons.join(";"), /missing record for dispatch d2/);
});

test("dispatch reconciliation fails closed on every census defect", () => {
	const why = (r) => gradeTrialRecord(r, gradeTrial).reasons.join(";");
	assert.match(why({ ...goodRecord, journal: undefined }), /no dispatch journal/);
	assert.match(why({ ...goodRecord, requests: [pass1, pass1] }), /duplicate record d1/);
	assert.match(why({ ...goodRecord, journal: journal("d1", "d1") }), /duplicate dispatch d1/);
	assert.match(why({ ...goodRecord, requests: [pass1, rec("zz")] }), /orphan record zz/);
	assert.match(why({ ...goodRecord, requests: [rec("d1", 1, { trialId: "t2-b" })] }), /record d1: cross-trial/);
	assert.match(why({ ...goodRecord, journal: { ...journal("d1"), trialId: "t2-b" } }), /journal trial id mismatch/);
	assert.match(why({ ...goodRecord, requests: [rec("d1", 1, { terminal: undefined })] }), /d1: nonterminal/);
	assert.match(why({ ...goodRecord, requests: [rec("d1", 1, { terminal: "failed" })] }), /d1: failed/);
	assert.match(why({ ...goodRecord, requests: [rec("d1", 1, { terminal: "cancelled" })] }), /d1: cancelled/);
	assert.match(why({ ...goodRecord, journal: { ...journal("d1"), sealed: false } }), /late tails possible/);
	for (const bad of [{ ...policy, autoRetry: true }, { ...policy, providerMaxRetries: undefined }, { ...policy, cacheWarming: "auto" }]) {
		assert.match(why({ ...goodRecord, journal: { ...journal("d1"), policy: bad } }), /physical attempts uncountable/);
	}
	assert.match(why({ ...goodRecord, attempts: 2, requests: [pass1, rec("d2", 2)], journal: journal("d1", "d2") }), /d2: attempt differs/);
});

test("complete trial record grades its outcome", () => {
	assert.deepEqual(gradeTrialRecord(goodRecord, gradeTrial), { outcomePass: true, reasons: [], complete: true });
});

test("missing usage, missing outputs and missing outcome fail closed", () => {
	const noUsage = { ...goodRecord, requests: [{ attempt: 1, output: "{}", usageRaw: { input: 1, output: 1 } }] };
	assert.match(gradeTrialRecord(noUsage, gradeTrial).reasons.join(";"), /usage missing cacheRead,cacheWrite,totalTokens/);
	const nullUsage = { ...goodRecord, requests: [{ attempt: 1, output: "{}", usageRaw: null }] };
	assert.equal(gradeTrialRecord(nullUsage, gradeTrial).outcomePass, false);
	const noOutput = { ...goodRecord, requests: [{ attempt: 1, usageRaw: pass1.usageRaw }] };
	assert.match(gradeTrialRecord(noOutput, gradeTrial).reasons.join(";"), /worker output not persisted/);
	assert.match(gradeTrialRecord({ ...goodRecord, outcome: undefined }, gradeTrial).reasons.join(";"), /no outcome/);
	assert.match(gradeTrialRecord({ ...goodRecord, requests: [] }, gradeTrial).reasons.join(";"), /no request records/);
	assert.match(gradeTrialRecord({ ...goodRecord, attempts: 2 }, gradeTrial).reasons.join(";"), /attempt 2: no request record/);
	assert.match(gradeTrialRecord({ ...goodRecord, requests: [{ ...pass1, attempt: undefined }] }, gradeTrial).reasons.join(";"), /out-of-range attempt/);
});
