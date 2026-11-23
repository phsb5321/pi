/**
 * Idle time-to-live for a worker pane (PI_PANE_TTL_MIN).
 *
 * Problem: a lead starts a worker Pi in a pane, the worker finishes, and the process then sits in
 * memory for days because nothing ends it. Example: 183 panes were idle for over a week and held
 * 16.7 GiB. Solution: the lead opts a pane in with PI_PANE_TTL_MIN=N. After N minutes of quiet time
 * the TUI writes an expiry receipt (see pane-ttl-receipt.ts) and exits 0.
 *
 * "Quiet time" is time in which nothing is happening and nobody is typing:
 *  - any terminal input or agent event resets the clock;
 *  - while the session is busy (provider call, tool, retry wait, compaction, queued prompt, bash,
 *    open dialog, draft text in the editor) the clock is held at zero, so a long tool or a 429 wait
 *    never counts as idle.
 *
 * Unset or invalid PI_PANE_TTL_MIN means no TTL: behaviour is unchanged.
 */

export const PANE_TTL_ENV = "PI_PANE_TTL_MIN";

/** How often the idle clock is checked. Short enough for a 1 minute TTL, long enough to cost nothing. */
const MAX_TICK_MS = 5_000;

export interface PaneTtlConfig {
	ttlMs: number;
	ttlMin: number;
}

export interface PaneTtlParse {
	config?: PaneTtlConfig;
	/** Set when the variable is present but unusable. The TTL stays off. */
	warning?: string;
}

/** Parse PI_PANE_TTL_MIN. A positive number of minutes (fractions allowed). Anything else disables the TTL. */
export function parsePaneTtl(env: Record<string, string | undefined>): PaneTtlParse {
	const raw = env[PANE_TTL_ENV];
	if (raw === undefined || raw.trim() === "") return {};
	const minutes = Number(raw.trim());
	if (!Number.isFinite(minutes) || minutes <= 0) {
		return { warning: `${PANE_TTL_ENV}=${JSON.stringify(raw)} is not a positive number of minutes; idle TTL is off` };
	}
	return { config: { ttlMin: minutes, ttlMs: minutes * 60_000 } };
}

/** The pieces of a session that decide whether the pane is doing work. */
export interface PaneBusySource {
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	hasPendingBashMessages: boolean;
	pendingMessageCount: number;
}

export interface PaneUiBusySource {
	/** An extension dialog (selector, input, editor) is open. */
	hasOpenDialog(): boolean;
	/** The editor holds text the user has not sent. */
	hasDraft(): boolean;
}

export function isPaneBusy(session: PaneBusySource, ui: PaneUiBusySource): boolean {
	return (
		session.isStreaming ||
		session.isCompacting ||
		session.isRetrying ||
		session.isBashRunning ||
		session.hasPendingBashMessages ||
		session.pendingMessageCount > 0 ||
		ui.hasOpenDialog() ||
		ui.hasDraft()
	);
}

export interface PaneTtlTimer {
	cancel(): void;
}

export interface PaneTtlOptions {
	ttlMs: number;
	isBusy: () => boolean;
	onExpire: (idleMs: number) => void;
	/** Injected for tests. Defaults to Date.now. */
	now?: () => number;
	/** Injected for tests. Defaults to an unref'd setInterval. */
	schedule?: (tick: () => void, everyMs: number) => PaneTtlTimer;
}

export class PaneTtl {
	private readonly ttlMs: number;
	private readonly isBusy: () => boolean;
	private readonly onExpire: (idleMs: number) => void;
	private readonly now: () => number;
	private readonly schedule: (tick: () => void, everyMs: number) => PaneTtlTimer;
	private lastActivityAt = 0;
	private timer: PaneTtlTimer | undefined;
	private expired = false;

	constructor(options: PaneTtlOptions) {
		this.ttlMs = options.ttlMs;
		this.isBusy = options.isBusy;
		this.onExpire = options.onExpire;
		this.now = options.now ?? Date.now;
		this.schedule =
			options.schedule ??
			((tick, everyMs) => {
				const handle = setInterval(tick, everyMs);
				// The TTL timer must never keep a process alive on its own.
				handle.unref();
				return { cancel: () => clearInterval(handle) };
			});
	}

	start(): void {
		if (this.timer) return;
		this.lastActivityAt = this.now();
		this.timer = this.schedule(() => this.tick(), Math.min(MAX_TICK_MS, Math.max(1, this.ttlMs / 4)));
	}

	/** Terminal input or an agent event: restart the quiet-time clock. */
	touch(): void {
		this.lastActivityAt = this.now();
	}

	stop(): void {
		this.timer?.cancel();
		this.timer = undefined;
	}

	/** Public so tests and the interval share one code path. */
	tick(): void {
		if (this.expired) return;
		const now = this.now();
		if (this.isBusy()) {
			this.lastActivityAt = now;
			return;
		}
		const idleMs = now - this.lastActivityAt;
		if (idleMs < this.ttlMs) return;
		this.expired = true;
		this.stop();
		this.onExpire(idleMs);
	}
}
