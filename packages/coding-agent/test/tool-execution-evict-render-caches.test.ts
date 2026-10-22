import type { TUI } from "@earendil-works/pi-tui";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Behavior pin for the fork's settled-point render-cache eviction
 * (`ToolExecutionComponent.evictRenderCaches`, registry row "status line +
 * render caches"). The v1.1.0 base bump replaced the fork's `convertedImages`
 * cache with upstream's `imageSources` reuse list; eviction must drop both the
 * components and their sources in lockstep, and the next render must recreate
 * everything byte-identically.
 */

// 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type Caches = { imageSources: unknown[]; imageComponents: unknown[] };

function createComponent(): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"test-tool",
		"test-call-1",
		{ foo: "bar" },
		{},
		undefined,
		{ requestRender() {} } as unknown as TUI,
		"/tmp",
	);
}

beforeEach(() => {
	initTheme("dark");
});

afterEach(() => {
	resetCapabilitiesCache();
});

describe("ToolExecutionComponent.evictRenderCaches", () => {
	it("drops converted image caches in lockstep and recreates renders byte-identically", () => {
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		const component = createComponent();
		const result = {
			content: [
				{ type: "text", text: "done" },
				{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
			],
			isError: false,
		};
		component.updateResult(result);
		const caches = component as unknown as Caches;
		expect(caches.imageSources).toHaveLength(1);
		expect(caches.imageComponents).toHaveLength(1);

		const before = component.render(80);
		component.evictRenderCaches();
		expect(caches.imageSources).toHaveLength(0);
		expect(caches.imageComponents).toHaveLength(0);

		// The rebuild path is the next update-driven render (updateDisplay); it
		// must recreate the dropped caches byte-identically from call + result
		// (modulo the kitty image id, which is transport-internal per Image
		// instance and has no screen-visible content).
		component.updateResult(result);
		const normalizeImageIds = (lines: string[]) => lines.map((line) => line.replace(/,i=\d+/, ",i=<id>"));
		expect(normalizeImageIds(component.render(80))).toEqual(normalizeImageIds(before));
	});

	it("never reuses a dropped Image after eviction", () => {
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		const component = createComponent();
		const result = {
			content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
			isError: false,
		};
		component.updateResult(result);
		component.evictRenderCaches();
		component.updateResult(result);

		const caches = component as unknown as Caches;
		expect(caches.imageComponents).toHaveLength(1);
		expect(caches.imageComponents[0]).toBeDefined();
		expect(caches.imageSources).toHaveLength(1);
	});
});
