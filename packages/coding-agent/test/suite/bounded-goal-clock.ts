import { afterEach, vi } from "vitest";

// The bounded-goal driver's deadline is an absolute wall-clock instant. Freeze Date (timers stay real) so cold
// start or CPU starvation cannot spend a window that only the deadline tests are meant to bound.
afterEach(() => {
	vi.useRealTimers();
});

export function freezeDate(): void {
	if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
}
