/**
 * Memory bench for the coding agent (9989-mem-bench).
 *
 * Usage (from packages/coding-agent, after `npm run build:offline` at the repo root):
 *   node --experimental-strip-types --expose-gc test/mem-bench/bench.ts <session|session-nocompact|render> <turns> <out.jsonl>
 *
 * Runs the tree it lives in (its own src/ and built workspace deps), so the same file can
 * be copied into a baseline checkout to compare commits. No provider is called: the faux
 * provider scripts every turn.
 *
 * session: AgentSession + real bash tool. Each turn prints ~110 KB in 1100 lines; the tool keeps
 *          its own tail (50 KB cap), so retained tool results are what the session really stores.
 * render:  BashExecutionComponent per turn with ~110 KB of output, kept in a list like the
 *          chat container. Each turn renders the newest turn and a 30-component scroll window
 *          at width 120 and 80, which is what the render-cache fixes (#24, #27) target.
 *
 * Checkpoints (turns 50, 100, ..., final): gc() then rss and heapUsed, one JSON line each.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createHarness } from "../suite/harness.ts";

const [mode, turnsArg, outFile] = process.argv.slice(2);
const TURNS = Number(turnsArg ?? 200);
if (!mode || !outFile || !Number.isFinite(TURNS) || TURNS < 1) {
	throw new Error("usage: bench.ts <session|render> <turns> <out.jsonl>");
}
const gc = globalThis.gc;
if (typeof gc !== "function") throw new Error("run with --expose-gc");

const CHUNK = "x".repeat(1000);
const CHECKPOINTS = new Set([50, 100, 200, TURNS].filter((t) => t <= TURNS));

function checkpoint(turn: number, extra: Record<string, unknown> = {}): void {
	gc();
	gc();
	const m = process.memoryUsage();
	const line = {
		mode,
		turn,
		rssMB: +(m.rss / 1048576).toFixed(1),
		heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
		external: +(m.external / 1048576).toFixed(1),
		...extra,
	};
	appendFileSync(outFile, `${JSON.stringify(line)}\n`);
}

writeFileSync(outFile, "");

if (mode === "session" || mode === "session-nocompact") {
	const steps = [];
	for (let i = 0; i < TURNS; i++) {
		steps.push(
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: `yes "$(printf 'x%.0s' $(seq 100))" | head -n 1100; echo turn ${i}` })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(`done ${i}`),
		);
	}
	// session-nocompact: compaction off, so every tool result stays in the session (worst case).
	// session: compaction on (default). The faux 128k window compacts about every 8 turns here.
	const h = await createHarness(mode === "session-nocompact" ? { settings: { compaction: { enabled: false } } } : {});
	h.setResponses(steps);
	for (let i = 0; i < TURNS; i++) {
		await h.session.prompt(`turn ${i}`);
		if (CHECKPOINTS.has(i + 1)) {
			const msgs = h.session.messages as Array<{ role: string; content?: unknown }>;
			const toolChars = msgs
				.filter((m) => m.role === "toolResult")
				.reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);
			checkpoint(i + 1, { messages: msgs.length, retainedToolKB: Math.round(toolChars / 1024) });
		}
	}
	h.cleanup();
} else if (mode === "render") {
	const { initTheme } = await import("../../src/modes/interactive/theme/theme.ts");
	initTheme();
	const { BashExecutionComponent } = await import("../../src/modes/interactive/components/bash-execution.ts");
	const ui = { requestRender() {} } as never;
	const comps: InstanceType<typeof BashExecutionComponent>[] = [];
	for (let i = 0; i < TURNS; i++) {
		const c = new BashExecutionComponent(`head -c 110000 /dev/zero (turn ${i})`, ui);
		for (let k = 0; k < 110; k++) c.appendOutput(CHUNK);
		c.setComplete(0, false);
		comps.push(c);
		c.render(120);
		const start = Math.max(0, comps.length - 30);
		for (let j = start; j < comps.length; j++) {
			comps[j].render(j % 2 === 0 ? 120 : 80);
		}
		if (CHECKPOINTS.has(i + 1)) checkpoint(i + 1, { components: comps.length });
	}
} else {
	throw new Error(`unknown mode ${mode}`);
}
