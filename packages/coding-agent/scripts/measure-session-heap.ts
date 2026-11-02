/**
 * Heap cost of resuming a large session, with and without cold message payloads.
 *
 *   node --expose-gc --import ./src/experimental/source-resolver.ts scripts/measure-session-heap.ts [runs] [sizeMB]
 *
 * Builds one fixture (default 20 MB, compaction near the end so most history is older than the last
 * compaction), then loads it in fresh child processes alternating PI_SESSION_COLD_CONTENT=1 / 0 and
 * reports the mean heapUsed difference with a 95% confidence interval (Welch, normal 1.96 approximation
 * widened to t for small n).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/core/session-manager.ts";

const MIB = 1024 * 1024;

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function payload(seed: number, bytes: number): string {
	let text = "";
	while (text.length < bytes) text += `${seed.toString(36)}:${Math.imul(seed, 2654435761 + text.length) >>> 0} lorem ipsum dolor sit amet, `;
	return text.slice(0, bytes);
}

function buildFixture(dir: string, targetMb: number): string {
	const session = SessionManager.create(dir, dir);
	const entryBytes = 64 * 1024;
	const count = Math.ceil((targetMb * MIB) / entryBytes);
	const keepFrom = Math.floor(count * 0.92);
	let keptId = "";
	for (let i = 0; i < count; i++) {
		if (i === keepFrom) {
			keptId = session.appendMessage({ role: "user", content: payload(i, entryBytes), timestamp: Date.now() });
			session.appendCompaction("summary of earlier work", keptId, 100_000);
			continue;
		}
		if (i % 3 === 0) {
			session.appendMessage({ role: "user", content: payload(i, entryBytes), timestamp: Date.now() });
		} else if (i % 3 === 1) {
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: payload(i, entryBytes) }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "fixture",
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			});
		} else {
			session.appendMessage({
				role: "toolResult",
				toolCallId: `call_${i}`,
				toolName: "bash",
				content: [{ type: "text", text: payload(i, entryBytes / 2) }],
				details: { fullOutput: payload(i + 1, entryBytes / 2) },
				isError: false,
				timestamp: Date.now(),
			});
		}
	}
	return session.getSessionFile()!;
}

function child(file: string): void {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (!gc) throw new Error("run with --expose-gc");
	gc();
	const before = process.memoryUsage().heapUsed;
	const session = SessionManager.open(file);
	// Hold the context a resumed session actually builds, so hot entries are counted.
	const context = session.buildSessionContext();
	gc();
	gc();
	const after = process.memoryUsage().heapUsed;
	console.log(JSON.stringify({ heapMiB: (after - before) / MIB, messages: context.messages.length }));
}

function stats(values: number[]): { mean: number; variance: number } {
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
	return { mean, variance };
}

// Two-sided 97.5% Student-t quantiles for df 1..30, then the normal value.
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

function run(): void {
	const runs = Number(process.argv[2] ?? 12);
	const sizeMb = Number(process.argv[3] ?? 20);
	const dir = mkdtempSync(join(tmpdir(), "session-heap-"));
	try {
		const file = buildFixture(dir, sizeMb);
		console.log(`fixture ${(statSync(file).size / MIB).toFixed(1)} MiB at ${file}`);
		const arms: Record<string, number[]> = { cold: [], plain: [] };
		for (let i = 0; i < runs; i++) {
			for (const [arm, flag] of [
				["cold", "1"],
				["plain", "0"],
			] as const) {
				const result = spawnSync(
					process.execPath,
					["--expose-gc", "--import", "./src/experimental/source-resolver.ts", process.argv[1], "--child", file],
					{ env: { ...process.env, PI_SESSION_COLD_CONTENT: flag }, encoding: "utf8" },
				);
				if (result.status !== 0) throw new Error(result.stderr);
				arms[arm].push(JSON.parse(result.stdout.trim().split("\n").pop()!).heapMiB);
			}
		}
		const cold = stats(arms.cold);
		const plain = stats(arms.plain);
		const diff = cold.mean - plain.mean;
		const se = Math.sqrt(cold.variance / runs + plain.variance / runs);
		const df = 2 * runs - 2;
		const t = df <= 30 ? T975[df - 1] : 1.96;
		console.log(`plain heap: ${plain.mean.toFixed(2)} MiB  cold heap: ${cold.mean.toFixed(2)} MiB  (n=${runs} per arm)`);
		console.log(`cold - plain = ${diff.toFixed(2)} MiB, 95% CI [${(diff - t * se).toFixed(2)}, ${(diff + t * se).toFixed(2)}]`);
		process.exitCode = diff + t * se < 0 ? 0 : 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--child") child(process.argv[3]);
else run();
