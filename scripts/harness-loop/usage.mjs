// Task-scoped usage accounting for harness-loop workers.
//
// Pure function: no I/O, no network, no provider calls. Input is already-parsed
// transcript-like records. Output is data only; bodies and credentials are never
// read or returned.
//
// Accounting rules:
// - Window is half-open by event timestamp: start <= t < end. File mtime is not used.
// - Token fields are whole-request provider metadata. They are summed per field and
//   never derived from characters (no chars/4).
// - `reasoning` may already be included in `output` or `totalTokens` depending on the
//   provider, so it is reported separately and never added to any other field.
// - `totalTokens` is reported as provided, not recomputed.
// - `cost` is a provider/harness API price estimate. It is reported as
//   `apiEstimatedCost` and must not be presented as subscription spending.
// - Unknown or invalid values are counted, never coerced to zero.

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"];

/** @param {unknown} value */
function toMs(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
	if (typeof value === "string") return Date.parse(value);
	return Number.NaN;
}

/**
 * @param {unknown} entries
 * @param {{startInclusive: unknown, endExclusive: unknown}} window
 */
export function summarizeUsage(entries, window) {
	const start = toMs(window?.startInclusive);
	const end = toMs(window?.endExclusive);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
		throw new RangeError("summarizeUsage: window needs finite startInclusive < endExclusive");
	}
	if (!Array.isArray(entries)) throw new TypeError("summarizeUsage: entries must be an array");

	const records = { total: entries.length, inWindow: 0, outOfWindow: 0, unknownTimestamp: 0, malformed: 0, withUsage: 0, withoutUsage: 0 };
	const fields = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, { total: 0, present: 0, invalid: 0 }]));
	const outcomes = { success: 0, error: 0, refused: 0, other: 0, unknown: 0 };
	const attempts = { retries: 0, maxAttempt: 0, unknownAttempt: 0 };
	const apiEstimatedCost = { total: 0, present: 0, invalid: 0 };

	for (const entry of entries) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			records.malformed++;
			continue;
		}
		const t = toMs(entry.timestamp);
		if (!Number.isFinite(t)) {
			records.unknownTimestamp++;
			continue;
		}
		if (t < start || t >= end) {
			records.outOfWindow++;
			continue;
		}
		records.inWindow++;

		const outcome = typeof entry.outcome === "string" ? entry.outcome : undefined;
		if (outcome === "success") outcomes.success++;
		else if (outcome === "error") outcomes.error++;
		else if (outcome === "refused") outcomes.refused++;
		else if (outcome !== undefined) outcomes.other++;
		else outcomes.unknown++;

		if (Number.isInteger(entry.attempt) && entry.attempt >= 1) {
			attempts.maxAttempt = Math.max(attempts.maxAttempt, entry.attempt);
			if (entry.attempt > 1) attempts.retries++;
		} else {
			attempts.unknownAttempt++;
		}

		const usage = entry.usage;
		if (usage === undefined || usage === null) {
			records.withoutUsage++;
		} else if (typeof usage !== "object" || Array.isArray(usage)) {
			records.withoutUsage++;
			for (const f of TOKEN_FIELDS) fields[f].invalid++;
		} else {
			records.withUsage++;
			for (const f of TOKEN_FIELDS) {
				const v = usage[f];
				if (v === undefined) continue;
				if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
					fields[f].total += v;
					fields[f].present++;
				} else {
					fields[f].invalid++;
				}
			}
		}

		if (entry.cost !== undefined) {
			const c = typeof entry.cost === "object" && entry.cost !== null ? entry.cost.total : entry.cost;
			if (typeof c === "number" && Number.isFinite(c) && c >= 0) {
				apiEstimatedCost.total += c;
				apiEstimatedCost.present++;
			} else {
				apiEstimatedCost.invalid++;
			}
		}
	}

	return {
		window: { startInclusive: new Date(start).toISOString(), endExclusive: new Date(end).toISOString() },
		records,
		fields,
		outcomes,
		attempts,
		apiEstimatedCost,
		notes: [
			"tokens are provider metadata, not character estimates",
			"reasoning is reported separately and not added to other fields",
			"totalTokens is reported as provided",
			"apiEstimatedCost is an API price estimate, not subscription spending",
		],
	};
}
