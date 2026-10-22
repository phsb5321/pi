import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Windowed-selection copy equality (S11 windowing x mouse selection).
 *
 * The S11 windowing (`render-memo.ts` + `layout.ts` eviction) drops rendered
 * lines for boxes outside clip +/- (viewport + 64) and answers later renders of
 * the same text/width with blankness-preserving stub rows (`""` / `"\u0000"`).
 * Selection/copy must return exactly the glyphs the user highlighted, never the
 * stub rows, no matter when the copy happens relative to the eviction pass.
 *
 * These tests drive the product's mount shape (`setLayoutRoot`, as
 * interactive-mode.ts does) so per-message boxes exist and the windowing runs.
 */

function buildTranscript(childCount: number): { stack: VStack; children: Text[] } {
	const children = Array.from({ length: childCount }, (_, index) => {
		const label = `child ${index}`;
		return new Text(`${label} line a\n${label} line b\n${label} line c`, 0, 0);
	});
	return { stack: new VStack(children), children };
}

interface SelectionHarness {
	terminal: VirtualTerminal;
	tui: TuiAltScreen;
	copied: string[];
	children: Text[];
}

function createHarness(options: { copyOnSelect?: boolean } = {}): SelectionHarness {
	const terminal = new VirtualTerminal(20, 5);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copyOnSelect: options.copyOnSelect ?? false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const { stack, children } = buildTranscript(40);
	tui.setLayoutRoot(new ScrollView(stack, { primary: true }));
	return { terminal, tui, copied, children };
}

/** Drag from screen (x, y) to (x2, y2) with the SGR mouse protocol and release. */
function drag(terminal: VirtualTerminal, x: number, y: number, x2: number, y2: number): void {
	terminal.sendInput(`\x1b[<0;${x + 1};${y + 1}M`);
	terminal.sendInput(`\x1b[<32;${x2 + 1};${y2 + 1}M`);
	terminal.sendInput(`\x1b[<3;${x2 + 1};${y2 + 1}m`);
}

function paintedRows(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map((line) => stripTerminalSequences(line).trimEnd());
}

describe("windowed-selection copy equality", () => {
	it("copies exactly the highlighted glyphs after the windowing dropped their caches", async () => {
		const { terminal, tui, copied } = createHarness();
		tui.start();
		await terminal.waitForRender();
		tui.scrollToTop();
		await terminal.waitForRender();

		drag(terminal, 0, 0, 19, 2);
		await terminal.waitForRender();
		const highlighted = paintedRows(terminal).slice(0, 3);
		assert.deepStrictEqual(highlighted, ["child 0 line a", "child 0 line b", "child 0 line c"]);

		// Scroll far away so the S11 windowing evicts the highlighted boxes,
		// then repaint once (a spinner tick does this in real life).
		tui.scrollToBottom();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepStrictEqual(copied, [highlighted.join("\n")]);
		tui.stop();
	});

	it("copies exactly the glyphs painted at highlight time across a long drag into windowed rows", async () => {
		const { terminal, tui, copied } = createHarness();
		tui.start();
		await terminal.waitForRender();
		tui.scrollToTop();
		await terminal.waitForRender();

		// Select rows 0..2 fully; the bytes must equal what the viewport showed.
		drag(terminal, 0, 0, 19, 2);
		await terminal.waitForRender();
		const highlighted = paintedRows(terminal).slice(0, 3).join("\n");

		tui.scrollToBottom();
		await terminal.waitForRender();
		tui.scrollToTop();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepStrictEqual(copied, [highlighted]);
		tui.stop();
	});

	it("resolves word granularity from real glyphs on a windowed row", async () => {
		const { terminal, tui, copied } = createHarness();
		tui.start();
		await terminal.waitForRender();
		tui.scrollToBottom();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();

		// After eviction + repaint, scroll back and double-click "child 38".
		tui.scrollToTop();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepStrictEqual(copied, ["child"]);
		tui.stop();
	});

	it("honors the fullscreen copy policy: no copy on select when disabled, explicit copy still works", async () => {
		const { terminal, tui, copied } = createHarness({ copyOnSelect: false });
		tui.start();
		await terminal.waitForRender();
		tui.scrollToTop();
		await terminal.waitForRender();

		drag(terminal, 0, 0, 19, 2);
		await terminal.waitForRender();
		assert.deepStrictEqual(copied, [], "copyOnSelect disabled must not copy on release");
		assert.strictEqual(tui.hasActiveSelection(), true);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepStrictEqual(copied, ["child 0 line a\nchild 0 line b\nchild 0 line c"]);
		tui.stop();
	});
});
