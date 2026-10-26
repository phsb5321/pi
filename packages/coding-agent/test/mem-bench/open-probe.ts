import { SessionManager } from "../../src/core/session-manager.ts";

const r0 = process.memoryUsage().rss;
const t0 = performance.now();
const sm = SessionManager.open(process.argv[2]);
const t1 = performance.now();
const ctx = sm.buildSessionContext();
const t2 = performance.now();
(globalThis as any).gc?.();
console.log(
	JSON.stringify({
		openMs: +(t1 - t0).toFixed(1),
		buildCtxMs: +(t2 - t1).toFixed(1),
		msgs: ctx.messages.length,
		rssDeltaMB: Math.round((process.memoryUsage().rss - r0) / 1048576),
		heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
	}),
);
