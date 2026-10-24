import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("window re-entry preserves exact visible rows, including rendered padding", async () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(
		new ScrollView(
			new VStack(
				Array.from(
					{ length: 40 },
					(_, i) => new Text(`child ${i} line a\nchild ${i} line b\nchild ${i} line c`, 0, 0),
				),
			),
			{ primary: true },
		),
	);
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

		tui.scrollToBottom();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();
		tui.scrollToTop();
		await terminal.waitForRender();
		tui.requestRender();
		await terminal.waitForRender();
		const reentered = terminal.getViewport().slice(0, 3);
		console.log(JSON.stringify({ scope: "source virtual-terminal only", initial, reentered, expected }));
		assert.deepEqual(reentered, expected, "re-entry must not drop glyphs or meaningful frame padding");
	} finally {
		tui.stop();
	}
});

test("ANSI/CJK copy retains highlighted graphemes without copying control bytes", async () => {
	const terminal = new VirtualTerminal(20, 5);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.setLayoutRoot(new ScrollView(new VStack([new Text("A\x1b[31m界\x1b[0mB café", 0, 0)]), { primary: true }));
	try {
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<3;4;1m");
		await terminal.waitForRender();
		assert.ok(tui.getScreenLines()[0].includes("\x1b[7m"));
		assert.equal(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepEqual(copied, ["界B"]);
	} finally {
		tui.stop();
	}
});
