import type { LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";

/**
 * Status-line animation policy (the P2/P6 throttling contract).
 *
 * Contract (pinned in test/status-line-animation.test.ts):
 *   - idle => zero animation: no tick is ever scheduled while no busy
 *     indicator is started (Loader.stop() is the only exit; no idle timer);
 *   - active => frames are few, values are never delayed: the spinner glyph
 *     advances at `frameIntervalMs` while status text, counters and sparkline
 *     readouts update the moment their data changes (repaint on change, not on
 *     tick);
 *   - no information loss: every value shown at the old rate is shown at the
 *     new one.
 *
 * The spinner frames live here so the animation has exactly one owner
 * (frames + rate + policy); `Loader`'s own defaults stay untouched for other
 * consumers, and frames still render through each indicator's spinner color
 * function (renderVerbatim: false), so dynamic themes keep working. Passing an
 * explicit `WorkingIndicatorOptions` (the existing extension seam) remains
 * authoritative over this policy.
 */

/** Braille spinner cycle — the animation's only frame table. */
export const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface StatusAnimationPolicy {
	/** Spinner glyph advance interval while a busy indicator is active. */
	readonly frameIntervalMs: number;
}

/**
 * P2 variant: 2 Hz spinner (a calm 5 s rotation). The generic Loader default
 * is the tui status-line policy cadence (`spinnerTickMs`, 500 ms since #18), so
 * this value is equal to it by default, but it is owned here and stays put if
 * that seam is reconfigured. Measured against the P5-ANIM lineage before
 * landing (specs/1942-statusline-anim/evidence/).
 */
export const DEFAULT_STATUS_ANIMATION_POLICY: StatusAnimationPolicy = {
	frameIntervalMs: 500,
};

/**
 * Spinner options for one indicator kind: policy frames rendered through the
 * indicator's own spinner color function (byte-identical rendering to the
 * Loader default path) at the policy rate, unless the caller or an extension
 * overrides them.
 */
export function resolveWorkingIndicatorOptions(
	overrides?: WorkingIndicatorOptions,
	policy: StatusAnimationPolicy = DEFAULT_STATUS_ANIMATION_POLICY,
): LoaderIndicatorOptions {
	return {
		frames: overrides?.frames ?? STATUS_SPINNER_FRAMES,
		intervalMs: overrides?.intervalMs ?? policy.frameIntervalMs,
		renderVerbatim: false,
	};
}
