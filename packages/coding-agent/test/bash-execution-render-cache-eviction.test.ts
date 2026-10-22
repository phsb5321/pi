import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Minimal TUI stub: the loader only needs interval hooks and terminal size. */
function createTuiStub(columns: number) {
	return {
		terminal: {
			get columns() {
				return columns;
			},
			get rows() {
				return 24;
			},
		},
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	} as any;
}

/**
 * Settled-point eviction for the collapsed bash preview. The preview's per-width visual lines
 * are regenerable from the authoritative output lines, so a settled seat must not keep them.
 */
describe("BashExecutionComponent settled render-cache eviction", () => {
	beforeAll(() => initTheme(undefined, false));

	it("releases the collapsed preview lines and re-renders them byte-identically", () => {
		const component = new BashExecutionComponent("seq 30", createTuiStub(120));
		component.appendOutput(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
		component.setComplete(0, false);
		const before = component.render(120);
		const output = component.getOutput();
		const caches = component as unknown as { previewCache?: unknown };
		expect(caches.previewCache).toBeDefined();

		component.evictRenderCaches();
		expect(caches.previewCache).toBeUndefined();
		expect(component.getOutput()).toBe(output);

		expect(component.render(120)).toEqual(before);
		expect(component.render(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
});
