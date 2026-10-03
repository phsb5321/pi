/**
 * in-process-pre-pilot-battery2 — acceptance battery 2, the CONTRACT/HAPPY
 * half (p4). Items on the frozen composition (005 seam):
 *
 *   1. cancellation/history/extensions isolation — positive path: a session's
 *      cancel flow works cleanly and touches only its own in-flight op; history
 *      ops (list/scan/clear) work per session; the extension registry works per
 *      session with distinct registries (p9's adversarial counterpart lives in
 *      in-process-isolation-falsifiers.ts).
 *   2. SDK/application-owned host services — one app-owned service instance
 *      (serverServices seam) serves every session; its shared surface (boot id)
 *      is identical for all sessions while its per-session state never crosses.
 *   3. native NO-NETWORK canary run — the 330 canary executed under a kernel
 *      network namespace (unshare -Urn: no usable interfaces), exit 0 =
 *      provider-free invariant for the hosted shape.
 *   4. process-tree memory contract — hosted shape = ONE host pid tree (one
 *      process, N sessions, no per-session processes), measured by mem-probe
 *      whole-tree per seat from OUTSIDE the tree (PSS+SwapPss, MiB = kb/1024,
 *      measured-only). Asserted: NPROC = 1 and TOTAL below the class bound
 *      (nominal class 46.8 MiB; bound 128 MiB).
 *
 * Synthetic only; bounded; public fixtures; no paid calls; no live seats.
 *
 *   node --experimental-strip-types test/in-process-pre-pilot-battery2.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceCall } from "@earendil-works/chord";
import type { InProcessEngineFactory, InProcessSessionIdentity } from "../src/in-process-runtime.ts";
import { createInProcessRuntime } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";
import { Checks, CONTEXT, engineWith, metadata, WriterTracker } from "./contract-fixture.ts";

const SELF = new URL(import.meta.url).pathname;
const MEM_PROBE = "/home/notroot/Documents/Code/pi-upstream/tools/mem-probe";
const NO_NETWORK_CANARY = "/home/notroot/Documents/Code/pi-upstream-330-shared-host/packages/coding-agent/src/experimental/durable/shared-host-canary.ts";
const MEMORY_CLASS_BOUND_MIB = 128; // nominal class 46.8 MiB (canary measurement)

// ── app-owned host service (serverServices seam: one instance per host) ────
type AppService = { bootId: string; hits: number; notes: Map<string, Map<string, string>> };
const newAppService = (): AppService => ({ bootId: "app-boot-1", hits: 0, notes: new Map() });

// ── per-session engine: cancel / history / extensions + app service routing ─
function sessionStateFactory(app: AppService): InProcessEngineFactory {
	const tracker = new WriterTracker();
	return {
		async open(meta: SessionMetadata, identity: InProcessSessionIdentity) {
			tracker.acquire(meta.id, identity.generation);
			const transcript: string[] = [];
			const extensions = new Map<string, unknown>();
			let cancelled = false;
			const base = engineWith(identity, tracker);
			return {
				...base,
				attach: () => ({
					async invokeService(call: ServiceCall) {
						const request = call as unknown as { serviceId?: string; member?: string; args?: unknown[] };
						const member = String(request.member ?? "");
						const args = (request.args ?? []) as string[];
						// serverServices seam: the app-owned service is carried by
						// the engine dispatch and keyed by the CALLING session's
						// identity — per-session state, shared app surface.
						if (request.serviceId === "app-notes") {
							app.hits += 1;
							if (member === "boot") return app.bootId;
							let store = app.notes.get(meta.id);
							if (!store) {
								store = new Map();
								app.notes.set(meta.id, store);
							}
							if (member === "put") {
								store.set(String(args[0]), String(args[1]));
								return true;
							}
							if (member === "get") return store.get(String(args[0])) ?? null;
							return undefined;
						}
						if (member === "submit") {
							transcript.push(String(args[0]));
							return transcript.length;
						}
						if (member === "observe") return [...transcript];
						if (member === "history") {
							const op = String(args[0]);
							if (op === "list") return [...transcript];
							if (op === "scan") return transcript.filter((entry) => entry.startsWith(String(args[1])));
							if (op === "clear") {
								transcript.length = 0;
								return 0;
							}
							return undefined;
						}
						if (member === "longOp") {
							for (let step = 0; step < 60; step++) {
								if (cancelled) return { completed: false, cancelled: true, rows: transcript.length };
								await new Promise((resolve) => setTimeout(resolve, 5));
							}
							transcript.push("longop-done");
							return { completed: true, cancelled: false, rows: transcript.length };
						}
						if (member === "cancel") {
							cancelled = true;
							return { cancelled: true };
						}
						if (member === "attachAppService") {
							// Overlay (p9 case 2, mirrored): application-owned services are
							// attached by the application, never by an engine — fail closed.
							throw new Error("application-owned");
						}
						if (member === "registerExtension") {
							extensions.set(String(args[0]), { config: String(args[1]) });
							return { registryId: `${meta.id}#registry`, registered: [...extensions.keys()] };
						}
						if (member === "getExtension") return extensions.get(String(args[0])) ?? null;
						if (member === "listExtensions") return [...extensions.keys()];
						return undefined;
					},
					release: async () => undefined,
				}),
			};
		},
	};
}

type Session = { id: string; invoke: (call: { serviceId?: string; member: string; args?: unknown[] }) => Promise<unknown> };

async function openSessions(count: number, app: AppService): Promise<{ control: Awaited<ReturnType<typeof createInProcessRuntime>>["control"]; sessions: Session[] }> {
	const runtime = createInProcessRuntime(sessionStateFactory(app), { maxSessions: Math.max(count, 4) });
	const sessions: Session[] = [];
	for (let index = 0; index < count; index++) {
		const id = `bat2-s${index + 1}`;
		const handle = await runtime.host.openSession(metadata(id), CONTEXT);
		const attachment = await handle.attachClient(CONTEXT);
		sessions.push({
			id,
			invoke: (call) => attachment.invokeService({ ...call } as unknown as ServiceCall, async () => undefined, CONTEXT),
		});
	}
	return { control: runtime.control, sessions };
}

// ── child mode: the hosted shape for the memory contract ────────────────────
if (process.argv[2] === "--mem-shape") {
	const app = newAppService();
	const { sessions } = await openSessions(3, app);
	for (const session of sessions) {
		await session.invoke({ member: "submit", args: [`mem-${session.id}`] });
	}
	console.log(`READY ${JSON.stringify({ pid: process.pid, sessions: sessions.length })}`);
	for (let round = 0; round < 1500; round++) {
		for (const session of sessions) await session.invoke({ member: "submit", args: [`mem-${session.id}-r${round}`] });
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	process.exit(0);
}

// ── parent battery ──────────────────────────────────────────────────────────
const checks = new Checks();

async function item1and2(): Promise<void> {
	const app = newAppService();
	const { control, sessions } = await openSessions(3, app);
	const [s1, s2, s3] = sessions as [Session, Session, Session];

	// 1a. cancellation: long op in flight in all three; cancel ONLY s2.
	await s1.invoke({ member: "submit", args: ["tag-s1"] });
	await s2.invoke({ member: "submit", args: ["tag-s2"] });
	await s3.invoke({ member: "submit", args: ["tag-s3"] });
	const ops = Promise.all([s1, s2, s3].map((session) => session.invoke({ member: "longOp" }) as Promise<{ completed: boolean; cancelled: boolean; rows: number }>));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const cancelResult = (await s2.invoke({ member: "cancel" })) as { cancelled: boolean };
	const [r1, r2, r3] = (await ops) as Array<{ completed: boolean; cancelled: boolean; rows: number }>;
	checks.check("cancel: s2 cancel flow clean (op aborted, state intact)", cancelResult.cancelled && r2.cancelled && !r2.completed);
	checks.check("cancel: s2 responsive after cancel and committed state intact", ((await s2.invoke({ member: "history", args: ["list"] })) as string[]).join(",") === "tag-s2");
	checks.check("cancel: s1/s3 ops complete unaffected", r1.completed && r3.completed && !r1.cancelled && !r3.cancelled);

	// 1b. history ops per session (list/scan/clear stay own-session).
	const h1 = (await s1.invoke({ member: "history", args: ["list"] })) as string[];
	const h2 = (await s2.invoke({ member: "history", args: ["scan", "tag-"] })) as string[];
	checks.check("history: per-session list/scan return own rows only", h1.every((entry) => entry.startsWith("tag-s1") || entry === "longop-done") && h2.join(",") === "tag-s2");
	await s1.invoke({ member: "history", args: ["clear"] });
	const h1cleared = (await s1.invoke({ member: "history", args: ["list"] })) as string[];
	const h2after = (await s2.invoke({ member: "history", args: ["list"] })) as string[];
	const h3after = (await s3.invoke({ member: "history", args: ["list"] })) as string[];
	checks.check("history: clear s1 leaves s1 empty and s2/s3 intact", h1cleared.length === 0 && h2after.length > 0 && h3after.length > 0);

	// 1c. extension registry per session, distinct registries, same-name safe.
	const reg1 = (await s1.invoke({ member: "registerExtension", args: ["ext-a", "cfg-s1"] })) as { registryId: string };
	const reg2 = (await s2.invoke({ member: "registerExtension", args: ["ext-a", "cfg-s2"] })) as { registryId: string };
	const g1 = (await s1.invoke({ member: "getExtension", args: ["ext-a"] })) as { config: string } | null;
	const g2 = (await s2.invoke({ member: "getExtension", args: ["ext-a"] })) as { config: string } | null;
	const l3 = (await s3.invoke({ member: "listExtensions" })) as string[];
	checks.check("extensions: registry works per session and is distinct", reg1.registryId !== reg2.registryId && reg1.registryId.startsWith("bat2-s1"));
	checks.check("extensions: same-name registrations stay per-session", g1?.config === "cfg-s1" && g2?.config === "cfg-s2");
	checks.check("extensions: s3 registry sees no foreign registrations", l3.length === 0);

	// 2. app-owned host service: shared surface + per-session state, no leaks.
	const boots = await Promise.all([s1, s2, s3].map((session) => session.invoke({ serviceId: "app-notes", member: "boot" })));
	await s1.invoke({ serviceId: "app-notes", member: "put", args: ["k", "v1"] });
	await s1.invoke({ serviceId: "app-notes", member: "put", args: ["only-s1", "mine"] });
	await s2.invoke({ serviceId: "app-notes", member: "put", args: ["k", "v2"] });
	const g1k = await s1.invoke({ serviceId: "app-notes", member: "get", args: ["k"] });
	const g2k = await s2.invoke({ serviceId: "app-notes", member: "get", args: ["k"] });
	const leak = await s2.invoke({ serviceId: "app-notes", member: "get", args: ["only-s1"] });
	const leak3 = await s3.invoke({ serviceId: "app-notes", member: "get", args: ["k"] });
	checks.check("serverServices: one shared app surface (same boot id for all sessions)", boots.every((boot) => boot === app.bootId));
	checks.check("serverServices: per-session state isolated (k = v1 / v2 by owner)", g1k === "v1" && g2k === "v2");
	checks.check("serverServices: no cross-session reads (s2/s3 see no foreign keys)", leak === null && leak3 === null);
	checks.check("serverServices: single service instance carried the calls", app.hits >= 8 && app.notes.size === 3);

	await control.shutdown(CONTEXT);
}

// Combined overlay for items 1-2 in ONE host (p9's case bodies mirrored on
// this member protocol; source: 005 test/in-process-battery2-adversarial.ts,
// which self-executes on import — semantics mirrored, file untouched).
async function item12Overlay(): Promise<void> {
	const app = newAppService();
	const { control, sessions } = await openSessions(2, app);
	const [a, b] = sessions as [Session, Session];
	// p9 1a: A's mid-turn cancel races B's concurrent history work.
	const aOp = a.invoke({ member: "longOp" }) as Promise<{ completed: boolean; cancelled: boolean }>;
	const bWork = (async () => {
		const seen: string[] = [];
		for (let round = 0; round < 10; round++) {
			await b.invoke({ member: "submit", args: ["hist:race-b:b-1"] });
			seen.push(...((await b.invoke({ member: "history", args: ["scan", "hist:race-b:"] })) as string[]));
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return seen;
	})();
	await new Promise((resolve) => setTimeout(resolve, 10));
	await a.invoke({ member: "cancel" });
	const [aResult, bScan] = (await Promise.all([aOp, bWork])) as [{ completed: boolean; cancelled: boolean }, string[]];
	checkOverlay("race: A's mid-turn cancel aborted, not completed", aResult.cancelled && !aResult.completed);
	const aState = (await a.invoke({ member: "history", args: ["list"] })) as string[];
	checkOverlay("race: A's state intact after cancellation", aState.every((entry) => entry !== "longop-done"));
	checkOverlay("race: B's concurrent work unaffected by A's cancel", new Set(bScan).size === 1 && bScan[0] === "hist:race-b:b-1");
	// p9 1b: forged cross-session history payload never lands in B's scan.
	await a.invoke({ member: "submit", args: ["hist:race-b:forged"] });
	const bScan2 = (await b.invoke({ member: "history", args: ["scan", "hist:race-b:"] })) as string[];
	checkOverlay("corruption: forged cross-session payload never appears in B's scan", !bScan2.includes("hist:race-b:forged"));
	await a.invoke({ member: "registerExtension", args: ["ext-x", "cfg-a"] });
	await b.invoke({ member: "registerExtension", args: ["ext-x", "cfg-b"] });
	const ga = (await a.invoke({ member: "getExtension", args: ["ext-x"] })) as { config: string } | null;
	const gb = (await b.invoke({ member: "getExtension", args: ["ext-x"] })) as { config: string } | null;
	checkOverlay("collision: same-name extensions keep per-session values", ga?.config === "cfg-a" && gb?.config === "cfg-b");
	// p9 2: engine refuses app-owned service attach (fail closed).
	let refused = false;
	try {
		await a.invoke({ member: "attachAppService", args: [] });
	} catch (error) {
		refused = String(error).includes("application-owned");
	}
	checkOverlay("serverServices: engine refuses app-owned service attach (fail closed)", refused);
	await control.shutdown(CONTEXT);
}

let overlayFailures = 0;
function checkOverlay(label: string, condition: boolean): void {
	if (condition) {
		console.log(`PASS overlay: ${label}`);
		return;
	}
	overlayFailures += 1;
	console.error(`FAIL overlay: ${label}`);
}

function item3(): void {
	const run = spawnSync("unshare", ["-Urn", process.execPath, "--experimental-strip-types", NO_NETWORK_CANARY], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const allPass = output.includes("shared-host-canary: ALL PASS");
	checks.check("no-network: canary ran under unshare -Urn (no usable network)", run.status !== null);
	checks.check("no-network: canary ALL PASS with network denied (provider-free invariant)", run.status === 0 && allPass);
	console.log(`NONET ${JSON.stringify({ exit: run.status, allPass })}`);
}

async function item4(): Promise<void> {
	// Contract: hosted shape = ONE host pid tree (one process, N sessions),
	// measured by mem-probe whole-tree per seat from outside the tree.
	console.log(
		`CONTRACT hosted-shape memory: one pid tree = one process hosting N sessions; mem-probe whole-tree per seat (PSS+SwapPss, MiB=kb/1024, measured-only); assert NPROC=1 and TOTAL < ${MEMORY_CLASS_BOUND_MIB} MiB (nominal class 46.8 MiB).`,
	);
	const child = spawn(process.execPath, ["--experimental-strip-types", SELF, "--mem-shape"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	const ready = await new Promise<{ pid: number; sessions: number }>((resolve) => {
		const started = Date.now();
		const poll = () => {
			const match = stdout.match(/^READY (.+)$/m);
			if (match) resolve(JSON.parse(match[1]!));
			else if (Date.now() - started > 15_000) resolve({ pid: child.pid ?? -1, sessions: 0 });
			else setTimeout(poll, 25);
		};
		poll();
	});
	const scratch = join("/tmp", `battery2-mem-${process.pid}`);
	mkdirSync(scratch, { recursive: true });
	const pidsFile = join(scratch, "seat.pids");
	writeFileSync(pidsFile, `${ready.pid}\n`);
	const probe = spawnSync("python3", [MEM_PROBE, "--condition", "idle", "--advisory", "--seat-pids", pidsFile], { encoding: "utf8", timeout: 30_000 });
	const probeOut = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
	child.kill("SIGTERM");
	const seatRow = probeOut.split("\n").find((line) => new RegExp(`^\\s*${ready.pid}\\s`).test(line));
	const fields = (seatRow ?? "").trim().split(/\s+/);
	const nproc = Number(fields[2]);
	const pss = Number(fields[3]);
	const total = Number(fields[5]);
	const version = (probeOut.match(/(mem-probe v[\d.]+)/) ?? [])[1] ?? "unknown";
	const measured = [nproc, pss, total].every((value) => Number.isFinite(value) && value >= 0);
	checks.check("memory contract: measured values present (measured-only, no estimates)", measured && probeOut.includes("summary:"));
	checks.check("memory contract: hosted tree is ONE process (NPROC = 1, probe outside the tree)", nproc === 1);
	checks.check(`memory contract: TOTAL within class bound (< ${MEMORY_CLASS_BOUND_MIB} MiB)`, Number.isFinite(total) && total > 0 && total < MEMORY_CLASS_BOUND_MIB);
	checks.check("memory contract: N sessions hosted (3) in the measured process", ready.sessions === 3);
	console.log(`MEMCONTRACT ${JSON.stringify({ pid: ready.pid, nproc, pssMiB: pss, totalMiB: total, version, bound: MEMORY_CLASS_BOUND_MIB })}`);
}

const started = Date.now();
await item1and2();
await item12Overlay();
item3();
await item4();
if (overlayFailures > 0) {
	console.error(`PRE-PILOT BATTERY-2 (contract half): ${overlayFailures} OVERLAY FAILURE(S)`);
	process.exit(1);
}
console.log(`NOTE wall-ms=${Date.now() - started} (synthetic only; no paid calls; battery-2 contract half)`);
checks.finish("PRE-PILOT BATTERY-2 (contract half)");
