import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createReadTool } from "../../src/core/tools/read.ts";

const hwm = () => +readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)![1] >> 10;
const rss = () => process.memoryUsage().rss >> 20;
const gc = (globalThis as any).gc;
// READ_MODE=old routes through custom ops, i.e. the pre-change whole-file algorithm in the same build.
const tool =
	process.env.READ_MODE === "old"
		? createReadTool(process.cwd(), { operations: { readFile: (p) => readFile(p), access: (p) => access(p) } })
		: createReadTool(process.cwd());
gc();
const r0 = rss();
const h0 = hwm();
const t0 = performance.now();
const res = await tool.execute("x", {
	path: process.argv[2],
	offset: process.argv[3] ? Number(process.argv[3]) : undefined,
	limit: process.argv[4] ? Number(process.argv[4]) : undefined,
});
const ms = performance.now() - t0;
gc();
gc();
const text = (res.content[0] as any).text as string;
console.log(
	JSON.stringify({
		mode: process.env.READ_MODE ?? "new",
		ms: +ms.toFixed(0),
		outBytes: text.length,
		rssBefore: r0,
		hwmBefore: h0,
		hwmAfter: hwm(),
		peakDeltaMB: hwm() - h0,
		rssAfterGC: rss(),
		retainedMB: rss() - r0,
	}),
);
