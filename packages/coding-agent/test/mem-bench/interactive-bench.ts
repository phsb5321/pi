/**
 * Full-controller memory bench (9989-mem-bench, w7): drives the real InteractiveMode.
 *
 * Usage (from packages/coding-agent, after `npm ci --ignore-scripts && npm run build:offline` at the repo root):
 *   PI_OFFLINE=1 node --experimental-strip-types --expose-gc test/mem-bench/interactive-bench.ts <turns> <out.jsonl>
 *
 * Unlike tui-bench.ts, nothing is inserted into the chat by hand. Each turn:
 *   - the faux provider (suite harness) scripts one bash tool call that prints ~50 KB, then a text reply;
 *   - AgentSession.prompt() runs the real agent loop, which emits session events;
 *   - InteractiveMode's own subscription creates the BashExecution/ToolExecution/Assistant components;
 *   - the VirtualTerminal renders, then the viewport scrolls: 3 pages up per turn, and every 10th turn
 *     jumps to the top and back to the bottom so old components re-materialise and leave the window.
 *
 * Checkpoints (turns 50, 100, 200, final): gc() twice, then rss and heapUsed, one JSON line each.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { writeHeapSnapshot } from "node:v8";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../suite/harness.ts";

const [turnsArg, outFile] = process.argv.slice(2);
const TURNS = Number(turnsArg ?? 200);
if (!outFile || !Number.isFinite(TURNS) || TURNS < 1)
	throw new Error("usage: interactive-bench.ts <turns> <out.jsonl>");
const gc = globalThis.gc;
if (typeof gc !== "function") throw new Error("run with --expose-gc");
if (!process.env.PI_OFFLINE) throw new Error("set PI_OFFLINE=1 (no network in the bench)");

const CHECKPOINTS = new Set([50, 100, 200, TURNS].filter((t) => t <= TURNS));
// 500 lines of 100 bytes = 50,000 bytes: the bash tool's output cap.
const COMMAND = "awk 'BEGIN{for(i=0;i<500;i++)printf \"%099d\\n\", 0}'";
// BENCH_UNIQUE=1: each turn prints its own marker on every line (100 bytes per line), so copies of a
// result can be told apart in a heap snapshot. Off by default to keep the w7 protocol.
const UNIQUE = process.env.BENCH_UNIQUE === "1";
const SNAPSHOT_DIR = process.env.BENCH_SNAPSHOT_DIR;
if (SNAPSHOT_DIR) mkdirSync(SNAPSHOT_DIR, { recursive: true });
function commandFor(turn: number): string {
	if (!UNIQUE) return COMMAND;
	return `awk -v t=${turn} 'BEGIN{for(j=0;j<500;j++)printf "T%05d L%04d %086d\\n", t, j, 0}'`;
}

function checkpoint(turn: number): void {
	gc();
	gc();
	const m = process.memoryUsage();
	// Proof the real event path ran: chat children created by InteractiveMode's subscription, and
	// the bash tool result the faux model asked for (last toolResult text length, bytes).
	const chat = (mode as unknown as { chatContainer: { children: unknown[] } }).chatContainer;
	const lastTool = harness.session.messages.findLast((msg) => msg.role === "toolResult");
	const toolBytes =
		lastTool && "content" in lastTool && Array.isArray(lastTool.content)
			? lastTool.content.reduce((n, part) => n + (part.type === "text" ? Buffer.byteLength(part.text ?? "") : 0), 0)
			: 0;
	const snapshot = SNAPSHOT_DIR ? writeHeapSnapshot(`${SNAPSHOT_DIR}/t${turn}.heapsnapshot`) : undefined;
	appendFileSync(
		outFile,
		`${JSON.stringify({
			mode: "interactive",
			snapshot,
			turn,
			rssMB: +(m.rss / 1048576).toFixed(1),
			heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
			chatChildren: chat.children.length,
			sessionMessages: harness.session.messages.length,
			lastToolResultBytes: toolBytes,
		})}\n`,
	);
}

writeFileSync(outFile, "");
initTheme();
// Compaction is off: its summary call would consume scripted faux responses and desynchronise turns.
const harness = await createHarness({ settings: { compaction: { enabled: false } } });
// The runtime host surface InteractiveMode calls. Session lifecycle is not exercised here.
const runtime = {
	session: harness.session,
	newSession: async () => ({ cancelled: true }),
	switchSession: async () => ({ cancelled: true }),
	fork: async () => ({ cancelled: true, selectedText: "" }),
	dispose: async () => {},
	setBeforeSessionInvalidate: () => {},
	setRebindSession: () => {},
} as unknown as AgentSessionRuntime;

const terminal = new VirtualTerminal(120, 40);
const mode = new InteractiveMode(runtime, { terminal, tuiMode: "fullscreen" });
await mode.init();
await terminal.waitForRender();

for (let i = 0; i < TURNS; i++) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: commandFor(i) })]),
		fauxAssistantMessage(`done ${i}`),
	]);
	await harness.session.prompt(`turn ${i}`);
	// The harness records every session event; the real InteractiveMode keeps none. Clear it so the
	// heap reflects what the production controller retains.
	harness.events.length = 0;
	await terminal.waitForRender();
	for (let p = 0; p < 3; p++) {
		mode.ui.scrollBy(-terminal.rows);
		await terminal.waitForRender();
	}
	if (i % 10 === 9) {
		mode.ui.scrollToTop();
		await terminal.waitForRender();
		mode.ui.scrollToBottom();
		await terminal.waitForRender();
	}
	if (CHECKPOINTS.has(i + 1)) checkpoint(i + 1);
}
mode.stop();
harness.cleanup();
