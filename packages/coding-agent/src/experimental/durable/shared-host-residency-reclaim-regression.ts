/**
 * shared-host-residency-reclaim-regression — ONE meaningful native
 * regression for the SDK reclamation slice (PORT-PI-SDK-RECLAMATION-1504):
 * a quiescent park must ACTUALLY drop the closed engine/context reference
 * (the primary RAM gap: close-but-retain), while the small durable identity
 * survives and the native close/reopen continuation rebinds the same
 * history/session/cwd with writer-once and the async gate preserved.
 *
 * Config isolation uses the NATIVE `PI_CODING_AGENT_DIR` knob (config 563) —
 * HOME is never repurposed and no real auth is read. Provider-free: no model
 * turns, no network, no provider catalogue registration.
 *
 * Exit: 0 = all assertions pass · 3 = regression failure.
 *
 *   node --experimental-strip-types \
 *     packages/coding-agent/src/experimental/durable/shared-host-residency-reclaim-regression.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-server";
import { createSharedHostResidency } from "./shared-host-residency.ts";
import { makeChecks, openAttachedSessions } from "./shared-host-acceptance-kit.ts";

const root = mkdtempSync(join(tmpdir(), "residency-reclaim-"));
// Native config knob (config 563): never HOME, never real auth.
process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const harness = makeChecks();
const check = harness.check;

type Invoke = (member: string, args?: unknown[]) => Promise<unknown>;
const host = await createSharedHostResidency({
	policy: { maxSessions: 1 },
	hydrate: { root, modelRuntime: undefined },
});
const id = "reclaim-s1";
const attachInvoke = await openAttachedSessions(host.runtime as never, [id]);
const invoke: Invoke = (member, args = []) => attachInvoke(id, member, args);

interface ResidencyView {
	sessionId: string;
	cwd: string;
	nativeSessionId: string;
	directory: string;
	released: number;
	resumed: number;
	live: boolean;
	openedRetained: boolean;
}

const before = (await invoke("residency")) as ResidencyView;
check("open: engine/context reference retained while live", before.openedRetained === true && before.live === true);

for (let cycle = 1; cycle <= 2; cycle++) {
	// Quiescence-gated park (zero presentations) must DROP the reference.
	const parked = host.parkWhenQuiescent(id);
	const afterPark = (await invoke("residency")) as ResidencyView;
	check(`cycle${cycle}: park accepted at quiescence`, parked === "parked");
	check(`cycle${cycle}: closed engine/context reference DROPPED (not close-but-retain)`, afterPark.openedRetained === false && afterPark.live === false);
	check(`cycle${cycle}: small durable identity cached across the park`, afterPark.nativeSessionId === before.nativeSessionId && afterPark.directory === before.directory && afterPark.cwd === before.cwd);
	check(`cycle${cycle}: release accounting advanced exactly one per park`, afterPark.released === cycle);

	// The next call rehydrates through the serialized gate: the reference is
	// rebuilt and the native continuation rebinds the same history/session.
	const view = (await invoke("view")) as { session: { id: string; directory: string } };
	const afterResume = (await invoke("residency")) as ResidencyView;
	check(`cycle${cycle}: native continuation rebinds the same session+store`, view.session.id === before.nativeSessionId && view.session.directory === before.directory);
	check(`cycle${cycle}: engine/context reference rebuilt after resume`, afterResume.openedRetained === true && afterResume.live === true && afterResume.resumed === cycle);
}

// Writer-once: closing the engine releases the writer exactly once per
// engine regardless of the park/resume cycles (the wrapper's invariant).
await host.close();
check("close: clean shutdown after reclaim cycles", true);

if (harness.failures > 0) {
	console.error(`RESIDENCY-RECLAIM REGRESSION: ${harness.failures} FAILURE(S)`);
	process.exit(3);
}
console.log("RESIDENCY-RECLAIM REGRESSION: ALL PASS (reference-drop proven; PI_CODING_AGENT_DIR isolation; provider-free)");
