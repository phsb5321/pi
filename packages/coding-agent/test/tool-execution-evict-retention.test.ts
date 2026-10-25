import v8 from "node:v8";
import vm from "node:vm";
import type { TUI } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Retention pin for settled-point eviction: after evictRenderCaches(), the result renderer
// subtree (rendered lines + source text) must be collectable, not kept alive by the
// component's child tree. The next render rebuilds it.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const ui = { requestRender() {} } as unknown as TUI;

beforeEach(() => {
	initTheme("dark");
});

describe("ToolExecutionComponent.evictRenderCaches retention", () => {
	it("lets the evicted result renderer subtree be collected and rebuilds it on render", async () => {
		const holder: { ref?: WeakRef<object> } = {};
		const toolDefinition = {
			renderResult: () => {
				const rendered = new Text("result ".repeat(20_000), 0, 0);
				holder.ref = new WeakRef(rendered);
				return rendered;
			},
		};
		const component = new ToolExecutionComponent("test-tool", "call-1", {}, {}, toolDefinition as never, ui, "/tmp");
		component.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		const before = component.render(80);
		expect(holder.ref?.deref()).toBeDefined();

		component.evictRenderCaches();
		await new Promise((resolve) => setImmediate(resolve));
		gc();

		expect(holder.ref?.deref()).toBeUndefined();
		expect(component.render(80)).toEqual(before);
	});
});

describe("ToolExecutionComponent keeps only the result fields it renders", () => {
	it("does not retain a bash result's structuredContent after updateResult", async () => {
		// structuredContent.output is a second copy of the output kept for programmatic callers.
		const component = new ToolExecutionComponent("bash", "call-1", {}, {}, undefined, ui, "/tmp");
		let structured: WeakRef<object> | undefined;
		const store = () => {
			const structuredContent = { output: "y".repeat(50_000), truncated: false, exit_code: 0 };
			structured = new WeakRef(structuredContent);
			component.updateResult({
				content: [{ type: "text", text: "out" }],
				isError: false,
				structuredContent,
			} as never);
		};
		store();
		await new Promise((resolve) => setImmediate(resolve));
		gc();

		expect(structured?.deref()).toBeUndefined();
		expect(component.render(80).join("\n")).toContain("out");
	});
});
