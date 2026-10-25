import v8 from "node:v8";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Retention pin for the collapsed bash preview. The component must keep the visual lines it shows,
// not a styled copy of the whole output: that copy is rebuildable from the session's tool result.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const N = 20;
const LINES = 500;

function outputFor(i: number): string {
	return Array.from({ length: LINES }, (_, j) => `${i}-${j}`.padEnd(99, "x")).join("\n");
}

beforeEach(() => {
	initTheme("dark");
});

describe("collapsed bash preview retention", () => {
	it("keeps no styled copy of the full output once rendered", () => {
		const results = Array.from({ length: N }, (_, i) => ({ content: [{ type: "text", text: outputFor(i) }] }));
		const renderers = createShellRenderers("$");
		const context = {
			state: {},
			lastComponent: undefined,
			invalidate() {},
			showImages: false,
			isError: false,
			durationMs: undefined,
			executionStarted: false,
		} as never;

		gc();
		const before = process.memoryUsage().heapUsed;
		const components = results.map((result) => {
			const component = renderers.renderResult!(result as never, { expanded: false, isPartial: false } as never, undefined as never, context);
			component.render(80);
			return component;
		});
		gc();
		const retained = process.memoryUsage().heapUsed - before;
		process.stderr.write(`MEASURE bash-preview retained=${retained} bytes (N=${N}, ~${Math.round(LINES * 100 / 1000)} KB output each)\n`);

		// Full styled copies would hold about 58 KB each. Visual lines alone are a few KB each.
		expect(retained).toBeLessThan(N * 20_000);
		expect(components).toHaveLength(N);
	});
});
