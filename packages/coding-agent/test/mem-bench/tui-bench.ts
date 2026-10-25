/**
 * Fullscreen (viewport) TUI memory bench (9989-mem-bench).
 *
 * Usage (from packages/coding-agent, after `npm run build:offline` at the repo root):
 *   node --experimental-strip-types --expose-gc test/mem-bench/tui-bench.ts <turns> <out.jsonl>
 *   BENCH_SNAPSHOT_DIR=<dir> node ... tui-bench.ts <turns> <out.jsonl>   # also V8 heap snapshots
 *
 * Drives the real fullscreen TUI (createInteractiveTui -> TuiAltScreen, the viewport layout in
 * packages/tui/src/layout.ts) against a VirtualTerminal, the same way test/interactive-tui.test.ts
 * does. Each turn appends a real BashExecutionComponent with 50 KB of output (the bash tool's cap)
 * to the chat, renders, then scrolls: every turn it scrolls up 3 pages, every 10th turn it jumps to
 * the top (old messages re-materialise) and back to the bottom (they leave the paint window).
 *
 * Not covered: the full InteractiveMode controller (needs an AgentSessionRuntime host); the
 * session event wiring is replaced by direct component insertion.
 *
 * Checkpoints (turn 50/100/200): gc() twice, then process.memoryUsage() fields, one JSON line each.
 * With BENCH_SNAPSHOT_DIR set, a V8 heap snapshot is written after gc() at each checkpoint, and
 * the per-space heap breakdown at the last one.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { Container } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { BashExecutionComponent } from "../../src/modes/interactive/components/bash-execution.ts";
import { createInteractiveTui } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { mb, memRecord, parseBenchArgs, scrollSweep } from "./bench-util.ts";

const { turns: TURNS, outFile, gc, checkpoints: CHECKPOINTS } = parseBenchArgs("tui-bench.ts", [50, 100, 200]);
const SNAPSHOT_DIR = process.env.BENCH_SNAPSHOT_DIR;
if (SNAPSHOT_DIR) mkdirSync(SNAPSHOT_DIR, { recursive: true });
const LINE = `${"x".repeat(99)}\n`; // 100 bytes per line, 500 lines = 50 KB per result
const OUTPUT = LINE.repeat(500);

// Linux only: split RSS into anonymous (malloc and V8 pages) and file-backed (binary, shared libs).

function checkpoint(turn: number, extra: Record<string, unknown>): void {
	gc();
	gc();
	const line = memRecord("tui", turn, extra);
	if (SNAPSHOT_DIR) {
		line.snapshot = writeHeapSnapshot(`${SNAPSHOT_DIR}/t${turn}.heapsnapshot`);
		if (turn === TURNS) {
			line.spaces = getHeapSpaceStatistics().map((s) => ({
				space: s.space_name,
				sizeMB: mb(s.space_size),
				usedMB: mb(s.space_used_size),
			}));
		}
	}
	appendFileSync(outFile, `${JSON.stringify(line)}\n`);
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
	await scrollSweep(tui, terminal, i);
	if (CHECKPOINTS.has(i + 1)) checkpoint(i + 1, { components: chat.children.length });
}
tui.stop();
