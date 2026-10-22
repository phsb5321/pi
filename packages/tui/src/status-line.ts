/**
 * Status-line policy seam (1615: P2 + P6).
 *
 * One policy point for the animated status surface so fork behavior is pinned and
 * maintainable across base bumps:
 *
 * - P2: spinner/progress tick cadence (`spinnerTickMs`, 2 Hz default — measured 80 ms
 *   default produced ~4 glyph frames/s and ~2 585 ANSI escapes per turn).
 * - P6: live-counter refresh bound (`counterRefreshMs`) — counters keep EXACT values and
 *   update on change; only their refresh cadence slows.
 *
 * Information-loss contract: this seam never changes WHAT the counters, spinner or
 * messages say — only WHEN the animated surface repaints. Note (measured finding,
 * 10/10/2026): no sparkline widget and no live token-rate figure exist in upstream or the
 * fork; the probe's rare "spark" glyphs are content block characters. The seam therefore
 * deliberately exposes no sparkline sampling.
 */
export interface StatusLinePolicy {
	/** Spinner/progress tick cadence in milliseconds (P2). */
	spinnerTickMs: number;
	/** Upper bound on live-counter staleness in milliseconds (P6). */
	counterRefreshMs: number;
}

export const DEFAULT_STATUS_LINE_POLICY: StatusLinePolicy = {
	spinnerTickMs: 500,
	counterRefreshMs: 500,
};

let policy: StatusLinePolicy = { ...DEFAULT_STATUS_LINE_POLICY };

export function getStatusLinePolicy(): StatusLinePolicy {
	return policy;
}

/** Configure the status-line cadence (extension seam). Returns the resulting policy. */
export function configureStatusLinePolicy(patch: Partial<StatusLinePolicy>): StatusLinePolicy {
	policy = { ...policy, ...patch };
	return policy;
}

/**
 * On-change counter cache with a staleness bound. Recomputes when the key moves
 * (event-driven refresh) or when the TTL expires — whichever comes first. Values come
 * back verbatim from `compute`; the cache changes WHEN counters refresh, never WHAT they
 * say (P6: slow the live refresh with zero information loss).
 */
export class OnChangeCounterCache<TKey, TValue> {
	private key: TKey | undefined;
	private value: TValue | undefined;
	private computedAt = 0;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	get(key: TKey, ttlMs: number, compute: () => TValue): TValue {
		const at = this.now();
		if (this.value === undefined || key !== this.key || at - this.computedAt >= ttlMs) {
			this.key = key;
			this.value = compute();
			this.computedAt = at;
		}
		return this.value;
	}
}
