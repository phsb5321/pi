import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEGIN_SYNC = "\x1b[?2026h";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	input(data: string): void {
		this.sendInput(data);
	}
	get frames(): number {
		return this.writes.filter((w) => w.includes(BEGIN_SYNC)).length;
	}
}

class Lines implements Component {
	lines: string[] = [];
	received: string[] = [];
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.received.push(data);
	}
}

/** Reference renderer: every line is normalized on every frame. */
class AlwaysProcess extends TuiMainScreen {
	protected override applyLineResetsReusing(lines: string[]): string[] {
		return this.applyLineResets(lines);
	}
}

class Counting extends TuiMainScreen {
	get processed(): number {
		return this.linesProcessed;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function transcript(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `row ${i}\twith a tab and \x1b[1mbold\x1b[22m text`);
}

describe("main screen line reuse", () => {
	it("writes the same bytes as normalizing every line on every frame", () => {
		const reuse = new RecordingTerminal(60, 12);
		const reference = new RecordingTerminal(60, 12);
		const a = new TuiMainScreen(reuse);
		const b = new AlwaysProcess(reference);
		const ca = new Lines();
		const cb = new Lines();
		a.addChild(ca);
		b.addChild(cb);
		const steps: Array<(c: Lines) => void> = [
			(c) => {
				c.lines = transcript(30);
			},
			(c) => {
				c.lines = [...transcript(30), "footer 1"];
			},
			(c) => {
				c.lines = [...transcript(30).slice(0, 10), "changed\tmiddle", ...transcript(30).slice(11), "footer 1"];
			},
			(c) => {
				c.lines = [...transcript(30), `prompt > ab${CURSOR_MARKER}`];
			},
			(c) => {
				c.lines = [...transcript(30), `prompt > a${CURSOR_MARKER}b`];
			},
			(c) => {
				c.lines = transcript(8);
			},
			(c) => {
				c.lines = transcript(40);
			},
		];
		a.start();
		b.start();
		for (const step of steps) {
			step(ca);
			step(cb);
			a.renderNow();
			b.renderNow();
		}
		reuse.resize(40, 12);
		reference.resize(40, 12);
		a.renderNow();
		b.renderNow();
		a.renderNow(true);
		b.renderNow(true);
		assert.deepStrictEqual(reuse.writes, reference.writes);
		a.stop();
		b.stop();
	});

	it("normalizes only the lines whose text changed", () => {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new Counting(terminal);
		const content = new Lines();
		content.lines = transcript(200);
		tui.addChild(content);
		tui.start();
		tui.renderNow();
		assert.strictEqual(tui.processed, 200);
		content.lines = [...content.lines.slice(0, 199), "new last line"];
		tui.renderNow();
		assert.strictEqual(tui.processed, 201, "only the changed line is normalized");
		tui.renderNow();
		assert.strictEqual(tui.processed, 201, "an unchanged frame normalizes nothing");
		tui.renderNow(true);
		assert.strictEqual(tui.processed, 401, "a forced redraw normalizes every line again");
		tui.stop();
	});
});

describe("unfocused render interval", () => {
	async function frameCount(unfocused: number, focusOut: boolean): Promise<{ frames: number; tui: TuiMainScreen }> {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		tui.setUnfocusedRenderInterval(unfocused);
		const content = new Lines();
		tui.addChild(content);
		tui.start();
		if (focusOut) terminal.input(FOCUS_OUT);
		await sleep(40);
		const before = terminal.frames;
		for (let i = 0; i < 30; i++) {
			content.lines = [`streamed ${i}`];
			tui.requestRender();
			await sleep(20);
		}
		const frames = terminal.frames - before;
		tui.stop();
		return { frames, tui };
	}

	it("is off by default: focus loss changes nothing and no focus reporting is requested", async () => {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		const content = new Lines();
		tui.addChild(content);
		tui.setFocus(content);
		tui.start();
		assert.ok(!terminal.writes.some((w) => w.includes("?1004h")));
		terminal.input(FOCUS_OUT);
		assert.deepStrictEqual(content.received, [FOCUS_OUT], "without opt-in the sequence still reaches the component");
		tui.stop();
		const slow = await frameCount(0, true);
		assert.ok(slow.frames >= 15, `focus loss without opt-in kept ${slow.frames} frames`);
	});

	it("draws far fewer frames for a streaming seat that lost focus", async () => {
		const focused = await frameCount(200, false);
		const unfocused = await frameCount(200, true);
		assert.ok(focused.frames >= 15, `focused seat drew ${focused.frames} frames`);
		assert.ok(unfocused.frames <= focused.frames / 2, `unfocused ${unfocused.frames} vs focused ${focused.frames}`);
		assert.strictEqual(unfocused.tui.fullRedraws, focused.tui.fullRedraws, "focus changes cause no full redraws");
	});

	it("asks for focus events only while enabled, consumes them, and turns them off on stop", () => {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		tui.setUnfocusedRenderInterval(150);
		const content = new Lines();
		tui.addChild(content);
		tui.setFocus(content);
		tui.start();
		assert.ok(terminal.writes.some((w) => w.includes("\x1b[?1004h")));
		terminal.input(FOCUS_OUT);
		terminal.input(FOCUS_IN);
		assert.deepStrictEqual(content.received, [], "focus reports are not typed into the editor");
		assert.strictEqual(tui.isTerminalFocused(), true);
		tui.stop();
		assert.ok(terminal.writes.some((w) => w.includes("\x1b[?1004l")));
	});

	it("repaints at once when focus returns", async () => {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		tui.setUnfocusedRenderInterval(250);
		const content = new Lines();
		tui.addChild(content);
		tui.start();
		await sleep(40);
		terminal.input(FOCUS_OUT);
		content.lines = ["pending"];
		tui.requestRender();
		await sleep(30);
		const early = terminal.frames;
		terminal.input(FOCUS_IN);
		await sleep(30);
		assert.ok(terminal.frames > early, "focus-in rendered the pending frame without waiting 250 ms");
		tui.stop();
	});

	it("starts unfocused when seeded, and a real focus event wins over a late seed", async () => {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		tui.setUnfocusedRenderInterval(200);
		const content = new Lines();
		tui.addChild(content);
		tui.start();
		tui.seedTerminalFocus(false);
		assert.strictEqual(tui.isTerminalFocused(), false);
		await sleep(40);
		const before = terminal.frames;
		for (let i = 0; i < 15; i++) {
			content.lines = [`streamed ${i}`];
			tui.requestRender();
			await sleep(20);
		}
		assert.ok(terminal.frames - before <= 3, `seeded-unfocused seat drew ${terminal.frames - before} frames`);
		terminal.input(FOCUS_IN);
		tui.seedTerminalFocus(false);
		assert.strictEqual(tui.isTerminalFocused(), true, "a seed that arrives after a focus event is ignored");
		tui.stop();
	});

	it("enabling the interval after start requests focus events once", () => {
		const terminal = new RecordingTerminal(60, 12);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Lines());
		tui.start();
		tui.setUnfocusedRenderInterval(100);
		tui.setUnfocusedRenderInterval(120);
		assert.strictEqual(terminal.writes.filter((w) => w.includes("?1004h")).length, 1);
		tui.setUnfocusedRenderInterval(0);
		assert.strictEqual(terminal.writes.filter((w) => w.includes("?1004l")).length, 1);
		tui.stop();
	});
});
