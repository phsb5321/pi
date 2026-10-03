/**
 * in-process-isolation-falsifiers — the adversarial half of the next
 * acceptance battery (p9): cancellation/history/extensions isolation in
 * falsifier style + the no-network invariant.
 *
 *   1. cancel mid-turn -> state intact (no partial rows; session responsive);
 *   2. history ops never leak across sessions;
 *   3. extension registry per-session, no shared-mutable state;
 *   4. NO-NETWORK invariant: the runtime/engine create zero sockets.
 *
 * Reuses contractFixture + the hardened ledger protocol (leading newline:
 * a torn tail can never swallow the next completed write). Synthetic,
 * bounded, no paid calls.
 *
 *   node --experimental-strip-types test/in-process-isolation-falsifiers.ts
 */
import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceCall } from "@earendil-works/chord";
import type { InProcessEngineFactory, InProcessSessionEngine, InProcessSessionIdentity } from "../src/in-process-runtime.ts";
import { createInProcessRuntime } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";
import { Checks, CONTEXT, engineWith, identityFor, metadata, WriterTracker } from "./contract-fixture.ts";

const SELF = new URL(import.meta.url).pathname;
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

/** Per-session extension registry + history ledger + echo engine (synthetic). */
function isolationFactory(ledger: Ledger, tracker: WriterTracker, registries: Map<string, Map<string, unknown>>): InProcessEngineFactory {
	return {
		async open(meta: SessionMetadata, identity: InProcessSessionIdentity) {
			tracker.acquire(meta.id, identity.generation);
			row(ledger, meta.id, 0, "open", `gen:${identity.generation}`);
			let nextSeq = rows(ledger, meta.id).filter((entry) => entry.kind === "write").length + 1;
			const registry = new Map<string, unknown>();
			registries.set(meta.id, registry);
			const base = engineWith(identity, tracker, async () => {
				row(ledger, meta.id, 0, "close", `gen:${identity.generation}`);
			});
			return {
				...base,
				attach: () => ({
					async invokeService(call: ServiceCall, _publish: unknown, context: { abortSignal?: AbortSignal }) {
						const method = String((call as { member?: unknown }).member ?? "");
						const args = (call as { args?: unknown[] }).args ?? [];
						switch (method) {
							case "slow-write": {
								// Long-running op; the battery cancels it mid-flight.
								await new Promise((resolve) => setTimeout(resolve, 500));
								context.abortSignal?.throwIfAborted();
								const seq = nextSeq++;
								row(ledger, meta.id, seq, "write", `slow:${String(args[0] ?? "")}`);
								return { seq };
							}
							case "history-append": {
								const seq = nextSeq++;
								row(ledger, meta.id, seq, "entry", `hist:${meta.id}:${String(args[0] ?? "")}`);
								return { seq };
							}
							case "history-scan": {
								return rows(ledger, meta.id)
									.filter((entry) => entry.kind === "entry")
									.map((entry) => entry.payload);
							}
							case "register": {
								registry.set(String(args[0]), { owner: meta.id, value: args[1] });
								return { size: registry.size };
							}
							case "registry-read": {
								return { keys: [...registry.keys()], owners: [...registry.values()].map((value) => (value as { owner: string }).owner) };
							}
							case "echo":
								return { echoed: args[0] };
							case "status": {
								const entries = rows(ledger, meta.id);
								const seqs = entries.filter((entry) => entry.kind === "write").map((entry) => entry.seq);
								return {
									rows: entries.length,
									writes: seqs.length,
									duplicates: seqs.filter((seq, index) => seqs.indexOf(seq) !== index),
									entries: entries.filter((entry) => entry.kind === "entry").length,
								};
							}
							default:
								return undefined;
						}
					},
					release: async () => undefined,
				}),
			} satisfies InProcessSessionEngine;
		},
	};
}

const checks = new Checks();
const ledger: Ledger = { path: join("/tmp", `isolation-falsifiers-${process.pid}`) };
mkdirSync(ledger.path, { recursive: true });

// ── 4. NO-NETWORK invariant: instrument socket creation for the whole run ────
let socketAttempts = 0;
const originalConnect = net.connect;
const originalCreateConnection = net.createConnection;
// biome-ignore lint/suspicious/noExplicitAny: runtime instrumentation of the node API
(net as any).connect = (...args: unknown[]) => {
	socketAttempts += 1;
	// biome-ignore lint/suspicious/noExplicitAny: pass-through
	return (originalConnect as any)(...args);
};
// biome-ignore lint/suspicious/noExplicitAny: runtime instrumentation of the node API
(net as any).createConnection = (...args: unknown[]) => {
	socketAttempts += 1;
	// biome-ignore lint/suspicious/noExplicitAny: pass-through
	return (originalCreateConnection as any)(...args);
};

async function main(): Promise<void> {
	const tracker = new WriterTracker();
	const registries = new Map<string, Map<string, unknown>>();
	const { host, control } = createInProcessRuntime(isolationFactory(ledger, tracker, registries), { maxSessions: 12 });

	// 1. cancel mid-turn -> state intact.
	const cancelHandle = await host.openSession(metadata("iso-cancel"), CONTEXT);
	const cancelAttach = await cancelHandle.attachClient(CONTEXT);
	const controller = new AbortController();
	const cancelled = cancelAttach
		.invokeService(
			{ serviceId: "iso", member: "slow-write", args: ["doomed"] } as unknown as ServiceCall,
			async () => undefined,
			{ ...CONTEXT, abortSignal: controller.signal },
		)
		.then(() => "completed")
		.catch(() => "aborted");
	setTimeout(() => controller.abort(), 50);
	const outcome = await cancelled;
	checks.check("cancel: mid-turn op aborted, not completed", outcome === "aborted");
	const afterCancel = (await cancelAttach.invokeService(
		{ serviceId: "iso", member: "status", args: [] } as unknown as ServiceCall,
		async () => undefined,
		CONTEXT,
	)) as { rows: number; writes: number; duplicates: number[] };
	checks.check(
		"cancel: no partial row, session state intact",
		afterCancel.duplicates.length === 0 && afterCancel.writes === 0 && afterCancel.rows >= 1,
	);
	const echoAfter = (await cancelAttach.invokeService(
		{ serviceId: "iso", member: "echo", args: ["alive"] } as unknown as ServiceCall,
		async () => undefined,
		CONTEXT,
	)) as { echoed: string };
	checks.check("cancel: session responsive after cancellation", echoAfter.echoed === "alive");

	// 2. history ops never leak across sessions.
	const historyA = await (await host.openSession(metadata("iso-hist-a"), CONTEXT)).attachClient(CONTEXT);
	const historyB = await (await host.openSession(metadata("iso-hist-b"), CONTEXT)).attachClient(CONTEXT);
	for (let i = 0; i < 5; i++) {
		await historyA.invokeService({ serviceId: "iso", member: "history-append", args: [`a-${i}`] } as unknown as ServiceCall, async () => undefined, CONTEXT);
		await historyB.invokeService({ serviceId: "iso", member: "history-append", args: [`b-${i}`] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	}
	const scanA = (await historyA.invokeService({ serviceId: "iso", member: "history-scan", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as string[];
	const scanB = (await historyB.invokeService({ serviceId: "iso", member: "history-scan", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as string[];
	checks.check(
		"history: A's scan contains only A's entries",
		scanA.length === 5 && scanA.every((payload) => payload.startsWith("hist:iso-hist-a:")),
	);
	checks.check(
		"history: B's scan contains only B's entries",
		scanB.length === 5 && scanB.every((payload) => payload.startsWith("hist:iso-hist-b:")),
	);
	checks.check(
		"history: no cross-session leakage in either direction",
		scanA.every((payload) => !payload.includes("iso-hist-b")) && scanB.every((payload) => !payload.includes("iso-hist-a")),
	);

	// 3. extension registry per-session, no shared-mutable state.
	const extA = await (await host.openSession(metadata("iso-ext-a"), CONTEXT)).attachClient(CONTEXT);
	const extB = await (await host.openSession(metadata("iso-ext-b"), CONTEXT)).attachClient(CONTEXT);
	await extA.invokeService({ serviceId: "iso", member: "register", args: ["alpha", 1] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	const readA = (await extA.invokeService({ serviceId: "iso", member: "registry-read", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { keys: string[]; owners: string[] };
	const readB = (await extB.invokeService({ serviceId: "iso", member: "registry-read", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { keys: string[]; owners: string[] };
	checks.check("extensions: A's registry has the registered key", readA.keys.includes("alpha") && readA.owners.every((owner) => owner === "iso-ext-a"));
	checks.check("extensions: B's registry unaffected by A's registration", readB.keys.length === 0);
	checks.check("extensions: registries are distinct objects (no shared-mutable state)", registries.get("iso-ext-a") !== registries.get("iso-ext-b"));

	// Cap case on a DEDICATED capped runtime (refusal not queue).
	const capTracker = new WriterTracker();
	let capRefused = 0;
	const capped = createInProcessRuntime(isolationFactory(ledger, capTracker, registries), {
		maxSessions: 2,
		onEngineRefused: () => {
			capRefused += 1;
		},
	});
	const outcomes = await Promise.allSettled([
		capped.host.openSession(metadata("iso-cap-1"), CONTEXT),
		capped.host.openSession(metadata("iso-cap-2"), CONTEXT),
		capped.host.openSession(metadata("iso-cap-3"), CONTEXT),
		capped.host.openSession(metadata("iso-cap-4"), CONTEXT),
	]);
	const admitted = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
	checks.check("cap: exactly maxSessions admitted under concurrent opens", admitted === 2);
	checks.check("cap: the rest refused and recorded (not queued)", capRefused === 2);
	await capped.control.shutdown(CONTEXT);
	checks.check(
		"cap: writer released exactly once per admitted engine",
		capTracker.releasedExactlyOnce() && capTracker.releases.size === capTracker.acquisitions.size,
	);

	await control.shutdown(CONTEXT);
	checks.check("writers: released exactly once per engine", tracker.releasedExactlyOnce() && tracker.releases.size === tracker.acquisitions.size);

	// 4. NO-NETWORK invariant (asserted LAST so the whole battery is covered).
	checks.check("no-network invariant: zero socket attempts in the battery", socketAttempts === 0);

	checks.finish("ISOLATION FALSIFIERS");
}

await main();
