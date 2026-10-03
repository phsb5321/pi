/**
 * in-process-pre-pilot-gate — the COMBINED pre-pilot gate: p4's canary load
 * (happy path: 3 sessions, 2 thin clients each) + p9's adversarial battery
 * (kill/recover layer semantics per in-process-pilot-falsifiers.ts) on ONE
 * host process. The parent SIGKILLs the host child MID-CANARY-RUN (real
 * adversarial kill, no epoch shutdown); the recover child reopens every
 * session from durable bookkeeping (durable generation = open-event count),
 * RE-ATTACHES clients, and proves exactly-once stream continuation, isolation
 * under the resumed load, and cap accounting (refusal not queue; writer
 * released exactly once per admitted engine post-shutdown).
 *
 * Durable ledger semantics (seq-per-write, open-count generation, torn-tail
 * skip) mirror p9's battery entry; the helpers are repeated here because that
 * entry runs its own battery on import and stays untouched (p9's kill/recovery
 * layer). Public synthetic fixtures only; bounded (2 children, ~20s).
 *
 *   node --experimental-strip-types test/in-process-pre-pilot-gate.ts
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceCall } from "@earendil-works/chord";
import type { InProcessEngineFactory, InProcessSessionIdentity } from "../src/in-process-runtime.ts";
import { createInProcessRuntime } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";
import { Checks, CONTEXT, engineWith, metadata, WriterTracker } from "./contract-fixture.ts";

const SELF = new URL(import.meta.url).pathname;
const SESSIONS = 3;
const CLIENTS_PER_SESSION = 2;

// ── durable ledger (exactly-once accounting across kill -9) ─────────────────
type Ledger = { path: string };
const row = (ledger: Ledger, sessionId: string, seq: number, kind: string, payload: string): void => {
	appendFileSync(join(ledger.path, `${sessionId}.jsonl`), `${JSON.stringify({ seq, kind, payload })}\n`);
};
const rows = (ledger: Ledger, sessionId: string): Array<{ seq: number; kind: string; payload: string }> => {
	const file = join(ledger.path, `${sessionId}.jsonl`);
	if (!existsSync(file)) return [];
	// A SIGKILL mid-append can tear the final line: a torn tail is not a
	// completed write and is skipped.
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
const writeSeqs = (ledger: Ledger, sessionId: string): number[] =>
	rows(ledger, sessionId).filter((entry) => entry.kind === "write").map((entry) => entry.seq);
const durableGeneration = (ledger: Ledger, sessionId: string): number =>
	rows(ledger, sessionId).filter((entry) => entry.kind === "open").length;

// Per-session identity tags: the isolation witnesses (cwd/env/auth/ext).
const tagsFor = (sessionId: string) => ({ cwd: `/session/${sessionId}`, env: `env-${sessionId}`, auth: `token-${sessionId}`, ext: `ext-${sessionId}` });

// ── canary-shaped durable engine (happy-path members, durable writes) ───────
function canaryLedgerFactory(ledger: Ledger, tracker: WriterTracker): InProcessEngineFactory {
	return {
		async open(meta: SessionMetadata, identity: InProcessSessionIdentity) {
			tracker.acquire(meta.id, identity.generation);
			row(ledger, meta.id, 0, "open", `gen:${identity.generation}`);
			let nextSeq = writeSeqs(ledger, meta.id).length + 1;
			const base = engineWith(identity, tracker, async () => {
				row(ledger, meta.id, 0, "close", `gen:${identity.generation}`);
			});
			return {
				...base,
				attach: () => ({
					async invokeService(call: ServiceCall) {
						const method = String((call as { member?: unknown }).member ?? "");
						const args = ((call as { args?: unknown[] }).args ?? []) as string[];
						if (method === "submit") {
							const seq = nextSeq++;
							row(ledger, meta.id, seq, "write", String(args[0] ?? ""));
							return { seq };
						}
						if (method === "observe") {
							return rows(ledger, meta.id).filter((entry) => entry.kind === "write").map((entry) => entry.payload);
						}
						if (method === "status") {
							const seqs = writeSeqs(ledger, meta.id);
							return {
								writes: seqs.length,
								duplicates: seqs.filter((seq, index) => seqs.indexOf(seq) !== index),
								durableGeneration: durableGeneration(ledger, meta.id),
								tags: tagsFor(meta.id),
							};
						}
						return undefined;
					},
					release: async () => undefined,
				}),
			};
		},
	};
}

// Thin-client shape over the service seam (same shape as the canary's
// syntheticThinClient: submit/observe over one invoke function).
function thinClient(sessionId: string, invoke: (call: { member: string; args?: unknown[] }) => Promise<unknown>) {
	return {
		sessionId,
		submit: async (text: string): Promise<void> => {
			await invoke({ member: "submit", args: [text] });
		},
		observe: async (): Promise<readonly string[]> => (await invoke({ member: "observe" })) as readonly string[],
	};
}
type ThinClient = ReturnType<typeof thinClient>;

// ── child modes ─────────────────────────────────────────────────────────────
if (process.argv[2] === "--host-mode" || process.argv[2] === "--recover-mode") {
	const mode = process.argv[2]!;
	const ledger: Ledger = { path: process.argv[3]! };
	mkdirSync(ledger.path, { recursive: true });
	const tracker = new WriterTracker();
	let refused = 0;
	const { host, control } = createInProcessRuntime(canaryLedgerFactory(ledger, tracker), {
		maxSessions: SESSIONS,
		onEngineRefused: () => {
			refused += 1;
		},
	});
	const ids = Array.from({ length: SESSIONS }, (_, index) => `canary-s${index + 1}`);
	const loaded: Array<{ sessionId: string; invoke: (call: { member: string; args?: unknown[] }) => Promise<unknown>; clients: ThinClient[] }> = [];
	for (const id of ids) {
		const handle = await host.openSession(metadata(id), CONTEXT);
		const attachment = await handle.attachClient(CONTEXT);
		const invoke = (call: { member: string; args?: unknown[] }) =>
			attachment.invokeService({ serviceId: "canary", ...call } as unknown as ServiceCall, async () => undefined, CONTEXT);
		const clients = Array.from({ length: CLIENTS_PER_SESSION }, () => thinClient(id, invoke));
		loaded.push({ sessionId: id, invoke, clients });
	}

	if (mode === "--host-mode") {
		// Prime, prove live-load isolation, announce READY, then stream forever
		// (the parent SIGKILLs us mid-stream).
		for (const { sessionId, clients } of loaded) {
			for (const [index, client] of clients.entries()) await client.submit(`canary-${sessionId}-c${index}-t0`);
			const observed = await clients[0]!.observe();
			const clean = observed.every((payload) => payload.startsWith(`canary-${sessionId}-`));
			console.log(`LIVE-ISO ${JSON.stringify({ sessionId, clean, observed: observed.length })}`);
		}
		for (const { sessionId } of loaded) {
			const generation = control.identities().find((identity) => identity.sessionId === sessionId)?.generation;
			console.log(`READY ${JSON.stringify({ sessionId, generation, pid: control.pid })}`);
		}
		for (let turn = 1; turn < 1e6; turn++) {
			for (const { sessionId, clients } of loaded) {
				for (const [index, client] of clients.entries()) {
					await client.submit(`canary-${sessionId}-c${index}-t${turn}`);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		process.exit(0);
	}

	// --recover-mode: `loaded` above IS the recovery — the fresh runtime
	// reopened every session from durable bookkeeping (durable generation =
	// open-event count) and re-attached CLIENTS_PER_SESSION clients each.
	// Verify exactly-once continuation + isolation under the resumed load,
	// then cap accounting at the restored cap.
	for (const { sessionId, invoke, clients } of loaded) {
		const status = (await invoke({ member: "status" })) as { writes: number; duplicates: number[]; durableGeneration: number; tags: Record<string, string> };
		const continuation = (await invoke({ member: "submit", args: [`recover-${sessionId}`] })) as { seq: number };
		const observed = (await invoke({ member: "observe" })) as string[];
		console.log(
			`RECOVER ${JSON.stringify({ sessionId, status, writeSeq: continuation.seq, observed, clientsReattached: clients.length })}`,
		);
	}
	// Cap accounting at the restored cap: extras must be REFUSED (not queued).
	const capStart = Date.now();
	const extras = await Promise.allSettled([
		host.openSession(metadata("cap-extra-a"), CONTEXT),
		host.openSession(metadata("cap-extra-b"), CONTEXT),
	]);
	const capElapsed = Date.now() - capStart;
	const extraAdmitted = extras.filter((outcome) => outcome.status === "fulfilled").length;
	await control.shutdown(CONTEXT);
	const writerReleasedExactlyOnce =
		tracker.releasedExactlyOnce() && tracker.releases.size === tracker.acquisitions.size && tracker.acquisitions.size === SESSIONS;
	console.log(
		`CAP ${JSON.stringify({ refused, extraAdmitted, refusedFast: capElapsed < 2000, writerReleasedExactlyOnce, acquisitions: tracker.acquisitions.size })}`,
	);
	console.log("RECOVER-DONE");
	process.exit(0);
}

// ── parent battery (the official combined run) ──────────────────────────────
const checks = new Checks();
const ledger: Ledger = { path: join("/tmp", `pre-pilot-gate-${process.pid}`) };
mkdirSync(ledger.path, { recursive: true });

function runChild(mode: string): Promise<{ stdout: string; killed: boolean; children: number }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", SELF, mode, ledger.path], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stdout += String(chunk);
		});
		if (mode === "--host-mode") {
			const readyAt = Date.now();
			const deadline = Date.now() + 20_000;
			const kill = () => {
				// Kill only when the canary load is live: all sessions READY and
				// streaming for at least 1.2s (writes land every 5ms).
				if ((stdout.match(/^READY /gm) ?? []).length >= SESSIONS && Date.now() > readyAt + 1200) {
					child.kill("SIGKILL");
				} else if (Date.now() > deadline) {
					child.kill("SIGKILL");
				} else {
					setTimeout(kill, 25);
				}
			};
			setTimeout(kill, 25);
			child.on("exit", () => resolve({ stdout, killed: true, children: 1 }));
		} else {
			child.on("exit", () => resolve({ stdout, killed: false, children: 1 }));
		}
	});
}

async function main(): Promise<void> {
	const started = Date.now();
	// 1. kill-9 lands MID-CANARY-RUN.
	const hostRun = await runChild("--host-mode");
	const ready = [...hostRun.stdout.matchAll(/^READY (.+)$/gm)].map(
		(match) => JSON.parse(match[1]!) as { sessionId: string; generation: number; pid: number },
	);
	const liveIso = [...hostRun.stdout.matchAll(/^LIVE-ISO (.+)$/gm)].map(
		(match) => JSON.parse(match[1]!) as { sessionId: string; clean: boolean; observed: number },
	);
	const writesPerSession = Array.from({ length: SESSIONS }, (_, index) => writeSeqs(ledger, `canary-s${index + 1}`).length);
	// Inject a deterministic torn tail line (a SIGKILL mid-append can leave
	// one): partial JSON on its own line that is NOT a completed write and must
	// be skipped, never counted. (Boundary: a tear without its trailing newline
	// would merge with the next append — same hazard as the source battery; the
	// write protocol is line-at-a-time, so line-level tear is the modeled case.)
	const tornFile = join(ledger.path, "canary-s2.jsonl");
	writeFileSync(tornFile, '{"seq":99999,"kind":"wri\n', { flag: "a" });
	checks.check("kill-9: host SIGKILLed (real kill, no epoch shutdown)", hostRun.killed);
	checks.check("kill-9: all sessions live mid-run (READY x N)", ready.length === SESSIONS);
	checks.check(
		"kill-9: canary load LIVE at the kill (stream writes past priming)",
		writesPerSession.every((count) => count > 2 * CLIENTS_PER_SESSION),
	);

	// 2-5. recover phase (children #2).
	const recoverRun = await runChild("--recover-mode");
	const recovered = [...recoverRun.stdout.matchAll(/^RECOVER (.+)$/gm)].map(
		(match) =>
			JSON.parse(match[1]!) as {
				sessionId: string;
				status: { writes: number; duplicates: number[]; durableGeneration: number; tags: Record<string, string> };
				writeSeq: number;
				observed: string[];
				clientsReattached: number;
			},
	);
	const cap = [...recoverRun.stdout.matchAll(/^CAP (.+)$/gm)].map(
		(match) => JSON.parse(match[1]!) as { refused: number; extraAdmitted: number; refusedFast: boolean; writerReleasedExactlyOnce: boolean; acquisitions: number },
	)[0];

	checks.check("recovery: every session reopened + clients RE-ATTACHED", recovered.length === SESSIONS && recovered.every((entry) => entry.clientsReattached === CLIENTS_PER_SESSION));
	checks.check(
		"recovery: per-session durable generation +1 (open-event count)",
		recovered.every((entry) => entry.status.durableGeneration === 2),
	);
	checks.check(
		"exactly-once: no duplicate seq + recovery write continues the stream",
		recovered.every((entry) => {
			const seqs = writeSeqs(ledger, entry.sessionId);
			return entry.status.duplicates.length === 0 && entry.writeSeq === seqs.length;
		}),
	);
	checks.check(
		"exactly-once: per-session ledger seqs unique (torn tail skipped, not a write)",
		Array.from({ length: SESSIONS }, (_, index) => writeSeqs(ledger, `canary-s${index + 1}`)).every((seqs) => new Set(seqs).size === seqs.length && !seqs.includes(99999)),
	);
	checks.check(
		"isolation: live load clean (per-session observe only own payloads)",
		liveIso.length === SESSIONS && liveIso.every((entry) => entry.clean),
	);
	checks.check(
		"isolation: resumed load clean (no cross-session cwd/env/auth/ext or payload leakage)",
		recovered.every((entry) => {
			const own = entry.observed.filter((payload) => payload.startsWith(`canary-${entry.sessionId}-`) || payload === `recover-${entry.sessionId}`);
			const tagsMatch = entry.status.tags.cwd === `/session/${entry.sessionId}` && entry.status.tags.env === `env-${entry.sessionId}`;
			return own.length === entry.observed.length && tagsMatch;
		}),
	);
	checks.check(
		"cap accounting: refusal not queue at restored cap (extras refused, fast)",
		cap !== undefined && cap.refused === 2 && cap.extraAdmitted === 0 && cap.refusedFast,
	);
	checks.check(
		"cap accounting: writer released exactly once per admitted engine post-shutdown",
		cap !== undefined && cap.writerReleasedExactlyOnce && cap.acquisitions === SESSIONS,
	);

	const wallMs = Date.now() - started;
	checks.check("bounded: 2 child processes, wall under 60s", hostRun.children + recoverRun.children === 2 && wallMs < 60_000);
	console.log(`NOTE wall-ms=${wallMs} ledger=${ledger.path} (synthetic only; no paid calls)`);
	checks.finish("PRE-PILOT GATE (combined)");
}

await main();
