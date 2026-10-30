import assert from "node:assert/strict";
import { Text } from "../../src/components/text.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";
import type { VirtualTerminal } from "./virtual-terminal.ts";

/** The three-row child every viewport test builds its scroll history from. */
export function childLineSource(index: number): string {
	return `child ${index} line a\nchild ${index} line b\nchild ${index} line c`;
}

/** Builds `count` children with the shared three-row source, through `make` so a test can count stores. */
export function childTexts(count: number, make: (source: string) => Text = (source) => new Text(source, 0, 0)): Text[] {
	return Array.from({ length: count }, (_, i) => make(childLineSource(i)));
}

/** Scroll to the far end and back, forcing a window eviction and re-entry, with settled renders. */
export async function cycleViewport(
	tui: TuiAltScreen,
	terminal: VirtualTerminal,
	times = 1,
	reenter = true,
): Promise<void> {
	for (let cycle = 0; cycle < times; cycle++) {
		tui.scrollToBottom();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();
		if (reenter) {
			tui.scrollToTop();
			await terminal.waitForRender();
			tui.requestRender();
			await terminal.waitForRender();
		}
	}
}

/** A TUI bound to `terminal` whose selection copy path records instead of touching the clipboard. */
export function recordingSelectionTui(terminal: VirtualTerminal): { copied: string[]; tui: TuiAltScreen } {
	const { copied, copySelection } = recordingCopy();
	const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, copySelection });
	return { copied, tui };
}

/** Builds a copy hook that records into `copied` instead of touching the system clipboard. */
function recordingCopy(): {
	copied: string[];
	copySelection: (text: string) => Promise<boolean>;
} {
	const copied: string[] = [];
	return {
		copied,
		copySelection: async (text: string) => {
			copied.push(text);
			return true;
		},
	};
}

/**
 * Drags the mouse across the "界" glyph on the first row (columns 2–4), asserts the reverse-video
 * highlight painted, copies the active selection, and asserts exactly the highlighted grapheme
 * came back through the recording hook.
 */
export async function dragSelectCjkAndCopy(
	tui: TuiAltScreen,
	terminal: VirtualTerminal,
	copied: string[],
): Promise<void> {
	terminal.sendInput("\x1b[<0;2;1M");
	terminal.sendInput("\x1b[<32;4;1M");
	terminal.sendInput("\x1b[<3;4;1m");
	await terminal.waitForRender();
	assert.ok(tui.getScreenLines()[0].includes("\x1b[7m"), "selection must paint reverse video");
	assert.equal(await tui.copyActiveSelectionToClipboard(), true);
	assert.deepEqual(copied, ["界B"]);
}
