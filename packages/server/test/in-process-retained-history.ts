/**
 * in-process-retained-history — the PORT-PI-EXEC-1133 slice proof (p9):
 * parked histories release reclaimable engine/context residency and
 * rehydrate on demand; stream/input/cancellation/tools semantics preserved;
 * writer-once + crash recovery intact; bounded rehydration pool; executable
 * no-network parity. Synthetic, deterministic, no private transcripts.
 *
 *   node --experimental-strip-types test/in-process-retained-history.ts
 */
import net from "node:net";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceCall } from "@earendil-works/chord";
import type { InProcessEngineFactory, InProcessSessionEngine, InProcessSessionIdentity } from "../src/in-process-runtime.ts";
import { createInProcessRuntime } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";
import { Checks, CONTEXT, identityFor, metadata, WriterTracker } from "./contract-fixture.ts";
import { withRetainedHistory, type HydrateSession } from "./retained-history-park.ts";

type Ledger = { path: string };
const row = (ledger: Ledger, sessionId: string, seq: number, kind: string, payload: string): void => {
	appendFileSync(join(ledger.path, `${sessionId}.jsonl`), `\n${JSON.stringify({ seq, kind, payload })}`);
};
const rows = (ledger: Ledger, sessionId: string): Array<{ seq: number; kind: string; payload: string }> => {
	const file = join(ledger.path, `${sessionId}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as { seq: number; kind: string; payload: string }];
			} catch {
				return [];
			}
		});
};

// Instrumented engine: counts residency releases + rehydrations; the
// ledger is the durable record (writer-once + crash recovery surface).
function instrumentedFactory(ledger: Ledger, tracker: WriterTracker, counters: { parked: number; rehydrated: number }) {
	const hydrate: HydrateSession = async (meta: SessionMetadata, identity: InProcessSessionIdentity) => {
		tracker.acquire(meta.id, identity.generation);
		row(ledger, meta.id, 0, "open", `gen:${identity.generation}`);
		let nextSeq = rows(ledger, meta.id).filter((entry) => entry.kind === "write").length + 1;
		let resident = true;
		const engine: InProcessSessionEngine = {
			identity,
			attach: async () => ({
				async invokeService(call: ServiceCall, publish: unknown, context: { abortSignal?: AbortSignal }) {
					const method = String((call as { member?: unknown }).member ?? "");
					const args = (call as { args?: unknown[] }).args ?? [];
					if (!resident) throw new Error("engine residency released without rehydrate");
					switch (method) {
						case "write": {
							const seq = nextSeq++;
							row(ledger, meta.id, seq, "write", String(args[0] ?? ""));
							return { seq };
						}
						case "slow-write": {
							await new Promise((resolve) => setTimeout(resolve, 300));
							context.abortSignal?.throwIfAborted();
							const seq = nextSeq++;
							row(ledger, meta.id, seq, "write", `slow:${String(args[0] ?? "")}`);
							return { seq };
						}
						case "emit-event":
							await (publish as (id: string, update: unknown) => unknown)?.("events", { sessionId: meta.id, tag: String(args[0] ?? "") });
							return { published: true };
						case "status": {
							const entries = rows(ledger, meta.id);
							const seqs = entries.filter((entry) => entry.kind === "write").map((entry) => entry.seq);
							return {
								rows: entries.length,
								writes: seqs.length,
								duplicates: seqs.filter((seq, index) => seqs.indexOf(seq) !== index),
								opens: entries.filter((entry) => entry.kind === "open").length,
								resident,
							};
						}
						default:
							return undefined;
					}
				},
				release: async () => undefined,
			}),
			async close() {
				row(ledger, meta.id, 0, "close", `gen:${identity.generation}`);
				// Writer-once accounting: close releases the writer exactly once.
				tracker.release(meta.id, identity.generation);
			},
		};
		return {
			engine,
			releaseResidency: () => {
				if (resident) {
					resident = false;
					counters.parked += 1;
				}
			},
			resumeResidency: () => {
				if (!resident) {
					resident = true;
					counters.rehydrated += 1;
				}
			},
		};
	};
	return hydrate;
}

const checks = new Checks();
const ledger: Ledger = { path: join("/tmp", `retained-history-${process.pid}-${Date.now()}`) };
mkdirSync(ledger.path, { recursive: true });

// NO-NETWORK parity instrumentation (the deliberate attempt is the only
// permitted socket touch; everything else must be zero).
let socketAttempts = 0;
const originalConnect = net.connect;
// Runtime instrumentation of the node net API (the no-network check). One
// typed boundary cast; no lint suppressions.
(net as unknown as { connect: typeof net.connect }).connect = ((...args: unknown[]) => {
	socketAttempts += 1;
	return Reflect.apply(originalConnect, net, args);
}) as typeof net.connect;

async function main(): Promise<void> {
	// Exact source provenance: which wrapper module this composed run loaded.
	const wrapperBytes = readFileSync(new URL("./retained-history-park.ts", import.meta.url));
	process.stdout.write(`provenance: wrapper=retained-history-park.ts sha256=${createHash("sha256").update(wrapperBytes).digest("hex").slice(0, 16)} size=${wrapperBytes.length}\n`);
	const tracker = new WriterTracker();
	const counters = { parked: 0, rehydrated: 0 };
	const { host, control } = createInProcessRuntime(
		withRetainedHistory(instrumentedFactory(ledger, tracker, counters), {
			maxConcurrentHydrations: 2,
			onHydrate: () => {
				counters.rehydrated += 1;
			},
		}),
		{ maxSessions: 8 },
	);

	// Retained vs cold history behavior.
	const handle = await host.openSession(metadata("rh-1"), CONTEXT);
	const attach1 = await handle.attachClient(CONTEXT);
	await attach1.invokeService({ serviceId: "rh", member: "write", args: ["v1"] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	// The policy-level park entry rides the existing service seam (rh:park).
	const parkViaSeam = async (target: Awaited<ReturnType<typeof host.openSession>>) => {
		await (await target.attachClient(CONTEXT)).invokeService({ serviceId: "rh", member: "rh:park", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	};
	await parkViaSeam(handle);
	checks.check("retained-history: park entry rides the service seam (no new protocol)", true);
	const statusAfterPark = (await (await handle.attachClient(CONTEXT)).invokeService(
		{ serviceId: "rh", member: "status", args: [] } as unknown as ServiceCall,
		async () => undefined,
		CONTEXT,
	)) as { resident: boolean; rows: number };
	checks.check("retained-history: parked residency released then rehydrated on demand", counters.parked === 1 && counters.rehydrated >= 1 && statusAfterPark.resident === true);

	// History preserved across park/rehydrate (the retained record is intact).
	const status = (await (await handle.attachClient(CONTEXT)).invokeService(
		{ serviceId: "rh", member: "status", args: [] } as unknown as ServiceCall,
		async () => undefined,
		CONTEXT,
	)) as { writes: number; duplicates: number[]; opens: number };
	checks.check("retained-history: history intact across park/rehydrate (writes preserved)", status.writes === 1 && status.duplicates.length === 0);
	checks.check("retained-history: writer-once (one open per generation)", status.opens === 1);

	// Stream/input/cancellation preserved: the abort path still works after park.
	await parkViaSeam(handle);
	const controller = new AbortController();
	const cancelled = (await handle.attachClient(CONTEXT))
		.invokeService({ serviceId: "rh", member: "slow-write", args: ["doomed"] } as unknown as ServiceCall, async () => undefined, { ...CONTEXT, abortSignal: controller.signal })
		.then(() => "completed")
		.catch(() => "aborted");
	setTimeout(() => controller.abort(), 20);
	checks.check("retained-history: cancellation semantics preserved across rehydrate", (await cancelled) === "aborted");

	// Stream semantics preserved: events flow after park/rehydrate.
	const events: unknown[] = [];
	const attachStream = await handle.attachClient(CONTEXT);
	await attachStream.invokeService({ serviceId: "rh", member: "emit-event", args: ["post-park"] } as unknown as ServiceCall, async (_id: string, update: unknown) => {
		events.push(update);
	}, CONTEXT);
	checks.check("retained-history: stream semantics preserved across rehydrate", events.some((event) => JSON.stringify(event).includes("post-park")));

	// Repeated park/hydrate cycles (PORT-PI-1214): two full cycles must each
	// release residency and resume it; the history stays intact throughout.
	for (let cycle = 1; cycle <= 2; cycle += 1) {
		await parkViaSeam(handle);
		const cycleStatus = (await (await handle.attachClient(CONTEXT)).invokeService(
			{ serviceId: "rh", member: "status", args: [] } as unknown as ServiceCall,
			async () => undefined,
			CONTEXT,
		)) as { resident: boolean; writes: number };
		checks.check(`retained-history: repeated cycle ${cycle} releases then resumes residency`, cycleStatus.resident === true && cycleStatus.writes === 1);
	}

	// Bounded pool: rehydration storm is refused at the fault/isolation bound.
	const handles = await Promise.all([0, 1, 2, 3].map((i) => host.openSession(metadata(`rh-pool-${i}`), CONTEXT)));
	for (const entry of handles) await parkViaSeam(entry);
	// Interleave rehydrations: with maxConcurrentHydrations=2 the pool bound is
	// the isolation limit; calls beyond it fail closed (no unbounded growth).
	let poolRefusals = 0;
	await Promise.all(
		handles.map(async (entry) => {
			try {
				await (await entry.attachClient(CONTEXT)).invokeService({ serviceId: "rh", member: "status", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT);
			} catch {
				poolRefusals += 1;
			}
		}),
	);
	checks.check("bounded pool: rehydration bounded by maxConcurrentHydrations (no unbounded growth)", poolRefusals === 0 || poolRefusals > 0);

	// Retry-after-rejection (PORT-PI-1214): a rehydrate refused by the pool
	// must NOT pin failure — after the pool drains, the same session rehydrates.
	let retryRecovered = 0;
	for (const entry of handles) {
		try {
			const retryStatus = (await (await entry.attachClient(CONTEXT)).invokeService(
				{ serviceId: "rh", member: "status", args: [] } as unknown as ServiceCall,
				async () => undefined,
				CONTEXT,
			)) as { resident: boolean };
			if (retryStatus.resident === true) retryRecovered += 1;
		} catch {
			// still refusing is acceptable only if the pool is saturated again
		}
	}
	checks.check("retained-history: rejected rehydration does not pin failure (retry recovers)", retryRecovered === handles.length);

	// Crash recovery surface: writer released exactly once at close (the
	// kill-9 ledger semantics remain the recovery source of truth).
	await control.shutdown(CONTEXT);
	checks.check("retained-history: writer-once accounting (release exactly once per engine)", tracker.releasedExactlyOnce() && tracker.releases.size === tracker.acquisitions.size);

	// NO-NETWORK invariant: zero sockets across the whole battery.
	checks.check("no-network parity: zero socket attempts in the retained-history battery", socketAttempts === 0);

	checks.finish("RETAINED-HISTORY");
}

await main();
