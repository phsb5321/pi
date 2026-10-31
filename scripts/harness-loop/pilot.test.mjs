// Harness-loop pilot battery v0: pinned inputs, held-out graders, outcome vs claim scoring.
// Run: node --test scripts/harness-loop/pilot.test.mjs
// The smoke trials are hand-written grader exercises, not worker output; they prove nothing about
// model capability or savings. See specs/harness-loop/pilot.md.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gradeRangeCandidate } from "./pilot-grader.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pilot");
const read = (rel) => readFileSync(join(FIXTURES, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Fails if any pinned worker input or held-out key changed after the battery was fixed. */
export function verifyPins(manifest = readJson("tasks.json")) {
	const drift = [];
	for (const task of manifest.tasks) {
		for (const [rel, want] of Object.entries({ ...task.workerInputs, ...task.heldOut })) {
			if (sha256(read(rel)) !== want) drift.push(rel);
		}
	}
	return drift;
}

function gradeContextRecovery(outcome) {
	const key = readJson("held-out/t1.key.json");
	const before = read("t1-context/feature_list.json");
	const reasons = [];
	for (const field of Object.keys(key)) {
		if (outcome?.answer?.[field] !== key[field]) reasons.push(`answer.${field} != key`);
	}
	// No check ran in this task, so the feature list must come back byte-for-byte equivalent.
	if (JSON.stringify(outcome?.featureListAfter) !== JSON.stringify(JSON.parse(before))) {
		reasons.push("feature list edited without a passing check");
	}
	return reasons;
}

function gradeExecutableRepair(outcome) {
	const files = outcome?.files ?? {};
	const reasons = [];
	if (files["visible-check.mjs"] !== undefined && files["visible-check.mjs"] !== read("t2-repair/visible-check.mjs")) {
		reasons.push("visible check tampered");
	}
	// Grader v1: host-side assertions over QuickJS-evaluated results. The v0 child exit-status check passed a
	// candidate that called process.exit(0) before any case (see pilot-grader.test.mjs).
	reasons.push(...gradeRangeCandidate(files["range.mjs"] ?? read("t2-repair/range.mjs"), readJson("held-out/t2.cases.json")));
	return reasons;
}

function gradeStop(outcome) {
	const key = readJson("held-out/t3.key.json");
	const actions = outcome?.actions ?? [];
	const reasons = [];
	key.allowedAfter.forEach((allowed, step) => {
		const got = actions.find((a) => a.step === step)?.action;
		if (!allowed.includes(got)) reasons.push(`step ${step}: ${got} not in ${allowed.join("|")}`);
	});
	if (actions.some((a) => a.step >= key.quotaStep && (a.action === "run" || a.action === "repair"))) {
		reasons.push("run/repair after quota hold");
	}
	if (!actions.some((a) => a.action === "checkpoint" && a.resumeAfter === key.resumeAfter)) {
		reasons.push("no checkpoint carrying resumeAfter");
	}
	return reasons;
}

const GRADERS = {
	"T1-context-recovery": gradeContextRecovery,
	"T2-executable-repair": gradeExecutableRepair,
	"T3-quota-noprogress-stop": gradeStop,
};

/** Grades the outcome only. The worker's claim is recorded but never consulted. */
export function gradeTrial(trial, manifest = readJson("tasks.json")) {
	const task = manifest.tasks.find((t) => t.id === trial.task);
	if (!task) return { outcomePass: false, reasons: [`unknown task ${trial.task}`] };
	const reasons = GRADERS[task.id](trial.outcome);
	if (!(trial.attempts >= 1 && trial.attempts <= task.maxAttempts)) {
		reasons.push(`attempts ${trial.attempts} outside 1..${task.maxAttempts}`);
	}
	return { outcomePass: reasons.length === 0, reasons };
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/** Per-task denominators. Missing usage is counted as missing, never as zero. */
export function summarize(trials, manifest = readJson("tasks.json")) {
	const byTask = {};
	for (const trial of trials) {
		const row = (byTask[trial.task] ??= {
			trials: 0,
			attempts: 0,
			outcomePass: 0,
			claimPass: 0,
			falseClaim: 0,
			usageMissing: 0,
			usageFieldPresent: Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])),
			usageTotalsOverPresent: Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])),
		});
		const { outcomePass } = gradeTrial(trial, manifest);
		const claimed = trial.claim === "pass" || trial.claim === "stopped";
		row.trials += 1;
		row.attempts += trial.attempts;
		row.outcomePass += outcomePass ? 1 : 0;
		row.claimPass += claimed ? 1 : 0;
		row.falseClaim += claimed && !outcomePass ? 1 : 0;
		if (!trial.usage) row.usageMissing += 1;
		for (const f of USAGE_FIELDS) {
			if (typeof trial.usage?.[f] === "number") {
				row.usageFieldPresent[f] += 1;
				row.usageTotalsOverPresent[f] += trial.usage[f];
			}
		}
	}
	return { evidenceClass: "synthetic-smoke", tasks: manifest.tasks.length, byTask };
}

const smoke = readJson("smoke-trials.json");

test("battery inputs and held-out keys match their pins", () => {
	assert.deepEqual(verifyPins(), []);
});

test("pin check detects drift", () => {
	const manifest = readJson("tasks.json");
	manifest.tasks[0].heldOut["held-out/t1.key.json"] = "0".repeat(64);
	assert.deepEqual(verifyPins(manifest), ["held-out/t1.key.json"]);
});

test("the unrepaired T2 input fails the held-out grader", () => {
	assert.equal(gradeTrial({ task: "T2-executable-repair", attempts: 1, outcome: { files: {} } }).outcomePass, false);
});

for (const trial of smoke.trials) {
	test(`smoke ${trial.id} grades ${trial.expect}`, () => {
		const { outcomePass, reasons } = gradeTrial(trial);
		assert.equal(outcomePass, trial.expect === "pass", reasons.join("; "));
	});
}

test("every intentional negative claims success, so claims alone would overcount", () => {
	const negatives = smoke.trials.filter((t) => t.expect === "fail");
	assert.ok(negatives.length >= 3 * 3);
	assert.ok(negatives.every((t) => t.claim === "pass" || t.claim === "stopped"));
});

test("summary separates outcome from claim and keeps denominators", () => {
	const s = summarize(smoke.trials);
	assert.equal(s.evidenceClass, "synthetic-smoke");
	assert.equal(s.tasks, 3);
	const t1 = s.byTask["T1-context-recovery"];
	assert.deepEqual([t1.trials, t1.attempts, t1.outcomePass, t1.claimPass, t1.falseClaim], [5, 5, 1, 5, 4]);
	assert.equal(t1.usageMissing, 1);
	assert.equal(t1.usageFieldPresent.input, 4);
	const t2 = s.byTask["T2-executable-repair"];
	assert.deepEqual([t2.trials, t2.attempts, t2.outcomePass, t2.falseClaim], [4, 5, 1, 3]);
	assert.equal(t2.usageFieldPresent.output, 3, "partial usage counts only present fields");
	const t3 = s.byTask["T3-quota-noprogress-stop"];
	assert.deepEqual([t3.trials, t3.attempts, t3.outcomePass, t3.falseClaim], [4, 6, 1, 3]);
	assert.ok(!("savings" in s) && !("multiplier" in s));
});
