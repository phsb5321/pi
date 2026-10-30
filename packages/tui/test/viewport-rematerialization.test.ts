import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { childTexts, cycleViewport, dragSelectCjkAndCopy, recordingSelectionTui } from "./helpers/viewport-fixtures.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("window re-entry preserves exact visible rows, including rendered padding", async () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(new ScrollView(new VStack(childTexts(40)), { primary: true }));
	try {
		tui.start();
		await terminal.waitForRender();
		const content = ["child 0 line a", "child 0 line b", "child 0 line c"];
		// This is a painted viewport row, including explicit blank cells through
		// the terminal width; it is not an unpadded component-content string.
		const expected = content.map((line) => line.padEnd(terminal.columns, " "));
		const initial = terminal.getViewport().slice(0, 3);
		assert.deepEqual(initial, expected);
		assert.notDeepEqual(initial, content, "the historical unpadded initial-frame oracle is false");
		assert.throws(() => assert.deepEqual([" ".repeat(terminal.columns), expected[1], expected[2]], expected));

		await cycleViewport(tui, terminal);
		const reentered = terminal.getViewport().slice(0, 3);
		console.log(JSON.stringify({ scope: "source virtual-terminal only", initial, reentered, expected }));
		assert.deepEqual(reentered, expected, "re-entry must not drop glyphs or meaningful frame padding");
	} finally {
		tui.stop();
	}
});

test("ANSI/CJK copy retains highlighted graphemes without copying control bytes", async () => {
	const terminal = new VirtualTerminal(20, 5);
	const { copied, tui } = recordingSelectionTui(terminal);
	tui.setLayoutRoot(new ScrollView(new VStack([new Text("A\x1b[31m界\x1b[0mB café", 0, 0)]), { primary: true }));
	try {
		tui.start();
		await terminal.waitForRender();
		await dragSelectCjkAndCopy(tui, terminal, copied);
	} finally {
		tui.stop();
	}
});
