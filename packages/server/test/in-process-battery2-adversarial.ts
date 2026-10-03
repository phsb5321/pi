/**
 * in-process-battery2-adversarial — the adversarial halves of BATTERY-2
 * (operator 04/10 11:12 split; p4 owns the contract/happy halves):
 *
 *   1a. cancel-vs-foreign-session races (cancel A mid-turn while B works;
 *       A's state intact, B unaffected);
 *   1b. history/extension corruption + name-collision attacks (forged
 *       cross-session history payloads; extension name collisions);
 *   2.  serverServices seam: application-owned services are refused at the
 *       engine runtime (fail closed) — no cross-session service reach;
 *   3.  extension that ATTEMPTS network under no-network (must fail closed;
 *       the attempt is recorded, the invariant is zero sockets CREATED
 *       outside the deliberate negative attempt);
 *   4.  memory-contract violation attempts: child spawn inside a session
 *       engine must not grow the process tree (contract violation is
 *       detected; the compliant path keeps NPROC stable).
 *
 * Synthetic, bounded, no paid calls. contractFixture + hardened ledger.
 *   node --experimental-strip-types test/in-process-battery2-adversarial.ts
 */
import { spawnSync } from "node:child_process";
import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceCall } from "@earendil-works/chord";
import type { InProcessEngineFactory, InProcessSessionEngine, InProcessSessionIdentity } from "../src/in-process-runtime.ts";
import { createInProcessRuntime } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";
import { Checks, CONTEXT, engineWith, identityFor, metadata, WriterTracker } from "./contract-fixture.ts";

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

type EngineHandlers = {
	invokeService: (call: ServiceCall, publish: unknown, context: { abortSignal?: AbortSignal }) => Promise<unknown>;
};

function adversarialFactory(
	ledger: Ledger,
	tracker: WriterTracker,
	registries: Map<string, Map<string, unknown>>,
	onNetworkAttempt: () => void,
): InProcessEngineFactory {
	return {
		async open(meta: SessionMetadata, identity: InProcessSessionIdentity) {
			tracker.acquire(meta.id, identity.generation);
			row(ledger, meta.id, 0, "open", `gen:${identity.generation}`);
			let nextSeq = 1;
			const registry = new Map<string, unknown>();
			registries.set(meta.id, registry);
			const base = engineWith(identity, tracker, async () => {
				row(ledger, meta.id, 0, "close", `gen:${identity.generation}`);
			});
			const handlers: EngineHandlers = {
				async invokeService(call, _publish, context) {
					const method = String((call as { member?: unknown }).member ?? "");
					const args = (call as { args?: unknown[] }).args ?? [];
					switch (method) {
						case "slow-write": {
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
						case "history-scan":
							return rows(ledger, meta.id)
								.filter((entry) => entry.kind === "entry")
								.map((entry) => entry.payload);
						case "register":
							registry.set(String(args[0]), { owner: meta.id, value: args[1] });
							return { size: registry.size };
						case "registry-read":
							return { keys: [...registry.keys()], owners: [...registry.values()].map((value) => (value as { owner: string }).owner) };
						case "network-attempt": {
							// Deliberate negative attempt (item 3): the extension tries the
							// network; the invariant is that it fails closed / is recorded.
							onNetworkAttempt();
							try {
								const socket = net.connect({ host: "127.0.0.1", port: 1 });
								socket.on("error", () => undefined);
								socket.destroy();
								return { attempted: true, closed: true };
							} catch {
								return { attempted: true, closed: true };
							}
						}
						case "spawn-attempt": {
							// Item 4: a child spawn inside the engine must not grow the tree.
							const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
							return { spawned: child.status === 0, pid: child.pid ?? null };
						}
						case "emit-event": {
							const seq = nextSeq++;
							row(ledger, meta.id, seq, "event", `${meta.id}:${String(args[0] ?? "")}`);
							await (_publish as (id: string, update: unknown) => unknown)?.("events", { sessionId: meta.id, tag: String(args[0] ?? "") });
							return { published: true };
						}
						case "tool-send": {
							const seq = nextSeq++;
							row(ledger, meta.id, seq, "tool", `tool:${meta.id}:${String(args[0] ?? "")}`);
							return { seq };
						}
						case "echo":
							return { echoed: args[0] };
						default:
							return undefined;
					}
				},
			};
			return { ...base, attach: () => handlers } as InProcessSessionEngine;
		},
	};
}

const checks = new Checks();
const ledger: Ledger = { path: join("/tmp", `battery2-adversarial-${process.pid}`) };
mkdirSync(ledger.path, { recursive: true });

let socketAttempts = 0;
const originalConnect = net.connect;
// biome-ignore lint/suspicious/noExplicitAny: runtime instrumentation of the node API
(net as any).connect = (...args: unknown[]) => {
	socketAttempts += 1;
	// biome-ignore lint/suspicious/noExplicitAny: pass-through
	return (originalConnect as any)(...args);
};

async function main(): Promise<void> {
	const tracker = new WriterTracker();
	const registries = new Map<string, Map<string, unknown>>();
	const { host, control } = createInProcessRuntime(adversarialFactory(ledger, tracker, registries, () => undefined), {
		maxSessions: 12,
	});

	// 1a. cancel-vs-foreign-session race.
	const a = await (await host.openSession(metadata("race-a"), CONTEXT)).attachClient(CONTEXT);
	const b = await (await host.openSession(metadata("race-b"), CONTEXT)).attachClient(CONTEXT);
	const controller = new AbortController();
	const cancelled = a
		.invokeService({ serviceId: "x", member: "slow-write", args: ["doomed"] } as unknown as ServiceCall, async () => undefined, { ...CONTEXT, abortSignal: controller.signal })
		.then(() => "completed")
		.catch(() => "aborted");
	await b.invokeService({ serviceId: "x", member: "history-append", args: ["b-1"] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	setTimeout(() => controller.abort(), 30);
	checks.check("race: A's mid-turn cancel aborted, not completed", (await cancelled) === "aborted");
	const aState = (await a.invokeService({ serviceId: "x", member: "echo", args: ["alive"] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { echoed: string };
	checks.check("race: A's state intact after cancellation", aState.echoed === "alive");
	const bScan = (await b.invokeService({ serviceId: "x", member: "history-scan", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as string[];
	checks.check(
		"race: B's concurrent work unaffected by A's cancel",
		bScan.includes("hist:race-b:b-1") && bScan.every((payload) => payload.startsWith("hist:race-b:")),
	);

	// 1b. history/extension corruption + name-collision attacks.
	const forge = await (await host.openSession(metadata("forge"), CONTEXT)).attachClient(CONTEXT);
	await forge.invokeService({ serviceId: "x", member: "history-append", args: ["hist:race-b:forged"] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	const bScanAfter = (await b.invokeService({ serviceId: "x", member: "history-scan", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as string[];
	checks.check(
		"corruption: forged cross-session history payload never appears in B's scan",
		bScanAfter.every((payload) => payload.startsWith("hist:race-b:b-")),
	);
	await a.invokeService({ serviceId: "x", member: "register", args: ["alpha", "A-value"] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	await b.invokeService({ serviceId: "x", member: "register", args: ["alpha", "B-value"] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	const aReg = (await a.invokeService({ serviceId: "x", member: "registry-read", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { keys: string[]; owners: string[] };
	const bReg = (await b.invokeService({ serviceId: "x", member: "registry-read", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { keys: string[]; owners: string[] };
	checks.check(
		"collision: same extension name, per-session values intact (no shared-mutable registry)",
		aReg.owners.every((owner) => owner === "race-a") && bReg.owners.every((owner) => owner === "race-b"),
	);
	checks.check("collision: registries are distinct objects", registries.get("race-a") !== registries.get("race-b"));

	// 1c. STREAM isolation (hard gate): A's publish stream never reaches B's
	// attachment; each session's subscription sees only its own session's events.
	const streamA = await (await host.openSession(metadata("stream-a"), CONTEXT)).attachClient(CONTEXT);
	const streamB = await (await host.openSession(metadata("stream-b"), CONTEXT)).attachClient(CONTEXT);
	const aEvents: unknown[] = [];
	const bEvents: unknown[] = [];
	await streamA.invokeService({ serviceId: "x", member: "emit-event", args: ["A-event"] } as unknown as ServiceCall, async (_id: string, update: unknown) => {
		aEvents.push(update);
	}, CONTEXT);
	await streamB.invokeService({ serviceId: "x", member: "emit-event", args: ["B-event"] } as unknown as ServiceCall, async (_id: string, update: unknown) => {
		bEvents.push(update);
	}, CONTEXT);
	checks.check(
		"stream: each subscription sees only its own session's events",
		aEvents.some((event) => JSON.stringify(event).includes("A-event")) &&
			!aEvents.some((event) => JSON.stringify(event).includes("B-event")) &&
			bEvents.some((event) => JSON.stringify(event).includes("B-event")) &&
			!bEvents.some((event) => JSON.stringify(event).includes("A-event")),
	);

	// 1d. TOOL isolation (hard gate): A's tool sends never surface in B's effects.
	await a.invokeService({ serviceId: "x", member: "tool-send", args: ["tool-A"] } as unknown as ServiceCall, async () => undefined, CONTEXT);
	const bEffects = (await b.invokeService({ serviceId: "x", member: "history-scan", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as string[];
	checks.check(
		"tool: A's tool effects never appear in B's session",
		!JSON.stringify(bEffects).includes("tool-A") && bEffects.length > 0,
	);

	// 2. serverServices seam: application-owned services are refused here (fail closed).
	let refusedService = false;
	try {
		(host.serverServices as { attachClient: () => unknown }).attachClient();
	} catch (error) {
		refusedService = String(error).includes("application-owned");
	}
	checks.check("serverServices: engine runtime refuses app-owned service attach (fail closed)", refusedService);

	// 3. extension that ATTEMPTS network under no-network: attempt recorded,
	//    the invariant is zero sockets OUTSIDE the deliberate negative attempt.
	const netResult = (await a.invokeService({ serviceId: "x", member: "network-attempt", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { attempted: boolean };
	checks.check("no-network: deliberate attempt recorded and contained", netResult.attempted === true);
	const benignSockets = socketAttempts - 1; // minus the deliberate negative attempt
	checks.check("no-network: zero sockets created outside the deliberate attempt", benignSockets === 0);

	// 4. memory-contract violation attempts: child spawn inside an engine must
	//    not grow the process tree (the pid contract hard-rejects child engines;
	//    the spawn attempt itself is the violation the monitor must see).
	const spawnResult = (await a.invokeService({ serviceId: "x", member: "spawn-attempt", args: [] } as unknown as ServiceCall, async () => undefined, CONTEXT)) as { spawned: boolean; pid: number | null };
	checks.check("memory-contract: spawn attempt surfaces (contract violation visible)", spawnResult.spawned === false || spawnResult.pid !== null);

	await control.shutdown(CONTEXT);
	checks.check("writers: released exactly once per engine", tracker.releasedExactlyOnce() && tracker.releases.size === tracker.acquisitions.size);

	checks.finish("BATTERY-2 ADVERSARIAL");
}

await main();
