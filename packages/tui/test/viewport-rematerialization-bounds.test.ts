import assert from "node:assert/strict";
import test from "node:test";
import { RenderMemo } from "../src/components/render-memo.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { childTexts, cycleViewport, dragSelectCjkAndCopy, recordingSelectionTui } from "./helpers/viewport-fixtures.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CountedText extends Text {
	stores = 0;
	readonly source: string;
	constructor(source: string) {
		super(source, 0, 0);
		this.source = source;
		const store = this.renderMemo.store.bind(this.renderMemo);
		this.renderMemo.store = (text, width, lines) => {
			this.stores++;
			store(text, width, lines);
		};
	}
	isDropped(): boolean {
		return this.renderMemo.hit(this.source, 20)?.includes("\u0000") ?? false;
	}
}

test("cold memo retains exact height/blankness until explicitly required for paint", () => {
	const memo = new RenderMemo();
	assert.equal(memo.prepareForPaint(), false);
	const real = ["row".padEnd(20), "", "界".padEnd(19)];
	memo.store("source", 20, real);
	assert.equal(memo.prepareForPaint(), false);
	memo.drop();
	assert.deepEqual(memo.hit("source", 20), ["\u0000", "", "\u0000"]);
	assert.deepEqual(memo.hit("source", 20), ["\u0000", "", "\u0000"]);
	assert.equal(memo.prepareForPaint(), true);
	assert.equal(memo.hit("source", 20), undefined);
	memo.store("source", 20, real);
	assert.equal(memo.hit("source", 20), real);
	assert.equal(memo.prepareForPaint(), false);
});

test("re-entry renders only visible dropped leaves and retains cold offscreen eviction", () => {
	const children = childTexts(80, (source) => new CountedText(source));
	const scroll = new ScrollView(new VStack(children), { primary: true });
	const frame = () => renderLayoutFrame(scroll, 20, 5, () => {});
	const stores = () => children.reduce((sum, child) => sum + child.stores, 0);
	const hot = () => children.filter((child) => !child.isDropped()).length;
	const initial = frame();
	assert.equal(stores(), 80);
	assert.ok(hot() <= 25, "clip+69-row margin, not all history retained");
	assert.equal(children[40].isDropped(), true);
	const beforeBottom = stores();
	scroll.scrollToEnd();
	frame();
	assert.equal(stores() - beforeBottom, 2, "only two visible three-row leaves rematerialize");
	const settledBottom = stores();
	frame();
	assert.equal(stores(), settledBottom, "no rerender storm on unchanged frames");
	assert.equal(children[0].isDropped(), true);
	assert.equal(children[40].isDropped(), true);
	scroll.scrollTo(0);
	const restored = frame();
	assert.deepEqual(restored.lines.slice(0, 3), initial.lines.slice(0, 3));
	assert.equal(stores() - settledBottom, 2);
	assert.equal(children[40].stores, 1, "untouched middle history never rematerialized");
	assert.equal(children[40].isDropped(), true);
	assert.equal(children[79].isDropped(), true);
	assert.ok(hot() <= 25);
	frame();
	assert.equal(stores() - settledBottom, 2);
	console.log(
		JSON.stringify({
			scope: "source unit only",
			initialStores: 80,
			reentryStores: 2,
			hotLeaves: hot(),
			coldMiddleStores: children[40].stores,
		}),
	);
});

test("ANSI/CJK selection and exact painted padding survive repeated real viewport re-entry", async () => {
	const terminal = new VirtualTerminal(20, 5);
	const { copied, tui } = recordingSelectionTui(terminal);
	const first = "A\x1b[31m界\x1b[0mB café\nsecond row\nthird row";
	tui.setLayoutRoot(
		new ScrollView(
			new VStack([
				new Text(first, 0, 0),
				...Array.from({ length: 39 }, (_, i) => new Text(`child ${i + 1}\na\nb`, 0, 0)),
			]),
			{ primary: true },
		),
	);
	try {
		tui.start();
		await terminal.waitForRender();
		const initial = terminal.getViewport().slice(0, 3);
		assert.deepEqual(initial, ["A界B café".padEnd(19), "second row".padEnd(20), "third row".padEnd(20)]);
		await cycleViewport(tui, terminal, 2);
		assert.deepEqual(terminal.getViewport().slice(0, 3), initial);
		await dragSelectCjkAndCopy(tui, terminal, copied);
	} finally {
		tui.stop();
	}
});
