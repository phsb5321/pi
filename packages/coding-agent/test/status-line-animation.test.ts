import type { TUI } from "@earendil-works/pi-tui";
import { Loader } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import {
	DEFAULT_STATUS_ANIMATION_POLICY,
	resolveWorkingIndicatorOptions,
	STATUS_SPINNER_FRAMES,
} from "../src/modes/interactive/status-line/animation-policy.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * Behavior pins for the status-line animation policy (P2/P6 throttling
 * contract). Must fail if any of these regress:
 *   - idle => zero animation (no timer while the indicator is stopped);
 *   - active => frames advance at the policy rate (values keep updating);
 *   - rendering stays byte-identical (spinner glyphs, colors, labels);
 *   - the extension WorkingIndicatorOptions seam stays authoritative.
 */

function createIndicator(message = "Working") {
	const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
	return new WorkingStatusIndicator(tui, message);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("status-line animation policy", () => {
	it("keeps spinner rendering byte-identical to the default path", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = createIndicator();
		const defaultLoader = new Loader(
			{ requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI,
			(text: string) => theme.fg("accent", text),
			(text: string) => theme.fg("muted", text),
			"Working",
		);
		try {
			expect(indicator.render(40)).toEqual(defaultLoader.render(40));
			const first = indicator.render(40)[1]!;
			expect(stripAnsi(first).trimEnd()).toBe(` ${STATUS_SPINNER_FRAMES[0]} Working`);
			expect(first).toContain(theme.getFgAnsi("accent"));
			vi.advanceTimersByTime(DEFAULT_STATUS_ANIMATION_POLICY.frameIntervalMs);
			const second = indicator.render(40)[1]!;
			expect(stripAnsi(second).trimEnd()).toBe(` ${STATUS_SPINNER_FRAMES[1]} Working`);
			expect(second).toContain(theme.getFgAnsi("accent"));
		} finally {
			indicator.dispose();
			defaultLoader.stop();
		}
	});

	it("advances frames at the policy rate, not the Loader default", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = createIndicator();
		try {
			const start = stripAnsi(indicator.render(40)[1]!);
			vi.advanceTimersByTime(DEFAULT_STATUS_ANIMATION_POLICY.frameIntervalMs * 2);
			expect(stripAnsi(indicator.render(40)[1]!)).toBe(
				start.replace(STATUS_SPINNER_FRAMES[0], STATUS_SPINNER_FRAMES[2]),
			);
		} finally {
			indicator.dispose();
		}
	});

	it("schedules zero animation ticks while stopped (idle => zero animation)", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = createIndicator();
		indicator.dispose();
		const requestRender = vi.fn();
		const tui = { requestRender, terminal: { rows: 10 } } as unknown as TUI;
		const stopped = new WorkingStatusIndicator(tui, "Working");
		stopped.dispose();
		const calls = requestRender.mock.calls.length;
		vi.advanceTimersByTime(60_000);
		expect(requestRender.mock.calls.length).toBe(calls);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps values updating immediately regardless of the frame rate", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = createIndicator();
		try {
			indicator.setMessage("Retrying now");
			expect(stripAnsi(indicator.render(40)[1]!).trimEnd()).toBe(` ${STATUS_SPINNER_FRAMES[0]} Retrying now`);
		} finally {
			indicator.dispose();
		}
	});

	it("leaves the extension WorkingIndicatorOptions seam authoritative", () => {
		expect(resolveWorkingIndicatorOptions({ intervalMs: 123 })).toMatchObject({ intervalMs: 123 });
		expect(resolveWorkingIndicatorOptions({ frames: ["*"] })).toMatchObject({ frames: ["*"] });
		expect(resolveWorkingIndicatorOptions().intervalMs).toBe(DEFAULT_STATUS_ANIMATION_POLICY.frameIntervalMs);
	});
});
