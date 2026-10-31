// Pilot host grader (harness-loop battery v0, grader v1). Host-side assertions only.
// Replaces the status-only T2 check, which passed a candidate that called process.exit(0) before any case.
// - The candidate runs in pilot-eval-child.mjs inside QuickJS; the child never sees expected values.
// - The host compares every returned value with the held-out case. Exit status and worker claims decide nothing.
// - Missing, extra, malformed or errored results fail closed.
// - gradeTrialRecord fails closed when per-request usage, worker outputs or the outcome are missing.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "pilot-eval-child.mjs");
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];

/** Evaluates a candidate range.mjs on inputs only. Returns {results} or {reason}. Never returns a verdict. */
export function evaluateRangeCandidate(src, inputs) {
	if (typeof src !== "string") return { reason: "no range.mjs" };
	const run = spawnSync(process.execPath, [CHILD], {
		input: JSON.stringify({ src, inputs }),
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 1 << 20,
		env: {},
	});
	const lines = (run.stdout ?? "").trim().split("\n").filter(Boolean);
	if (lines.length !== 1) return { reason: `evaluator produced ${lines.length} result lines (exit ${run.status})` };
	let out;
	try {
		out = JSON.parse(lines[0]);
	} catch {
		return { reason: "evaluator output is not JSON" };
	}
	if (out?.schema !== "pilot-eval-v1") return { reason: "evaluator output has wrong schema" };
	if (typeof out.rejected === "string") return { reason: `candidate rejected: ${out.rejected}` };
	if (!Array.isArray(out.results) || out.results.length !== inputs.length) {
		return { reason: `missing results: got ${Array.isArray(out.results) ? out.results.length : "none"} of ${inputs.length}` };
	}
	return { results: out.results };
}

/** Host assertions over held-out cases [[a, b, want], ...]. Returns failure reasons; empty means pass. */
export function gradeRangeCandidate(src, cases) {
	const evaluated = evaluateRangeCandidate(src, cases.map(([a, b]) => [a, b]));
	if (!evaluated.results) return [evaluated.reason];
	const bad = [];
	cases.forEach(([a, b, want], i) => {
		const r = evaluated.results[i];
		if (r?.ok !== true) bad.push([a, b, want, `error: ${r?.error ?? "malformed"}`]);
		else if (r.value !== want) bad.push([a, b, want, r.value]);
	});
	return bad.length ? [`held-out cases failed: ${JSON.stringify(bad).slice(0, 200)}`] : [];
}

/**
 * Host dispatch journal vs persisted request records, exact ID-set reconciliation for one trial.
 * journal: {trialId, sealed, policy: {autoRetry, providerMaxRetries, cacheWarming}, dispatches: [{id, trialId, attempt}]},
 * appended by the host BEFORE each provider invocation and sealed only after cancellation drain.
 * Each request record names its dispatchId/trialId and a terminal state. Assistant messages and driver
 * attempts are not a request census: only the journal defines the expected set.
 */
export function reconcileDispatches(record) {
	const j = record?.journal;
	if (!j || !Array.isArray(j.dispatches)) return ["no dispatch journal"];
	const reasons = [];
	const trialId = record.trialId;
	if (typeof trialId !== "string" || trialId === "" || j.trialId !== trialId) reasons.push("journal trial id mismatch");
	if (j.sealed !== true) reasons.push("journal not sealed: late tails possible");
	// One journal entry must be one physical request: transport/agent retries and cache warming are invisible
	// to a pre-dispatch hook that fires once per logical request, so they must be proven off.
	const p = j.policy;
	if (p?.autoRetry !== false || p?.providerMaxRetries !== 0 || p?.cacheWarming !== "off") {
		reasons.push("retries/cache warming not proven disabled: physical attempts uncountable");
	}
	const expected = new Map();
	for (const d of j.dispatches) {
		if (typeof d?.id !== "string" || d.id === "") reasons.push("dispatch without id");
		else if (expected.has(d.id)) reasons.push(`duplicate dispatch ${d.id}`);
		else expected.set(d.id, d);
		if (d?.trialId !== trialId) reasons.push(`dispatch ${d?.id}: cross-trial`);
	}
	const seen = new Set();
	for (const r of record.requests ?? []) {
		const id = r?.dispatchId;
		if (seen.has(id)) reasons.push(`duplicate record ${id}`);
		seen.add(id);
		const d = expected.get(id);
		if (!d) reasons.push(`orphan record ${id}`);
		else if (d.attempt !== r.attempt) reasons.push(`record ${id}: attempt differs from journal`);
		if (r?.trialId !== trialId) reasons.push(`record ${id}: cross-trial`);
		if (r?.terminal !== "completed") {
			reasons.push(
				r?.terminal === "failed" || r?.terminal === "cancelled"
					? `record ${id}: ${r.terminal}`
					: `record ${id}: nonterminal`,
			);
		}
	}
	for (const id of expected.keys()) if (!seen.has(id)) reasons.push(`missing record for dispatch ${id}`);
	return reasons;
}

/**
 * Fails closed on an incomplete trial record before grading its outcome.
 * record: {task, attempts, outcome, requests: [{attempt, usageRaw, output}]}; gradeTrial is the pinned battery grader.
 */
export function gradeTrialRecord(record, gradeTrial, manifest) {
	const reasons = [];
	const requests = record?.requests;
	if (!Array.isArray(requests) || requests.length === 0) reasons.push("no request records");
	else {
		// One driver attempt may span several provider requests (tool turns). Each request names its attempt;
		// every attempt 1..attempts needs at least one request, and no request may name another attempt.
		const seen = new Set(requests.map((r) => r?.attempt));
		for (let a = 1; a <= record.attempts; a++) if (!seen.has(a)) reasons.push(`attempt ${a}: no request record`);
		if (requests.some((r) => !Number.isInteger(r?.attempt) || r.attempt < 1 || r.attempt > record.attempts)) {
			reasons.push("request with missing or out-of-range attempt");
		}
		requests.forEach((r, i) => {
			const u = r?.usageRaw;
			const missing = USAGE_FIELDS.filter((f) => !Number.isFinite(u?.[f]));
			if (missing.length) reasons.push(`request ${i + 1}: usage missing ${missing.join(",")}`);
			if (typeof r?.output !== "string") reasons.push(`request ${i + 1}: worker output not persisted`);
		});
	}
	reasons.push(...reconcileDispatches(record));
	if (record?.outcome === undefined || record?.outcome === null) reasons.push("no outcome");
	if (reasons.length) return { outcomePass: false, reasons, complete: false };
	const graded = gradeTrial({ task: record.task, attempts: record.attempts, outcome: record.outcome, claim: record.claim }, manifest);
	return { ...graded, complete: true };
}
