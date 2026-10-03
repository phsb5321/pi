/**
 * 005-shared-runtime falsifiers (p9) — inject contract-violating engine
 * factories into the REAL in-process runtime and assert the runtime
 * rejects/records. Attack surface per p4's MANIFEST: the engine factory
 * seam + InProcessRuntimeControl.identities()/shutdown(). Classes:
 * pid mismatch (hard reject), child-spawn engines (pid check), double
 * writer (factory contract + tracker), stale slot on shutdown (the bug
 * class p4's acceptance already caught), generation ABA, capacity refusal.
 *
 * Standalone like in-process-acceptance.ts:
 *   node --experimental-strip-types packages/server/test/in-process-falsifiers.ts
 * Public synthetic fixtures only; no real session/credential corpora; no
 * live seat kill/reload; no paid calls; bounded.
 */
import { spawn } from "node:child_process";
import type { InProcessEngineFactory } from "../src/in-process-runtime.ts";
import { Checks, CONTEXT, engineWith, identityFor, metadata, WriterTracker } from "./contract-fixture.ts";
import { createInProcessRuntime } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";

const checks = new Checks();
function check(label: string, condition: boolean): void {
	checks.check(label, condition);
}



/** Shared falsifier fixture: exclusive-ownership tracker + contract factory. */
function contractFixture(opts: { doubleAcquire?: boolean; enginePid?: number } = {}): {
	tracker: WriterTracker;
	factory: InProcessEngineFactory;
} {
	const tracker = new WriterTracker();
	const factory: InProcessEngineFactory = {
		async open(meta, identity) {
			tracker.acquire(meta.id, identity.generation);
			if (opts.doubleAcquire) tracker.acquire(meta.id, identity.generation);
			const engineIdentity = opts.enginePid === undefined ? identity : identityFor(meta.id, identity.generation, opts.enginePid);
			return engineWith(engineIdentity, tracker);
		},
	};
	return { tracker, factory };
}

async function main(): Promise<void> {
	// 1. pid mismatch = hard reject.
	{
		const { factory } = contractFixture({ enginePid: process.pid + 1 });
		const { host } = createInProcessRuntime(factory, { maxSessions: 4 });
		let rejected = false;
		try {
			await host.openSession(metadata("pid-mismatch"), CONTEXT);
		} catch (error) {
			rejected = String(error).includes("violated the in-process contract");
		}
		check("pid mismatch: runtime hard-rejects the engine", rejected);
	}

	// 2. child-spawn engine (the contract forbids it; the pid check is the fence).
	{
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		const { factory } = contractFixture({ enginePid: child.pid ?? process.pid + 2 });
		const { host } = createInProcessRuntime(factory, { maxSessions: 4 });
		let rejected = false;
		try {
			await host.openSession(metadata("child-spawn"), CONTEXT);
		} catch (error) {
			rejected = String(error).includes("violated the in-process contract");
		}
		check("child-spawn engine: rejected by the in-process pid contract", rejected);
		child.kill("SIGKILL");
	}

	// 3. double writer: the contract layer must surface the violation.
	{
		const { factory } = contractFixture({ doubleAcquire: true });
		const { host, control } = createInProcessRuntime(factory, { maxSessions: 4 });
		let surfaced = false;
		try {
			await host.openSession(metadata("double-writer"), CONTEXT);
		} catch (error) {
			surfaced = String(error).includes("double writer acquisition");
		}
		check("double writer: violation surfaces at open (no silent sharing)", surfaced);
		check("double writer: no engine identity recorded", control.identities().length === 0);
		await control.shutdown(CONTEXT);
	}

	// 4. stale slot on shutdown (the caught bug class) + release accounting.
	{
		const { tracker, factory } = contractFixture();
		const { host, control } = createInProcessRuntime(factory, { maxSessions: 4 });
		await host.openSession(metadata("stale-a"), CONTEXT);
		await host.openSession(metadata("stale-b"), CONTEXT);
		check("stale-slot: two engines admitted", control.identities().length === 2);
		await control.shutdown(CONTEXT);
		check("stale-slot: identities empty after shutdown", control.identities().length === 0);
		const released = [...tracker.releases.entries()].filter(([key]) => key.startsWith("stale-"));
		check(
			"stale-slot: writers released exactly once each",
			released.length === 2 && released.every(([, count]) => count === 1),
		);
		// The slot must be reusable: reopening after shutdown admits again (no stale occupancy).
		await host.openSession(metadata("stale-a"), CONTEXT);
		check("stale-slot: slot reusable after shutdown", control.identities().length === 1);
		await control.shutdown(CONTEXT);
	}

	// 5. generation monotonic (no per-id ABA) across reopen.
	{
		const tracker = new WriterTracker();
		const factory: InProcessEngineFactory = {
			async open(meta, identity) {
				tracker.acquire(meta.id, identity.generation);
				const engine = engineWith(identity, tracker);
				return {
					...engine,
					close: async (context: typeof CONTEXT) => {
						tracker.release(meta.id, identity.generation);
						await engine.close(context);
					},
				};
			},
		};
		const { host, control } = createInProcessRuntime(factory, { maxSessions: 4 });
		const generations: number[] = [];
		for (let i = 0; i < 3; i++) {
			await host.openSession(metadata("gen"), CONTEXT);
			generations.push(...control.identities().map((identity) => identity.generation));
			await control.shutdown(CONTEXT);
		}
		const strictlyIncreasing = generations.every((generation, index) => index === 0 || generation > generations[index - 1]!);
		check("generation: strictly increasing across reopen (no ABA)", strictlyIncreasing);
	}

	// 6. capacity refusal is bounded and recorded (REFUSE, not queue).
	{
		let refused: { sessionId: string; reason: string } | undefined;
		const { factory } = contractFixture();
		const { host } = createInProcessRuntime(factory, {
			maxSessions: 1,
			onEngineRefused: (event) => {
				refused = event;
			},
		});
		await host.openSession(metadata("cap-a"), CONTEXT);
		let rejected = false;
		try {
			await host.openSession(metadata("cap-b"), CONTEXT);
		} catch (error) {
			rejected = String(error).length > 0;
		}
		check("capacity: second open refused (not queued)", rejected);
		check("capacity: onEngineRefused recorded", refused?.sessionId === "cap-b" && refused.reason === "at-capacity");
	}

	checks.finish("FALSIFIERS");
}

await main();
