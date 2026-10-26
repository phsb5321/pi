/**
 * Persistence micro-bench (audit B, 25/10/2026): drives the real file-backed SessionManager through
 * <turns> turns of the w7 shape (user prompt, assistant tool call, ~50 KB bash toolResult, assistant text).
 * Prints total wall, per-turn p50/p99 of the synchronous append cost, bytes on disk, and logical bytes.
 *   node --experimental-strip-types test/mem-bench/persist-bench.ts <turns> <dir>
 * Run under `strace -f -c -e trace=%file,%desc` to count syscalls per turn.
 */
import { mkdirSync, statSync } from "node:fs";
import { SessionManager } from "../../src/core/session-manager.ts";

const turns = Number(process.argv[2] ?? 200);
const dir = process.argv[3] ?? "/tmp/persist-bench";
mkdirSync(dir, { recursive: true });
const sm = SessionManager.create(dir, dir);
const line = `${"0".repeat(99)}\n`;
const bashOut = line.repeat(500);
const usage = {
	input: 1000,
	output: 100,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const base = { api: "faux", provider: "faux", model: "faux", usage, timestamp: Date.now() } as const;
const costs: number[] = [];
let logical = 0;
const t0 = performance.now();
for (let t = 0; t < turns; t++) {
	const a = performance.now();
	const msgs = [
		{ role: "user", content: [{ type: "text", text: `turn ${t}: run it` }], timestamp: Date.now() },
		{
			...base,
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: `c${t}`, name: "bash", arguments: { command: "awk ..." } }],
		},
		{
			role: "toolResult",
			toolCallId: `c${t}`,
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: bashOut }],
			timestamp: Date.now(),
		},
		{ ...base, role: "assistant", stopReason: "stop", content: [{ type: "text", text: `done ${t}` }] },
	];
	for (const m of msgs) {
		logical += JSON.stringify(m).length;
		sm.appendMessage(m as any);
	}
	costs.push(performance.now() - a);
}
const wall = performance.now() - t0;
costs.sort((x, y) => x - y);
const file = sm.getSessionFile();
const onDisk = file ? statSync(file).size : 0;
console.log(
	JSON.stringify({
		turns,
		wallMs: +wall.toFixed(1),
		perTurnP50Ms: +costs[Math.floor(turns * 0.5)].toFixed(3),
		perTurnP99Ms: +costs[Math.floor(turns * 0.99)].toFixed(3),
		onDiskBytes: onDisk,
		logicalBytes: logical,
		amplification: +(onDisk / logical).toFixed(3),
		rssMB: Math.round(process.memoryUsage().rss / 1048576),
	}),
);
