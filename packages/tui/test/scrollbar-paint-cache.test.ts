import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { getGraphemeSegmenter } from "../src/utils.ts";

describe("scrollbar paint reuse", () => {
	it("does not segment unchanged visible rows on a repeated frame", () => {
		const lines = Array.from({ length: 80 }, (_, i) => `\x1b[42mrow ${i} 界 é\x1b[0m`);
		const view = new ScrollView({ render: () => lines, invalidate() {} }, { scrollbar: "auto" });
		// Overlay mode paints full-width rows directly, isolating scrollbar parsing from reserved-column compositing.
		renderLayoutFrame(view, 40, 12, () => {});
		view.setScrollbarActive(true);
		const segment = mock.method(getGraphemeSegmenter(), "segment");
		try {
			const first = renderLayoutFrame(view, 40, 12, () => {}).lines;
			assert.ok(segment.mock.callCount() > 0, "cold frame must exercise the parser");
			segment.mock.resetCalls();
			const second = renderLayoutFrame(view, 40, 12, () => {}).lines;
			assert.deepEqual(second, first);
			assert.equal(segment.mock.callCount(), 0, "unchanged scrollbar cells must not be re-segmented");
		} finally {
			segment.mock.restore();
		}
	});

	it("matches a cold painter after scrolling, resizing, style and content changes", () => {
		let color = 31;
		let lines = Array.from(
			{ length: 80 },
			(_, i) => `\x1b[42m\x1b]8;;https://example.com\x07${i} 界 é 👩‍💻\x1b]8;;\x07\x1b[0m`,
		);
		const options = {
			scrollbar: "auto" as const,
			scrollbarThumbStyle: (text: string) => `\x1b[${color}m${text}\x1b[0m`,
			scrollbarTrackStyle: (text: string) => `\x1b[${color + 1}m${text}\x1b[0m`,
		};
		const view = new ScrollView({ render: () => lines, invalidate() {} }, options);
		for (let step = 0; step < 30; step++) {
			const width = step % 3 === 0 ? 24 : 25;
			const height = step % 4 === 0 ? 8 : 12;
			color = step % 2 === 0 ? 31 : 35;
			if (step === 15) lines = lines.map((line) => `${line}new`);
			view.setScrollbar(step % 5 === 0 ? "always" : "auto");
			const active = step % 2 === 0;
			view.setScrollbarActive(active);
			renderLayoutFrame(view, width, height, () => {});
			view.scrollTo(step + 1);
			const root = new HStack([
				{ component: view, basis: width - 3 },
				{ component: { render: () => ["end"], invalidate() {} }, basis: 3 },
			]);
			const actual = renderLayoutFrame(root, width, height, () => {}).lines;
			const cold = new ScrollView(
				{ render: () => lines, invalidate() {} },
				{ ...options, scrollbar: view.scrollbar },
			);
			cold.setScrollbarActive(active);
			renderLayoutFrame(cold, width - 3, height, () => {});
			cold.scrollTo(view.scrollTop);
			const coldRoot = new HStack([
				{ component: cold, basis: width - 3 },
				{ component: { render: () => ["end"], invalidate() {} }, basis: 3 },
			]);
			assert.deepEqual(actual, renderLayoutFrame(coldRoot, width, height, () => {}).lines, `step ${step}`);
		}
	});
});
