/**
 * Fullscreen (viewport) TUI memory bench (9989-mem-bench, w6).
 *
 * Usage (from packages/coding-agent, after `npm run build:offline` at the repo root):
 *   node --experimental-strip-types --expose-gc test/mem-bench/tui-bench.ts <turns> <out.jsonl>
 *
 * Drives the real fullscreen TUI (createInteractiveTui -> TuiAltScreen, the viewport layout in
 * packages/tui/src/layout.ts) against a VirtualTerminal, the same way test/interactive-tui.test.ts
 * does. Each turn appends a real BashExecutionComponent with 50 KB of output (the bash tool's cap)
 * to the chat, renders, then scrolls: every turn it scrolls up 3 pages, every 10th turn it jumps to
 * the top (old messages re-materialise) and back to the bottom (they leave the paint window).
 *
 * Not covered: the full InteractiveMode controller (needs an AgentSessionRuntime host); the
 * session event wiring is therefore replaced by direct component insertion.
 *
 * Checkpoints (turn 50/100/200): gc() twice, then rss and heapUsed, one JSON line each.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Container } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { BashExecutionComponent } from "../../src/modes/interactive/components/bash-execution.ts";
import { createInteractiveTui } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const [turnsArg, outFile] = process.argv.slice(2);
const TURNS = Number(turnsArg ?? 200);
if (!outFile || !Number.isFinite(TURNS) || TURNS < 1) throw new Error("usage: tui-bench.ts <turns> <out.jsonl>");
const gc = globalThis.gc;
if (typeof gc !== "function") throw new Error("run with --expose-gc");

const CHECKPOINTS = new Set([50, 100, 200, TURNS].filter((t) => t <= TURNS));
const LINE = `${"x".repeat(99)}\n`; // 100 bytes per line, 500 lines = 50 KB per result
const OUTPUT = LINE.repeat(500);

function checkpoint(turn: number, extra: Record<string, unknown>): void {
	gc();
	gc();
	const m = process.memoryUsage();
	appendFileSync(
		outFile,
		`${JSON.stringify({ mode: "tui", turn, rssMB: +(m.rss / 1048576).toFixed(1), heapUsedMB: +(m.heapUsed / 1048576).toFixed(1), ...extra })}\n`,
	);
}

writeFileSync(outFile, "");
initTheme();
const terminal = new VirtualTerminal(120, 40);
const tui = createInteractiveTui({
	tuiMode: "fullscreen",
	showHardwareCursor: false,
	logDirectory: tmpdir(),
	terminal,
});
const chat = new Container();
tui.addChild(chat);
tui.start();
await terminal.waitForRender();

for (let i = 0; i < TURNS; i++) {
	const comp = new BashExecutionComponent(`head -n 500 (turn ${i})`, tui);
	comp.appendOutput(OUTPUT);
	comp.setComplete(0, false);
	chat.addChild(comp);
	tui.requestRender();
	await terminal.waitForRender();
	for (let p = 0; p < 3; p++) {
		tui.scrollBy(-terminal.rows);
		await terminal.waitForRender();
	}
	if (i % 10 === 9) {
		tui.scrollToTop();
		await terminal.waitForRender();
		tui.scrollToBottom();
		await terminal.waitForRender();
	}
	if (CHECKPOINTS.has(i + 1)) checkpoint(i + 1, { components: chat.children.length });
}
tui.stop();
