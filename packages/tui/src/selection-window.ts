import type { ScrollView } from "./components/scroll-view.ts";
import { getScrollViewBox, type LayoutFrame } from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import type { Component } from "./tui.ts";

/**
 * Selection-window seam: resolve the real content lines behind a mouse selection
 * across the S11 render windowing.
 *
 * The S11 windowing (see `components/render-memo.ts` and the eviction pass in
 * `layout.ts`) drops rendered lines for boxes outside clip +/- (viewport + 64)
 * and answers later renders of the same text/width with blankness-preserving
 * stub rows (`""` / `"\u0000"`). That is correct for painting (a re-render
 * storm must not happen on every frame) but wrong for consumers that need the
 * real glyphs: selection copy, word/line granularity, and search.
 *
 * This seam is that mapping. It is called only on user-driven, one-shot paths
 * (copy, selection anchoring), so materializing an evicted range on demand
 * costs at most one real re-render per copy. Rendered lines are re-stored in
 * each component's render memo, so the next paint re-renders byte-identically.
 */

const STUB_ROW = "\u0000";

/** Materialized source lines per frame content array (per-frame arrays; GC with the frame). */
const materializedByFrameLines = new WeakMap<object, readonly string[]>();

function isStubRow(line: string): boolean {
	return line === "" || line === STUB_ROW;
}

function hasStubRows(lines: readonly string[], startRow: number, endRow: number): boolean {
	const first = Math.max(0, Math.min(startRow, endRow));
	const last = Math.min(lines.length - 1, Math.max(startRow, endRow));
	for (let row = first; row <= last; row++) {
		const line = lines[row];
		if (line !== undefined && isStubRow(line)) return true;
	}
	return false;
}

/**
 * Invalidate render memos down the component tree so the next render() is a
 * real render instead of stub rows. Only memo-backed components (Text,
 * Markdown, anything extending MemoizedRender) react; plain components ignore
 * the call.
 */
function invalidateRenderCaches(component: unknown): void {
	if (typeof component !== "object" || component === null) return;
	const node = getLayoutNode(component as Component);
	if (node?.type === "vstack" || node?.type === "hstack") {
		for (const entry of node.entries) invalidateRenderCaches(entry.component);
	} else if (node?.type === "scroll") {
		invalidateRenderCaches(node.component);
	}
	const child = (component as { child?: unknown }).child;
	if (child !== undefined) invalidateRenderCaches(child);
	const children = (component as { children?: readonly unknown[] }).children;
	if (Array.isArray(children)) {
		for (const entry of children) invalidateRenderCaches(entry);
	}
	const invalidate = (component as { invalidate?: () => void }).invalidate;
	if (typeof invalidate === "function") invalidate.call(component);
}

function renderSourceLines(frame: LayoutFrame, scrollView: ScrollView): readonly string[] | undefined {
	const box = getScrollViewBox(frame, scrollView);
	if (!box) return undefined;
	const node = getLayoutNode(box.component);
	if (node?.type !== "scroll") return undefined;
	const content = node.component;
	invalidateRenderCaches(content);
	return content.render(node.state.getContentWidth(frame.width));
}

/**
 * Resolve the source lines for one inclusive row range of a scroll view's
 * content through the render windowing: real rows pass through untouched;
 * stubbed (evicted) ranges are materialized from source once per frame.
 *
 * Returns undefined only when the scroll view is not part of the frame.
 */
export function resolveSelectionSourceLines(
	frame: LayoutFrame,
	scrollView: ScrollView,
	startRow: number,
	endRow: number,
): readonly string[] | undefined {
	const box = getScrollViewBox(frame, scrollView);
	if (!box) return undefined;
	const frameLines = box.scrollContentLines;
	if (frameLines && !hasStubRows(frameLines, startRow, endRow)) return frameLines;
	if (frameLines) {
		const materialized = materializedByFrameLines.get(frameLines);
		if (materialized) return materialized;
	}
	const source = renderSourceLines(frame, scrollView) ?? frameLines;
	if (frameLines && source) materializedByFrameLines.set(frameLines, source);
	return source;
}
