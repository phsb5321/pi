/**
 * Regression pins for the 005 runtime defects (root review 04/10 01:34).
 * Standalone: node --experimental-strip-types packages/server/test/in-process-runtime-regressions.ts
 *
 * Verified defects (source-read + reproduced before fixing):
 * R1 duplicate onEngineOpen — notified from inner.openSession AND the
 *    decorator's onWorkerOpen (the latter also with the decorator's own
 *    generation = wrong identity). Fixed: one notification point, engine
 *    identity.
 * R2 factory identity validation — only pid was checked; a wrong
 *    sessionId/generation slipped through. Fixed: full identity contract.
 * R3 shutdown racing an in-flight open — the late handle escaped the
 *    tracked map (engine + writer leak, slot held). Fixed: shutdown window
 *    refuses and releases; post-shutdown recovery stays open.
 */
import { echoEngineShell } from "./in-process-fixtures.ts";
import assert from "node:assert/strict";
import {
	createInProcessRuntime,
	type InProcessEngineFactory,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
} from "../src/in-process-runtime.ts";
import type { Context, ServiceCall } from "../src/types.ts";

const ctx = {} as Context;

// Unhandled-rejection hygiene: record escapes instead of dying on them;
// the final assertion proves none occurred.
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
	unhandled.push(reason);
});

function echoEngine(identity: InProcessSessionIdentity, log: string[]): InProcessSessionEngine {
	return echoEngineShell(identity, () => {
		log.push(`release:${identity.sessionId}:${identity.generation}`);
	});
}

const ok = (label: string): void => {
	console.log(`ok - ${label}`);
};

// ── R1: exactly one onEngineOpen per open, carrying the engine identity ─────
{
	const log: string[] = [];
	const opened: InProcessSessionIdentity[] = [];
	const factory: InProcessEngineFactory = {
		async open(_metadata, identity) {
			return echoEngine(identity, log);
		},
	};
	const runtime = createInProcessRuntime(factory, {
		maxSessions: 4,
		onEngineOpen: (identity) => opened.push(identity),
	});
	await runtime.host.openSession({ id: "a" }, ctx);
	await runtime.host.openSession({ id: "b" }, ctx);
	assert.equal(opened.length, 2, `exactly one notification per open (got ${opened.length})`);
	assert.deepEqual(opened.map((i) => i.sessionId), ["a", "b"], "notified sessions in order");
	assert.equal(opened[0]!.generation, 1, "notification carries the engine generation");
	assert.equal(opened[1]!.generation, 2);
	assert.equal(new Set(opened.map((i) => i.pid)).size, 1, "notifications carry the one host pid");
	assert.equal(opened[0]!.pid, process.pid);
	await runtime.control.shutdown(ctx);
	ok("R1: one onEngineOpen per open with engine identity (duplicate fixed)");
}

// ── R2: factory-returned identity is fully validated ────────────────────────
{
	const log: string[] = [];
	const violations: string[] = [];
	const factory: InProcessEngineFactory = {
		async open(_metadata, identity) {
			const mode = _metadata.id;
			const forged: InProcessSessionIdentity =
				mode === "bad-session"
					? { ...identity, sessionId: "not-the-session" }
					: { ...identity, generation: identity.generation + 999 };
			violations.push(mode);
			return echoEngine(forged, log);
		},
	};
	const runtime = createInProcessRuntime(factory, { maxSessions: 4 });
	await assert.rejects(
		async () => runtime.host.openSession({ id: "bad-session" }, ctx),
		(error: unknown) => error instanceof Error && /violated the in-process contract/.test(error.message),
	);
	await assert.rejects(
		async () => runtime.host.openSession({ id: "bad-generation" }, ctx),
		(error: unknown) => error instanceof Error && /violated the in-process contract/.test(error.message),
	);
	assert.deepEqual(violations, ["bad-session", "bad-generation"], "both forgeries attempted");
	assert.equal(log.length, 2, "each forged engine's writer was released on rejection");
	assert.equal(log.filter((line) => line.startsWith("release:")).length, 2);
	assert.equal(runtime.control.identities().length, 0, "no forged engine is recorded");
	ok("R2: forged sessionId/generation rejected (pid-only check replaced)");
}

// ── R3: shutdown refuses and releases an in-flight open ─────────────────────
{
	const log: string[] = [];
	let gate: (() => void) | undefined;
	let gated = false;
	const factory: InProcessEngineFactory = {
		async open(_metadata, identity) {
			if (_metadata.id === "slow" && !gated) {
				gated = true;
				await new Promise<void>((resolve) => {
					gate = resolve;
				});
			}
			return echoEngine(identity, log);
		},
	};
	const runtime = createInProcessRuntime(factory, { maxSessions: 4 });

	const inFlight = runtime.host.openSession({ id: "slow" }, ctx);
	// Give the open a tick to reach the factory gate.
	await Promise.resolve();
	await runtime.control.shutdown(ctx);
	gate!();

	await assert.rejects(
		() => inFlight,
		(error: unknown) => error instanceof Error && /shutting down/.test(error.message),
		"in-flight open is refused when shutdown has begun",
	);
	assert.equal(log.filter((line) => line.startsWith("release:slow")).length, 1, "its writer released exactly once");
	assert.equal(runtime.control.identities().length, 0, "nothing escapes tracking");

	// The shutdown window is not terminal: recovery opens work again.
	const recovered = await runtime.host.openSession({ id: "slow" }, ctx);
	assert.equal(runtime.control.identities().length, 1, "post-shutdown open admitted (recovery)");
	await recovered.close(ctx);
	ok("R3: shutdown vs in-flight open refused + released; recovery preserved");
}

// ── R4: onEngineOpen throwing must not leak the engine/writer ──────────────
{
	const log: string[] = [];
	const factory: InProcessEngineFactory = {
		async open(_metadata, identity) {
			return echoEngine(identity, log);
		},
	};
	let engineOpens = 0;
	const runtime = createInProcessRuntime(factory, {
		maxSessions: 1,
		// Synthetic failing observer: throws only on the FIRST intended open
		// (the leak case); the recovery open must succeed for its assertion.
		onEngineOpen: () => {
			if (++engineOpens === 1) throw new Error("hook boom");
		},
	});
	await assert.rejects(
		async () => runtime.host.openSession({ id: "leak" }, ctx),
		(error: unknown) => error instanceof Error && error.message === "hook boom",
		"notification error propagates to the open",
	);
	assert.equal(log.filter((line) => line.startsWith("release:leak")).length, 1, "its writer was released");
	assert.equal(runtime.control.identities().length, 0, "no leaked engine recorded");
	// The single capacity slot is not consumed by the rejected open.
	const later = await runtime.host.openSession({ id: "next" }, ctx);
	assert.equal(runtime.control.identities().length, 1, "capacity freed after the rejected open");
	await later.close(ctx);
	ok("R4: onEngineOpen throw releases engine+writer and frees capacity");
}

assert.equal(unhandled.length, 0, `no unhandled rejections (got: ${unhandled.map((r) => (r as Error).message).join(", ")})`);
console.log("in-process runtime regressions: ALL PASS");
