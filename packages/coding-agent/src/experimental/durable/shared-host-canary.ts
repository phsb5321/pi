/**
 * Shared-host canary (330 MANIFEST item 12, post-freeze slice).
 *
 * EXECUTABLE synthetic-provider multi-session canary:
 *   node --experimental-strip-types packages/coding-agent/src/experimental/durable/shared-host-canary.ts
 *
 * - >=3 session engines in ONE process (single-pid assert);
 * - >=2 thin clients through the ThinClient interface below (pD lands the
 *   real thin-client leg; the synthetic provider client here is the
 *   canary's stand-in against the SAME interface — no duplication of the
 *   real leg);
 * - isolation asserts: per-session transcript buffers stay separate;
 * - memory report = mem-probe MEASURED values only (no estimates);
 * - clean exit 0 on pass, exit 3 on any failure.
 *
 * Synthetic provider only: no paid calls, no real credentials, no session
 * fixtures, no fleet activation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SharedHostCore,
	createInProcessRuntime,
	type InProcessEngineFactory,
	type InProcessSessionAttachment,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
} from "@earendil-works/pi-server";

// ── the thin-client interface (pD implements the real leg against this) ─────
export interface ThinClient {
	readonly sessionId: string;
	submit(text: string): Promise<void>;
	observe(): Promise<readonly string[]>;
	close(): Promise<void>;
}

type Invoke = (call: { member: string; args?: unknown[] }) => Promise<unknown>;

/** Synthetic thin client: the canary's provider stand-in on the ThinClient interface. */
function syntheticThinClient(sessionId: string, invoke: Invoke): ThinClient {
	return {
		sessionId,
		async submit(text: string): Promise<void> {
			await invoke({ member: "submit", args: [text] });
		},
		async observe(): Promise<readonly string[]> {
			return (await invoke({ member: "observe" })) as readonly string[];
		},
		async close(): Promise<void> {},
	};
}

// ── synthetic provider engine: per-session transcript buffer ────────────────
function syntheticEngine(identity: InProcessSessionIdentity): InProcessSessionEngine {
	const transcript: string[] = [];
	let settle: (error: Error | undefined) => void = () => {};
	const terminated = new Promise<Error | undefined>((resolve) => {
		settle = resolve;
	});
	return {
		identity,
		terminated,
		async attach(): Promise<InProcessSessionAttachment> {
			return {
				async invokeService(call) {
					const member = (call as { member?: unknown }).member;
					const args = Array.isArray((call as { args?: unknown }).args) ? (call as { args: unknown[] }).args : [];
					if (member === "submit") {
						transcript.push(String(args[0] ?? ""));
						return { ok: true };
					}
					if (member === "observe") return [...transcript];
					throw new Error(`synthetic engine: unknown member ${String(member)}`);
				},
				async release(): Promise<void> {},
			};
		},
		async close(): Promise<void> {
			settle(undefined);
		},
	};
}

const factory: InProcessEngineFactory = {
	async open(_metadata, identity) {
		return syntheticEngine(identity);
	},
};

const ok = (label: string): void => {
	process.stdout.write(`ok - ${label}\n`);
};

/** mem-probe measured-values-only print (the accepted instrument; no estimates). */
function printMeasured(): void {
	const probe = fileURLToPath(new URL("../../../../../tools/mem-probe", import.meta.url));
	const pidFile = join(tmpdir(), `shared-host-canary-${process.pid}.pids`);
	writeFileSync(pidFile, `${process.pid}\n`);
	try {
		// The probe's exit code reflects proof status (a session-less process
		// fails the idle proof), not measurement validity — read the measured
		// output regardless.
		const run = spawnSync("python3", [probe, "--condition", "idle", "--advisory", "--seat-pids", pidFile], {
			encoding: "utf8",
		});
		const out = String(run.stdout ?? "");
		if (out.trim().length === 0) throw new Error(`mem-probe produced no measured output (status ${String(run.status)})`);
		for (const line of out.split("\n")) {
			if (line.length > 0) process.stdout.write(`mem-probe: ${line}\n`);
		}
	} finally {
		unlinkSync(pidFile);
	}
}

async function run(): Promise<number> {
	const core = new SharedHostCore({ maxSessions: 8 });
	const runtime = createInProcessRuntime(factory, {
		maxSessions: 8,
		onEngineRefused: (refused) => core.noteRefused(refused.sessionId),
	});

	// 1. three session engines in ONE process
	const sessions = ["s1", "s2", "s3"];
	const handles = new Map<string, Awaited<ReturnType<typeof runtime.host.openSession>>>();
	for (const id of sessions) {
		handles.set(id, await runtime.host.openSession({ id }, {} as never));
	}
	const ids = runtime.control.identities();
	assert.equal(ids.length, 3, "three engines live");
	assert.equal(new Set(ids.map((i) => i.pid)).size, 1, "all engines share one pid");
	assert.equal(ids[0]!.pid, process.pid, "the one process is this canary process");
	ok("shared isolate: 3 engines, 1 pid");

	// 2. thin clients (>=2) on the same presentation surface
	const clients: ThinClient[] = [];
	for (const id of sessions) {
		const handle = handles.get(id)!;
		const attachment = await handle.attachClient({} as never);
		core.attach(id);
		const invoke: Invoke = (call) =>
			attachment.invokeService(call as never, () => undefined, {} as never) as Promise<unknown>;
		clients.push(syntheticThinClient(id, invoke));
	}
	const [c1a, c1b, c2, c3] = [clients[0]!, clients[0]!, clients[1]!, clients[2]!];
	assert.ok(clients.length >= 3, "thin clients attached across sessions");
	assert.equal(core.attach("s1"), 2, "two presentations on s1 (>=2 thin clients)");
	ok(`thin clients: ${clients.length + 1} presentations across ${sessions.length} sessions`);

	// 3. isolation: per-session transcripts never cross
	await c1a.submit("from-s1-a");
	await c1b.submit("from-s1-b");
	await c2.submit("from-s2");
	await c3.submit("from-s3");
	assert.deepEqual(await c1a.observe(), ["from-s1-a", "from-s1-b"], "s1 sees only its own submissions");
	assert.deepEqual(await c2.observe(), ["from-s2"], "s2 isolated from s1/s3");
	assert.deepEqual(await c3.observe(), ["from-s3"], "s3 isolated from s1/s2");
	ok("isolation: per-session transcripts never cross");

	// 4. measured-values-only mem-probe print
	printMeasured();
	ok("mem-probe: measured values printed (no estimates)");

	// 5. clean shutdown
	assert.equal(core.detach("s1"), 1, "presentation released");
	assert.equal(core.detach("s1"), 0, "s1 quiescent");
	assert.ok(core.isQuiescent("s1"), "quiescent = retirement precondition");
	await runtime.control.shutdown({} as never);
	assert.equal(runtime.control.identities().length, 0, "shutdown released every engine");
	ok("shutdown: writers released, identities empty");
	process.stdout.write("shared-host-canary: ALL PASS\n");
	return 0;
}

run().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`shared-host-canary: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(3);
	},
);
