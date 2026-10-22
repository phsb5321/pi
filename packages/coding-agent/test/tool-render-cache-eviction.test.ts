import {
	type Container,
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilities,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolRenderContext, ToolRenderers } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
type Presentation = {
	contentBox: Container;
	selfRenderContainer: Container;
	contentText: { text: string };
	callRendererComponent?: unknown;
	resultRendererComponent?: unknown;
	rendererState: Record<string, unknown>;
	args: unknown;
	result: unknown;
};

function create(tool?: ToolRenderers) {
	return new ToolExecutionComponent(
		"test-tool",
		"retention-call",
		{ source: "authoritative args" },
		{},
		tool,
		{ requestRender() {} } as unknown as TUI,
		"/tmp",
	);
}

beforeEach(() => initTheme("dark"));
afterEach(() => resetCapabilitiesCache());

describe("settled tool presentation eviction", () => {
	for (const renderShell of ["default", "self"] as const) {
		it(`detaches ${renderShell} renderer children and lazily restores the same output/state`, () => {
			let calls = 0;
			const contexts: ToolRenderContext[] = [];
			const tool: ToolRenderers = {
				renderShell,
				renderCall: (_args, _theme, context) => {
					calls++;
					contexts.push(context);
					context.state.selection ??= "preserved renderer-owned setting";
					return new Text("regenerable call presentation", 0, 0);
				},
				renderResult: () => new Text("regenerable result presentation\nsecond line", 0, 0),
			};
			const component = create(tool);
			const result = { content: [{ type: "text", text: "authoritative result" }], isError: false };
			component.updateResult(result);
			const caches = component as unknown as Presentation;
			const state = caches.rendererState;
			const args = caches.args;
			const before = component.render(120);
			const oldCall = caches.callRendererComponent;
			const oldResult = caches.resultRendererComponent;
			expect((renderShell === "self" ? caches.selfRenderContainer : caches.contentBox).children).toHaveLength(2);
			const priorCalls = calls;

			component.evictRenderCaches();
			expect(caches.callRendererComponent).toBeUndefined();
			expect(caches.resultRendererComponent).toBeUndefined();
			// Resetting only reuse fields leaves both components strongly held here.
			expect(caches.contentBox.children).toHaveLength(0);
			expect(caches.selfRenderContainer.children).toHaveLength(0);
			expect(calls).toBe(priorCalls); // Settled eviction must not eagerly recreate the cache.
			expect(caches.rendererState).toBe(state);
			expect(caches.args).toBe(args);
			expect(caches.result).toBe(result);

			// No updateResult/invalidate is supplied to hide a missing wake/repaint path.
			expect(component.render(120)).toEqual(before);
			expect(calls).toBe(priorCalls + 1);
			expect(caches.callRendererComponent).not.toBe(oldCall);
			expect(caches.resultRendererComponent).not.toBe(oldResult);
			expect(contexts.at(-1)?.state).toBe(state);
			expect(state.selection).toBe("preserved renderer-owned setting");
			expect(contexts.at(-1)?.lastComponent).toBeUndefined();
			expect(component.render(120)).toEqual(before);
			expect(calls).toBe(priorCalls + 1); // Ordinary renders must keep their reuse behavior.
		});
	}

	it("releases fallback presentation text without deleting the authoritative result", () => {
		const component = create();
		const result = {
			content: [{ type: "text", text: "retained authoritative output\nsecond line" }],
			isError: false,
		};
		component.updateResult(result);
		const caches = component as unknown as Presentation;
		const before = component.render(120);
		expect(caches.contentText.text).not.toBe("");
		component.evictRenderCaches();
		expect(caches.contentText.text).toBe("");
		expect(caches.result).toBe(result);
		expect(component.render(120)).toEqual(before);
	});

	it("recreates image presentation on a render alone after settled eviction", () => {
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		const component = create();
		component.updateResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false });
		const normalize = (lines: string[]) => lines.map((line) => line.replace(/,i=\d+/, ",i=<id>"));
		const before = normalize(component.render(120));
		component.evictRenderCaches();
		expect(normalize(component.render(120))).toEqual(before);
	});

	it("preserves empty self-rendered rows through an eviction/wake cycle", () => {
		const component = create({ renderShell: "self", renderCall: () => new Text("", 0, 0) });
		expect(component.render(120)).toEqual([]);
		component.evictRenderCaches();
		expect(component.render(120)).toEqual([]);
	});
});
