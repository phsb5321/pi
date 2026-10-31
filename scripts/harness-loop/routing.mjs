// Harness loop: worker availability and stop decision.
//
// Pure functions only. No file read, network, probe or process launch at import.
// The signal authority is the existing throttle-lanes snapshot
// (`$XDG_RUNTIME_DIR/throttle-lanes.json`, schema 1, written by
// modules/home/throttle-lanes.nix) plus the gateway's per-bearer health block,
// which the caller passes in as data. This module keeps no cache of its own.
//
// Fail-closed rule: anything not positively runnable is a hold, unknown or stale.
// A hold is never converted into a run by a retry.

const SCHEMA = 1;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

// Epoch values arrive in seconds (throttle-lanes resetsAt, gateway reset) or ms.
const toMs = (value) => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
};

const parseTimeMs = (value) => {
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}
	return toMs(value);
};

const hold = (lane, holdKind, reason, resetsAtMs) => ({
	lane,
	state: "hold",
	holdKind,
	reason,
	resetsAtMs: resetsAtMs ?? null,
});

const unknown = (lane, reason) => ({ lane, state: "unknown", holdKind: null, reason, resetsAtMs: null });

const runnable = (lane, reason) => ({ lane, state: "runnable", holdKind: null, reason, resetsAtMs: null });

const freshnessFail = (snapshot, sampledMs, nowMs) => {
	const interval = snapshot.intervalSeconds;
	if (!Number.isFinite(interval) || interval <= 0) return "no intervalSeconds in snapshot";
	if (sampledMs === null) return "no sample time";
	if (sampledMs - nowMs > 60_000) return "sample time is in the future";
	if (nowMs - sampledMs > 2 * interval * 1000) return "stale sample (older than 2x interval)";
	return null;
};

// One Anthropic bearer from the gateway health block (`bearers.<id>`), data only.
// Usable only on positive evidence: fresh unified allowed, no latch, valid credential.
const classifyBearer = (bearer, nowMs, intervalSeconds) => {
	if (!isObject(bearer)) return { usable: false, state: "unknown", reason: "malformed bearer" };
	const credential = bearer.credential;
	if (isObject(credential) && credential.ok === false) {
		return { usable: false, state: "auth", reason: `credential not ok: ${credential.reason ?? "unspecified"}` };
	}
	const latchUntil = toMs(bearer.retryAfterUntil ?? bearer.retry_after_until);
	if (bearer.retryProbeBlocksRouting === true || bearer.retry_probe_blocks_routing === true) {
		return { usable: false, state: "hold", holdKind: "quota", resetsAtMs: latchUntil, reason: "latched retry probe" };
	}
	if (latchUntil !== null && latchUntil > nowMs) {
		return { usable: false, state: "hold", holdKind: "quota", resetsAtMs: latchUntil, reason: "retry-after window open" };
	}
	const unified = bearer.unified;
	if (!isObject(unified)) return { usable: false, state: "unknown", reason: "no unified rate-limit reading" };
	const unifiedAt = parseTimeMs(bearer.unifiedAt ?? bearer.unified_at);
	const stale = freshnessFail({ intervalSeconds }, unifiedAt, nowMs);
	if (stale) return { usable: false, state: "unknown", reason: `unified reading: ${stale}` };
	if (unified.status !== "allowed") {
		return { usable: false, state: "hold", holdKind: "quota", resetsAtMs: toMs(unified.reset), reason: "unified status not allowed" };
	}
	return { usable: true, state: "runnable", reason: "unified allowed, fresh, no latch" };
};

// Aggregate bearers for one lane: ANY usable bearer makes the lane runnable.
// Held or unknown siblings do not erase a usable one.
const aggregateBearers = (lane, bearers, nowMs, intervalSeconds) => {
	if (!Array.isArray(bearers) || bearers.length === 0) return unknown(lane, "no bearer health supplied");
	const verdicts = bearers.map((bearer) => classifyBearer(bearer, nowMs, intervalSeconds));
	const usableCount = verdicts.filter((v) => v.usable).length;
	if (usableCount > 0) return runnable(lane, `${usableCount} of ${verdicts.length} bearers usable`);
	const quota = verdicts.filter((v) => v.state === "hold" && v.holdKind === "quota");
	if (quota.length > 0) {
		const resets = quota.map((v) => v.resetsAtMs).filter((v) => v !== null);
		return hold(lane, "quota", "no usable bearer; all held by quota or latch", resets.length ? Math.min(...resets) : null);
	}
	if (verdicts.some((v) => v.state === "auth")) return hold(lane, "auth", "no usable bearer; credential refused", null);
	return unknown(lane, "no usable bearer and no positive hold");
};

// Meter rule for codex-style lanes: every meter must be readable; any at or over 100% is a quota hold.
const classifyMeters = (lane, meters, nowMs) => {
	if (!Array.isArray(meters) || meters.length === 0) return unknown(lane, "no meters published");
	let resetMin = null;
	for (const meter of meters) {
		if (!isObject(meter) || typeof meter.usedPercent !== "number" || !Number.isFinite(meter.usedPercent)) {
			return unknown(lane, "meter unreadable (usedPercent not a number)");
		}
		if (meter.usedPercent >= 100) {
			const reset = toMs(meter.resetsAt);
			if (reset !== null && (resetMin === null || reset < resetMin)) resetMin = reset;
			if (reset !== null && reset <= nowMs) return unknown(lane, "exhausted meter with a past reset; not trusted");
		}
	}
	const exhausted = meters.some((m) => m.usedPercent >= 100);
	if (exhausted) return hold(lane, "quota", "meter at or over 100%", resetMin);
	return runnable(lane, "all meters readable and under 100%");
};

/**
 * Normalize one lane's availability from the existing throttle-lanes snapshot.
 *
 * @param {object} snapshot throttle-lanes.json (schema 1), as read by the caller
 * @param {string} laneId e.g. "codex:a", "zai:plan", "anthropic:proxy"
 * @param {{nowMs: number, bearers?: object[]}} options nowMs is epoch ms; bearers is the gateway
 *   `bearers` list (data only, from `/__throttle/health`) and is used only for anthropic lanes.
 * @returns {{lane: string, state: "runnable"|"hold"|"unknown", holdKind: string|null, reason: string, resetsAtMs: number|null}}
 */
export const normalizeLaneSignal = (snapshot, laneId, options) => {
	const nowMs = options?.nowMs;
	if (typeof laneId !== "string" || !Number.isFinite(nowMs)) return unknown(String(laneId), "invalid input");
	if (!isObject(snapshot) || snapshot.schema !== SCHEMA || !Array.isArray(snapshot.lanes)) {
		return unknown(laneId, "snapshot missing or schema is not 1");
	}
	const generatedMs = parseTimeMs(snapshot.generatedAt);
	const generalStale = freshnessFail(snapshot, generatedMs, nowMs);
	if (generalStale) return unknown(laneId, `snapshot: ${generalStale}`);

	const lane = snapshot.lanes.find((entry) => isObject(entry) && entry.id === laneId);
	if (!lane) return unknown(laneId, "lane absent from snapshot");

	if (laneId.startsWith("anthropic:")) {
		// The snapshot marks anthropic as delegated; only the gateway bearer block decides.
		return aggregateBearers(laneId, options?.bearers, nowMs, snapshot.intervalSeconds);
	}

	const sampledMs = parseTimeMs(lane.sampledAt) ?? generatedMs;
	const laneStale = freshnessFail(snapshot, sampledMs, nowMs);
	if (laneStale) return unknown(laneId, `lane: ${laneStale}`);

	switch (lane.status) {
		case "ok":
			if (lane.kind === "codex" || lane.kind === "zai") return classifyMeters(laneId, lane.meters, nowMs);
			return unknown(laneId, `no meter mapping for ok lane kind ${String(lane.kind)}`);
		case "refused":
			// Provider refusal (for example no active plan) is a billing/entitlement hold: no retries.
			return hold(laneId, "billing", typeof lane.reason === "string" ? lane.reason : "refused", null);
		case "unknown":
			return unknown(laneId, typeof lane.reason === "string" ? lane.reason : "lane unknown");
		default:
			return unknown(laneId, `unrecognized status ${String(lane.status)}`);
	}
};

/**
 * Decide the next worker action. Pure.
 *
 * @param {{signals: object, attempt: number, maxAttempts: number, deadlineExceeded: boolean,
 *   lastFailure: null|{kind: "executable"|"transient"|"quota"|"billing"|"unknown"}, progressChanged: boolean}} input
 *   signals: output of normalizeLaneSignal. attempt = attempts already made.
 * @returns {{action: "run"|"repair"|"checkpoint"|"escalate"|"stop", reason: string}}
 */
export const chooseWorkerAction = (input) => {
	const { signals, attempt, maxAttempts, deadlineExceeded, lastFailure, progressChanged } = input ?? {};
	if (!isObject(signals) || !isCount(attempt) || !isCount(maxAttempts) || maxAttempts < 1 || typeof deadlineExceeded !== "boolean" || typeof progressChanged !== "boolean") {
		return { action: "stop", reason: "invalid input: stopping rather than guessing" };
	}
	if (lastFailure !== null && (!isObject(lastFailure) || !["executable", "transient", "quota", "billing", "unknown"].includes(lastFailure.kind))) {
		return { action: "stop", reason: "invalid lastFailure: stopping rather than guessing" };
	}

	// 1. Availability first. A hold never yields run or repair, whatever attempt count remains.
	if (signals.state === "hold") {
		if (signals.holdKind === "billing" || signals.holdKind === "auth") {
			return { action: "stop", reason: `${signals.holdKind} hold on ${signals.lane}: zero retries` };
		}
		return { action: "checkpoint", reason: `quota hold on ${signals.lane}: checkpoint, zero retries` };
	}
	if (signals.state !== "runnable") {
		return { action: "checkpoint", reason: `signal not runnable (${signals.reason}): fail closed` };
	}

	// A failure that says quota or billing overrides a stale "runnable" reading.
	if (lastFailure && (lastFailure.kind === "quota" || lastFailure.kind === "billing")) {
		return { action: "checkpoint", reason: `${lastFailure.kind} failure while signal reads runnable: checkpoint, zero retries` };
	}

	// 2. Hard bounds.
	if (deadlineExceeded) return { action: "stop", reason: "deadline exceeded" };
	if (attempt >= maxAttempts) return { action: "stop", reason: `max attempts reached (${attempt}/${maxAttempts})` };

	// 3. First attempt, or no failure to learn from.
	if (lastFailure === null) return { action: "run", reason: "no prior failure" };

	// 4. Failure handling.
	if (lastFailure.kind === "transient") return { action: "run", reason: "transient failure: one more attempt inside budget" };
	if (lastFailure.kind === "unknown") return { action: "escalate", reason: "unclassified failure: escalate once" };

	// Deterministic executable failure: repair only while progress is visible.
	if (!progressChanged) {
		if (attempt >= 2) return { action: "stop", reason: "repeated no-progress executable failure" };
		return { action: "escalate", reason: "executable failure with no progress since last attempt: escalate once" };
	}
	return { action: "repair", reason: "executable failure with progress: repair inside budget" };
};
