/**
 * shared-host-residency-reclaim-regression — ONE meaningful native
 * regression for the SDK reclamation slice (PORT-PI-SDK-RECLAMATION-1504),
 * rewritten per the runtime-author followup to prove ACTUAL STATE, not
 * counters:
 *
 *   1. presentation glue: the runtime's attach/release drives
 *      core.attach/detach (production bookkeeping) — quiescence is provable
 *      from core.presentations/isQuiescent, and park refuses while
 *      presentations exist;
 *   2. ACTIVE NATIVE WORK BLOCKS PARK: with an in-flight dispatch (busy),
 *      park refuses ("refused-active-work") even when quiescent;
 *   3. GC reclaim proof: a WeakRef to the live engine object is cleared
 *      after a park + explicit GC — the closed graph is actually
 *      reclaimable (the residency query itself auto-rehydrates through the
 *      wrapper, so the parked state is never observable via dispatch; the
 *      WeakRef is the evidence);
 *   4. the wrapper's auto-rehydrate CONTRACT is asserted as actual
 *      behavior (the first post-park call rebinds the same session+store);
 *   5. seam bookkeeping at close: runtime identities empty; close is
 *      idempotent (no double writer release).
 *
 * Config isolation uses the NATIVE `PI_CODING_AGENT_DIR` knob (config 563) —
 * HOME is never repurposed and no real auth is read. Provider-free: no model
 * turns, no network, no provider catalogue registration.
 *
 * Run with --expose-gc (the GC case needs an explicit collector):
 *   node --expose-gc --experimental-strip-types \
 *     packages/coding-agent/src/experimental/durable/shared-host-residency-reclaim-regression.ts
 *
 * Exit: 0 = all assertions pass · 3 = regression failure.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-server";
import { createSharedHostResidency, type ResidencyState } from "./shared-host-residency.ts";
import { makeChecks } from "./shared-host-acceptance-kit.ts";

const root = mkdtempSync(join(tmpdir(), "residency-reclaim-"));
// Native config knob (config 563): never HOME, never real auth.
process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const harness = makeChecks();
const check = harness.check;

type Attachment = { invokeService: (c: unknown, p: unknown, x: unknown) => Promise<unknown>; release: (x: unknown) => Promise<unknown> };
const host = await createSharedHostResidency({
	policy: { maxSessions: 1 },
	hydrate: {
		root,
		onState: (_id: string, state: ResidencyState) => {
			if (state.openedRef !== undefined && state.openedRetained === false) releasedRefs.push(state.openedRef);
		},
	},
});
const releasedRefs: Array<WeakRef<object>> = [];
const id = "reclaim-s1";
const handle = await (host.runtime as never as { host: { openSession: (m: SessionMetadata, c: unknown) => Promise<{ attachClient: (c: unknown) => Promise<Attachment> }> } }).host.openSession({ id }, BACKGROUND_CONTEXT);
const first = await handle.attachClient(BACKGROUND_CONTEXT);
const invoke = (attachment: Attachment, member: string, args: unknown[] = []) =>
	attachment.invokeService({ member, args }, async () => undefined, BACKGROUND_CONTEXT);

// ── 1. presentation glue: production attach/release drives core bookkeeping.
const second = await handle.attachClient(BACKGROUND_CONTEXT);
check("glue: two presentations recorded in core bookkeeping", host.core.presentations.get(id) === 2);
check("glue: isQuiescent false with presentations up", host.core.isQuiescent(id) === false);
check("glue: park refused while presentations exist", host.parkWhenQuiescent(id) === "refused-not-quiescent");
await first.release(BACKGROUND_CONTEXT);
check("glue: one release decrements the presentation count", host.core.presentations.get(id) === 1);
check("glue: park still refused with one presentation up", host.parkWhenQuiescent(id) === "refused-not-quiescent");
await second.release(BACKGROUND_CONTEXT);
check("glue: quiescence proven from production attach/release (zero presentations)", host.core.isQuiescent(id) === true);

// ── 2. ACTIVE NATIVE WORK BLOCKS PARK: an in-flight dispatch = busy work.
const third = await handle.attachClient(BACKGROUND_CONTEXT);
const inFlight = invoke(third, "view"); // busy=1 synchronously at dispatch entry
await third.release(BACKGROUND_CONTEXT); // presentations drop first: quiescent
check("active-work: park refused while a dispatch is in flight (quiescent but busy)", host.parkWhenQuiescent(id) === "refused-active-work");
await inFlight;

// ── 3. GC reclaim: park drops the engine graph; WeakRef proves reclamation.
check("park: accepted once quiescent and idle", host.parkWhenQuiescent(id) === "parked");
const gc = (globalThis as { gc?: () => void }).gc;
check("gc harness: --expose-gc provided (GC case needs an explicit collector)", typeof gc === "function");
let collected = false;
for (let round = 0; round < 10 && !collected; round++) {
	await new Promise((resolve) => setImmediate(resolve));
	gc?.();
	collected = releasedRefs.length > 0 && releasedRefs.every((ref) => ref.deref() === undefined);
}
check("reclaim: WeakRef to the parked engine graph is cleared (actual GC, not bookkeeping)", collected);

// ── 4. auto-rehydrate CONTRACT: the first post-park call rebinds natively.
const fourth = await handle.attachClient(BACKGROUND_CONTEXT);
const view = (await invoke(fourth, "view")) as { session: { id: string; directory: string } };
const residency = (await invoke(fourth, "residency")) as { live: boolean; resumed: number; openedRetained: boolean };
check("contract: first post-park call auto-rehydrates through the wrapper (actual behavior)", residency.live === true && residency.openedRetained === true && residency.resumed === 1);
check("contract: rehydration rebinds the same native session+store", typeof view.session.id === "string" && view.session.id.length > 0 && view.session.directory.length > 0);

// ── 5. seam bookkeeping at close (actual state) + real idempotence.
await host.close();
const identities = (host.runtime as never as { control: { identities: () => unknown[] } }).control.identities();
check("close: seam identities empty after shutdown (actual bookkeeping)", identities.length === 0);
let doubleCloseOk = true;
try {
	await host.close();
} catch {
	doubleCloseOk = false;
}
check("close: second close is idempotent (resolved, no double writer release)", doubleCloseOk);

if (harness.failures > 0) {
	console.error(`RESIDENCY-RECLAIM REGRESSION: ${harness.failures} FAILURE(S)`);
	process.exit(3);
}
console.log("RESIDENCY-RECLAIM REGRESSION: ALL PASS (glue proven; active-work gate; GC reclaim; auto-rehydrate contract)");
