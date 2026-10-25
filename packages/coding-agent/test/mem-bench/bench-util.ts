/**
 * Shared helpers for the mem-bench drivers (tui-bench.ts, interactive-bench.ts). Linux /proc only;
 * other platforms get empty results.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

export const mb = (n: number): number => +(n / 1048576).toFixed(1);

// Linux: anonymous vs file-backed RSS, from /proc/self/smaps_rollup (kB -> MB).
export function smapsRollup(): Record<string, number> {
	const out: Record<string, number> = {};
	try {
		for (const line of readFileSync("/proc/self/smaps_rollup", "utf8").split("\n")) {
			const m = /^(Rss|Anonymous|Private_Dirty|Private_Clean|Shared_Clean|Shared_Dirty):\s+(\d+)\s+kB/.exec(line);
			if (m) out[`${m[1]}MB`] = +(Number(m[2]) / 1024).toFixed(1);
		}
	} catch {
		// not Linux: leave empty
	}
	return out;
}

// BENCH_MAPS=1: every mapping's RSS, classified: [heap] (glibc main arena, brk), large anonymous
// (>= 60 MB reservations: glibc per-thread malloc arenas), other anonymous (V8 pages, buffers,
// misc malloc), file-backed (node binary and shared libraries). Also the 10 largest mappings.
export function mappingBuckets(limit = 10): Record<string, unknown> {
	const maps: Array<{ range: string; perms: string; name: string; sizeKB: number; rssKB: number }> = [];
	try {
		let cur: (typeof maps)[number] | undefined;
		for (const line of readFileSync("/proc/self/smaps", "utf8").split("\n")) {
			const head = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
			if (head) {
				const sizeKB = (parseInt(head[2], 16) - parseInt(head[1], 16)) / 1024;
				cur = { range: `${head[1]}-${head[2]}`, perms: head[3], name: head[4] || "[anon]", sizeKB, rssKB: 0 };
				maps.push(cur);
				continue;
			}
			const rss = /^Rss:\s+(\d+)\s+kB/.exec(line);
			if (rss && cur) cur.rssKB = Number(rss[1]);
		}
	} catch {
		return {};
	}
	const buckets: Record<string, number> = {
		heapMB: 0,
		largeAnonMB: 0,
		largeAnonCount: 0,
		otherAnonMB: 0,
		otherAnonCount: 0,
		fileMB: 0,
	};
	for (const m of maps) {
		const mbv = m.rssKB / 1024;
		if (m.name === "[heap]") buckets.heapMB += mbv;
		else if (m.name === "[anon]" || m.name === "") {
			if (m.sizeKB >= 60 * 1024) {
				buckets.largeAnonMB += mbv;
				if (m.rssKB > 0) buckets.largeAnonCount += 1;
			} else {
				buckets.otherAnonMB += mbv;
				if (m.rssKB > 0) buckets.otherAnonCount += 1;
			}
		} else if (m.name.startsWith("/")) buckets.fileMB += mbv;
		else buckets.otherAnonMB += mbv;
	}
	const top = [...maps]
		.sort((a, b) => b.rssKB - a.rssKB)
		.slice(0, limit)
		.map((m) => ({
			range: m.range,
			perms: m.perms,
			name: m.name.slice(0, 60),
			rssMB: +(m.rssKB / 1024).toFixed(1),
			sizeMB: +(m.sizeKB / 1024).toFixed(1),
		}));
	// Histogram of resident anonymous mappings by size class (KB), to tell V8 pages (256 KB) from malloc chunks.
	const sizeHist: Record<string, { count: number; rssMB: number }> = {};
	for (const m of maps) {
		if (m.rssKB === 0 || !(m.name === "[anon]" || m.name === "")) continue;
		const cls =
			m.sizeKB <= 256
				? "<=256K"
				: m.sizeKB <= 512
					? "<=512K"
					: m.sizeKB <= 2048
						? "<=2M"
						: m.sizeKB <= 60 * 1024
							? "<=60M"
							: ">=60M";
		const e = sizeHist[cls] ?? { count: 0, rssMB: 0 };
		e.count += 1;
		e.rssMB += m.rssKB / 1024;
		sizeHist[cls] = e;
	}
	for (const e of Object.values(sizeHist)) e.rssMB = +e.rssMB.toFixed(1);
	const rounded: Record<string, number> = {};
	for (const [k, v] of Object.entries(buckets)) rounded[k] = +v.toFixed(1);
	return { ...rounded, sizeHist, top };
}

/** One checkpoint record: the full process.memoryUsage() fields, the smaps split, and optional mappings. */
export function memRecord(mode: string, turn: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const m = process.memoryUsage();
	return {
		mode,
		turn,
		rssMB: mb(m.rss),
		heapTotalMB: mb(m.heapTotal),
		heapUsedMB: mb(m.heapUsed),
		externalMB: mb(m.external),
		arrayBuffersMB: mb(m.arrayBuffers),
		nonHeapMB: mb(m.rss - m.heapTotal - m.external),
		smaps: smapsRollup(),
		threads: threadCount(),
		...(process.env.BENCH_MAPS ? { mappings: mappingBuckets() } : {}),
		...extra,
	};
}

/** The viewport controls both benches drive (TuiAltScreen and InteractiveMode's alt-screen ui). */
export interface ViewportControls {
	scrollBy(lines: number): void;
	scrollToTop(): void;
	scrollToBottom(): void;
}

/**
 * One turn's scrolling: three pages up, and on every 10th turn a jump to the top (old messages
 * re-materialise) and back to the bottom (they leave the paint window).
 */
export async function scrollSweep(
	screen: ViewportControls,
	terminal: { rows: number; waitForRender(): Promise<void> },
	turn: number,
): Promise<void> {
	for (let p = 0; p < 3; p++) {
		screen.scrollBy(-terminal.rows);
		await terminal.waitForRender();
	}
	if (turn % 10 === 9) {
		screen.scrollToTop();
		await terminal.waitForRender();
		screen.scrollToBottom();
		await terminal.waitForRender();
	}
}

/**
 * Argument and runtime preamble shared by the benches: `<turns> <out.jsonl>`, a gc() that needs
 * --expose-gc, and the checkpoint turns (the requested final turn is always included).
 */
export function parseBenchArgs(
	usage: string,
	defaultCheckpoints: number[],
): { turns: number; outFile: string; gc: () => void; checkpoints: Set<number> } {
	const [turnsArg, outFile] = process.argv.slice(2);
	const turns = Number(turnsArg ?? 200);
	if (!outFile || !Number.isFinite(turns) || turns < 1) throw new Error(`usage: ${usage} <turns> <out.jsonl>`);
	const gcFn = globalThis.gc;
	if (typeof gcFn !== "function") throw new Error("run with --expose-gc");
	return { turns, outFile, gc: gcFn, checkpoints: new Set([...defaultCheckpoints, turns].filter((t) => t <= turns)) };
}

/**
 * BENCH_SMAPS_DUMP=<prefix>: write the full /proc/self/smaps to <prefix>.t<turn> at each checkpoint.
 * Pair it with an strace run under `setarch -R` (ASLR off) so the addresses match.
 */
export function dumpSmaps(turn: number): void {
	const prefix = process.env.BENCH_SMAPS_DUMP;
	if (!prefix) return;
	try {
		writeFileSync(`${prefix}.t${turn}`, readFileSync("/proc/self/smaps"));
	} catch {
		// not Linux
	}
}

/** Live thread count from /proc/self/task (libuv pool, V8 workers, main). */
export function threadCount(): number {
	try {
		return readdirSync("/proc/self/task").length;
	} catch {
		return 0;
	}
}
