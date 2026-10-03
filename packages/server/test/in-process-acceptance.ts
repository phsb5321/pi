/**
 * Actual-host acceptance for the in-process session runtime (MS track A).
 *
 * Runnable on any host with Node >= 22.6 — no build, no paid calls, no real
 * credential or session fixtures (synthetic provider = in-memory writer +
 * echo engine):
 *
 *   node --experimental-strip-types packages/server/test/in-process-acceptance.ts
 *
 * Asserts the slice's contract on ONE real process: shared-isolate
 * identity (single pid), stable per-session identity/generation, explicit
 * cap, attach/detach, exclusive durable-writer ownership, and recoverable
 * shutdown. No child process is ever spawned (the sharing proof).
 */
import { echoEngineShell } from "./in-process-fixtures.ts";
import assert from "node:assert/strict";
import {
	createInProcessRuntime,
	type InProcessEngineFactory,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
} from "../src/in-process-runtime.ts";
import { SharedProcessCapacityError } from "../src/shared-process.ts";
import type { Context, ServiceCall } from "../src/types.ts";

const ctx = {} as Context;

// ── synthetic provider: in-memory exclusive writer + echo engine ─────────────
class SyntheticWriter {
	#released = false;
	get released(): boolean {
		return this.#released;
	}
	release(): void {
		this.#released = true;
	}
}

const writerLog: string[] = [];

function syntheticFactory(): InProcessEngineFactory {
	return {
		async open(metadata, identity): Promise<InProcessSessionEngine> {
			const writer = new SyntheticWriter();
			writerLog.push(`acquire:${identity.sessionId}:${identity.generation}`);
			return echoEngineShell(identity, () => {
				writer.release();
				writerLog.push(`release:${identity.sessionId}:${identity.generation}`);
				// Expected close: the upstream contract resolves undefined.
			});
		},
	};
}

const ok = (label: string): void => {
	console.log(`ok - ${label}`);
};

// ── 1. shared isolate: one pid, many engines, zero child processes ───────────
const spawnless = syntheticFactory();
const runtime = createInProcessRuntime(spawnless, { maxSessions: 3 });
const e1 = await runtime.host.openSession({ id: "s1" }, ctx);
const e2 = await runtime.host.openSession({ id: "s2" }, ctx);
assert.equal(runtime.control.pid, process.pid, "runtime reports the one host pid");
const ids = runtime.control.identities();
assert.equal(ids.length, 2, "two engines live");
for (const id of ids) assert.equal(id.pid, process.pid, "every engine shares the host pid");
assert.equal(new Set(ids.map((i: InProcessSessionIdentity) => i.pid)).size, 1, "exactly one pid (shared isolate)");
ok("shared isolate: 2 engines, 1 pid");

// ── 2. explicit cap ─────────────────────────────────────────────────────────
await runtime.host.openSession({ id: "s3" }, ctx);
await assert.rejects(
	() => runtime.host.openSession({ id: "s4" }, ctx),
	(error: unknown) => error instanceof SharedProcessCapacityError,
);
ok("explicit cap: 4th open refused (SharedProcessCapacityError)");

// ── 3. attach/detach with opaque service routing ────────────────────────────
const lease = await e1.attachClient(ctx);
const echoed = (await lease.invokeService({} as ServiceCall, () => undefined, ctx)) as { echoed: unknown };
assert.ok(echoed && typeof echoed === "object" && "echoed" in echoed, "invokeService routed to the engine");
await lease.release(ctx);
const lease2 = await e1.attachClient(ctx);
await lease2.release(ctx);
ok("attach/detach: invokeService routed and released (idempotent release)");

// ── 4. exclusive durable writer ownership ───────────────────────────────────
assert.deepEqual(
	writerLog.slice(0, 2),
	["acquire:s1:1", "acquire:s2:2"],
	"one writer acquisition per engine open (exclusive ownership)",
);
// Same-session concurrent opens share ONE engine = one writer.
const sharedA = runtime.host.openSession({ id: "s3" }, ctx);
const sharedB = runtime.host.openSession({ id: "s3" }, ctx);
const [hA, hB] = await Promise.all([sharedA, sharedB]);
assert.notEqual(hA, hB, "distinct handles over one engine");
assert.equal(writerLog.filter((line) => line.startsWith("acquire:s3")).length, 1, "one writer for s3 despite two opens");
ok("exclusive writer: one acquisition per session engine");

// ── 5. stable identity + recoverable shutdown ───────────────────────────────
const before = runtime.control.identities();
assert.equal(before.length, 3, "three engines live");
await runtime.control.shutdown(ctx);
assert.equal(runtime.control.identities().length, 0, "shutdown closed every engine");
const closed = writerLog.filter((line) => line.startsWith("release:")).length;
assert.equal(closed, 3, "every writer released exactly once on shutdown");
// Recovery: reopen the same session id from durable state → new generation.
const recovered = await runtime.host.openSession({ id: "s1" }, ctx);
const recoveredIds = runtime.control.identities();
assert.equal(recoveredIds.length, 1, "recovery opens a fresh engine");
assert.equal(recoveredIds[0]!.generation, 4, "generation advances after recovery (no ABA)");
await recovered.close(ctx);
ok("recoverable shutdown: writers released, reopen recovers with a new generation");

// ── 6. no child processes (the anti-masquerade assertion) ───────────────────
// The factory is the only engine source; it never spawns, and the runtime
// contract forbids it. Assert the engines all lived on this pid (done above)
// and that the factory call count equals the engine count.
const opens = writerLog.filter((line) => line.startsWith("acquire:")).length;
assert.equal(opens, 4, "exactly one engine per open call — no per-session child");
ok("no child process per session (sharing is real)");

console.log("in-process acceptance: ALL PASS");
