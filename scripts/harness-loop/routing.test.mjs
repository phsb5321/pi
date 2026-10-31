import assert from "node:assert/strict";
import test from "node:test";
import { chooseWorkerAction, normalizeLaneSignal } from "./routing.mjs";

// Fixtures follow the live throttle-lanes schema (schema 1; modules/home/throttle-lanes.nix)
// and the gateway /__throttle/health bearer block. Identifiers and values are synthetic;
// no credential, account or email appears here.
const NOW = Date.parse("2026-10-30T17:30:00Z");
const EPOCH_RESET = 1793984589; // seconds, as published by the probe

const snapshot = (lanes, overrides = {}) => ({
	schema: 1,
	generatedAt: "2026-10-30T17:17:50Z",
	intervalSeconds: 900,
	registryProviders: ["codex", "zai"],
	lanes,
	...overrides,
});

const codexOk = (usedPercent = 0) => ({
	id: "codex:a",
	kind: "codex",
	status: "ok",
	sampledAt: "2026-10-30T17:17:07Z",
	meters: [{ limitId: "codex", usedPercent, resetsAt: EPOCH_RESET, windowMins: 10080 }],
});

const zaiRefused = {
	id: "zai:plan",
	kind: "zai",
	status: "refused",
	reason: "no active Z.AI coding plan on this key (provider reports none)",
	billing: { current: false, planStatus: "NONE" },
	meters: [],
};

const bearer = (overrides = {}) => ({
	credential: { ok: true },
	unified: { status: "allowed", reset: 1793398200 },
	unifiedAt: 1793381255,
	retryProbeBlocksRouting: false,
	retryAfterUntil: 0,
	...overrides,
});

const latchedBearer = {
	credential: { ok: true },
	unified: null,
	unifiedAt: 0,
	retryProbeBlocksRouting: true,
	retryAfterUntil: 1793381909,
};

const runnableCodex = normalizeLaneSignal(snapshot([codexOk()]), "codex:a", { nowMs: NOW });
const decide = (signals, extra = {}) =>
	chooseWorkerAction({
		signals,
		attempt: 0,
		maxAttempts: 3,
		deadlineExceeded: false,
		lastFailure: null,
		progressChanged: false,
		...extra,
	});

test("normalizeLaneSignal: readable meter under 100% is runnable", () => {
	assert.equal(runnableCodex.state, "runnable");
	assert.equal(decide(runnableCodex).action, "run");
});

test("explicit billing refusal stops with zero retries on every attempt and failure kind", () => {
	const signals = normalizeLaneSignal(snapshot([zaiRefused]), "zai:plan", { nowMs: NOW });
	assert.equal(signals.state, "hold");
	assert.equal(signals.holdKind, "billing");
	for (let attempt = 0; attempt < 3; attempt += 1) {
		for (const kind of [null, { kind: "executable" }, { kind: "transient" }, { kind: "unknown" }]) {
			const verdict = decide(signals, { attempt, lastFailure: kind, progressChanged: true });
			assert.equal(verdict.action, "stop", `attempt ${attempt} ${JSON.stringify(kind)}`);
		}
	}
});

test("quota hold (meter at 100%) checkpoints with zero retries and reports the reset", () => {
	const signals = normalizeLaneSignal(snapshot([codexOk(100)]), "codex:a", { nowMs: NOW });
	assert.equal(signals.state, "hold");
	assert.equal(signals.holdKind, "quota");
	assert.equal(signals.resetsAtMs, EPOCH_RESET * 1000);
	const verdict = decide(signals, { attempt: 0, lastFailure: { kind: "transient" } });
	assert.equal(verdict.action, "checkpoint");
	assert.doesNotMatch(verdict.action, /run|repair/);
});

test("a quota failure reported while the snapshot reads runnable checkpoints, not retries", () => {
	const verdict = decide(runnableCodex, { attempt: 1, lastFailure: { kind: "quota" } });
	assert.equal(verdict.action, "checkpoint");
});

test("unknown or missing lane status fails closed", () => {
	const unknownLane = { id: "codex:c", kind: "codex", status: "unknown", reason: "auth.json unreadable" };
	const signals = normalizeLaneSignal(snapshot([unknownLane]), "codex:c", { nowMs: NOW });
	assert.equal(signals.state, "unknown");
	assert.equal(decide(signals).action, "checkpoint");
	assert.equal(decide(normalizeLaneSignal(snapshot([]), "codex:z", { nowMs: NOW })).action, "checkpoint");
});

test("unreadable meter fails closed even when the other meters are fine", () => {
	const lane = { ...codexOk(), meters: [{ limitId: "codex", usedPercent: 3 }, { limitId: "other", usedPercent: null }] };
	assert.equal(normalizeLaneSignal(snapshot([lane]), "codex:a", { nowMs: NOW }).state, "unknown");
});

test("stale snapshot fails closed; wrong or missing schema fails closed", () => {
	const stale = snapshot([codexOk()], { generatedAt: "2026-10-30T16:00:00Z" });
	assert.equal(normalizeLaneSignal(stale, "codex:a", { nowMs: NOW }).state, "unknown");
	const wrongSchema = snapshot([codexOk()], { schema: 2 });
	assert.equal(normalizeLaneSignal(wrongSchema, "codex:a", { nowMs: NOW }).state, "unknown");
	const noInterval = snapshot([codexOk()], { intervalSeconds: undefined });
	assert.equal(normalizeLaneSignal(noInterval, "codex:a", { nowMs: NOW }).state, "unknown");
});

test("executable failure repairs only inside budget while progress is visible", () => {
	const failure = { kind: "executable" };
	assert.equal(decide(runnableCodex, { attempt: 1, lastFailure: failure, progressChanged: true }).action, "repair");
	assert.equal(decide(runnableCodex, { attempt: 2, lastFailure: failure, progressChanged: true }).action, "repair");
	assert.equal(decide(runnableCodex, { attempt: 3, maxAttempts: 3, lastFailure: failure, progressChanged: true }).action, "stop");
});

test("repeated no-progress executable failure escalates once, then stops", () => {
	const failure = { kind: "executable" };
	assert.equal(decide(runnableCodex, { attempt: 1, lastFailure: failure }).action, "escalate");
	assert.equal(decide(runnableCodex, { attempt: 2, lastFailure: failure }).action, "stop");
});

test("deadline and max attempts are hard stops even on a runnable lane", () => {
	assert.equal(decide(runnableCodex, { deadlineExceeded: true }).action, "stop");
	assert.equal(decide(runnableCodex, { attempt: 3, maxAttempts: 3, lastFailure: { kind: "transient" } }).action, "stop");
});

test("invalid inputs stop rather than guess", () => {
	assert.equal(chooseWorkerAction({ signals: null, attempt: 0, maxAttempts: 1, deadlineExceeded: false, lastFailure: null, progressChanged: false }).action, "stop");
	assert.equal(decide(runnableCodex, { attempt: -1 }).action, "stop");
	assert.equal(decide(runnableCodex, { lastFailure: { kind: "mystery" } }).action, "stop");
});

test("one usable bearer is not erased by another latched bearer", () => {
	const lanes = [{ id: "anthropic:proxy", kind: "anthropic", status: "delegated" }];
	const signals = normalizeLaneSignal(snapshot(lanes), "anthropic:proxy", {
		nowMs: NOW,
		bearers: [latchedBearer, bearer()],
	});
	assert.equal(signals.state, "runnable");
	assert.equal(decide(signals).action, "run");
});

test("all bearers latched or held is a quota hold with the earliest reset", () => {
	const lanes = [{ id: "anthropic:proxy", kind: "anthropic", status: "delegated" }];
	const held = bearer({ unified: { status: "rejected", reset: 1793959200 }, retryProbeBlocksRouting: false });
	const signals = normalizeLaneSignal(snapshot(lanes), "anthropic:proxy", {
		nowMs: NOW,
		bearers: [latchedBearer, held],
	});
	assert.equal(signals.state, "hold");
	assert.equal(signals.holdKind, "quota");
	assert.equal(signals.resetsAtMs, 1793381909 * 1000); // earliest reset wins
	assert.equal(decide(signals, { lastFailure: { kind: "transient" } }).action, "checkpoint");
});

test("refused bearer credential stops, and a missing bearer block fails closed", () => {
	const lanes = [{ id: "anthropic:proxy", kind: "anthropic", status: "delegated" }];
	const refused = bearer({ credential: { ok: false, reason: "oauth_not_allowed_for_organization" } });
	const auth = normalizeLaneSignal(snapshot(lanes), "anthropic:proxy", { nowMs: NOW, bearers: [refused] });
	assert.equal(auth.holdKind, "auth");
	assert.equal(decide(auth).action, "stop");
	assert.equal(normalizeLaneSignal(snapshot(lanes), "anthropic:proxy", { nowMs: NOW }).state, "unknown");
});
