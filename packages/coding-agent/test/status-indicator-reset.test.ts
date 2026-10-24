import type { TUI } from "@earendil-works/pi-tui";
import { configureStatusLinePolicy, DEFAULT_STATUS_LINE_POLICY, Loader } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusIndicator, WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { DEFAULT_STATUS_ANIMATION_POLICY } from "../src/modes/interactive/status-line/animation-policy.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function ui(): TUI {
	return { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("status indicator override reset", () => {
	it("clearing an override restores the working policy instead of the Loader cadence", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const interval = vi.spyOn(globalThis, "setInterval");
		const indicator = new WorkingStatusIndicator(ui(), "Working");
		try {
			expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 500);
			indicator.setIndicator({ frames: ["x", "y"], intervalMs: 123 });
			expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 123);
			indicator.setIndicator(undefined);
			expect(interval).toHaveBeenLastCalledWith(
				expect.any(Function),
				DEFAULT_STATUS_ANIMATION_POLICY.frameIntervalMs,
			);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			indicator.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("explicit overrides and resets advance frames at their respective cadences", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = new WorkingStatusIndicator(ui(), "Working");
		try {
			indicator.setIndicator({ frames: ["x", "y"], intervalMs: 123 });
			const initial = indicator.render(40);
			vi.advanceTimersByTime(80);
			expect(indicator.render(40)).toEqual(initial);
			vi.advanceTimersByTime(43);
			expect(indicator.render(40)).not.toEqual(initial);
			indicator.setIndicator({ intervalMs: 123 });
			indicator.setIndicator();
			const reset = indicator.render(40);
			vi.advanceTimersByTime(80);
			expect(indicator.render(40)).toEqual(reset);
			vi.advanceTimersByTime(420);
			expect(indicator.render(40)).not.toEqual(reset);
		} finally {
			indicator.dispose();
		}
	});

	it("explicit overrides remain authoritative until reset across repeated live cycles", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const interval = vi.spyOn(globalThis, "setInterval");
		const indicator = new StatusIndicator(
			"retry",
			ui(),
			(text) => text,
			(text) => text,
			"Retry",
			{ intervalMs: 777 },
		);
		try {
			expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 777);
			for (let cycle = 0; cycle < 2; cycle++) {
				indicator.setIndicator({ frames: ["a", "b"], intervalMs: 123, renderVerbatim: true });
				expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 123);
				indicator.setIndicator();
				expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 500);
				expect(vi.getTimerCount()).toBe(1);
			}
			indicator.setIndicator({ frames: [] });
			expect(vi.getTimerCount()).toBe(0);
			indicator.setIndicator();
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			indicator.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not change the generic Loader default", () => {
		// The Loader default is the tui status-line policy cadence (#18), not the
		// status-indicator policy. Pin it to 80 ms so a leak of the 500 ms working
		// policy into the Loader would show up as a mismatch.
		configureStatusLinePolicy({ spinnerTickMs: 80 });
		initTheme("dark");
		vi.useFakeTimers();
		const interval = vi.spyOn(globalThis, "setInterval");
		const loader = new Loader(
			ui(),
			(text) => text,
			(text) => text,
		);
		try {
			loader.setIndicator();
			expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 80);
		} finally {
			loader.stop();
			configureStatusLinePolicy({ ...DEFAULT_STATUS_LINE_POLICY });
		}
		expect(vi.getTimerCount()).toBe(0);
	});
});
