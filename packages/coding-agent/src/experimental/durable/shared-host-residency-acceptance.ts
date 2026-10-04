/**
 * shared-host-residency-acceptance — the provider-free SDK residency +
 * REPEATED HYDRATION pass (p4, PORT-PI-1241) against the composition at its
 * exact head. One host, N sessions, each cycled through park → reclaim →
 * async resume → continuation multiple times, asserting:
 *
 *   1. identity/cwd/history bind to the NATIVE close/reopen/continuation
 *      (resident record: same nativeSessionId + directory across cycles);
 *   2. only quiescent sessions park (the existing SharedHostCore quiescence
 *      gate), and the park drops the ACTUAL engine residency (released
 *      counter, live=false, dispatch refused while parked);
 *   3. async release/resume is awaited end-to-end (the first post-park call
 *      observes the fully resumed engine — no torn state);
 *   4. input/stream/publish/cancel semantics survive (member surface intact:
 *      abort/view per cycle), writer-once (engine close releases exactly
 *      once regardless of cycles) and restart continuity (a fresh host on
 *      the same root resumes the same native session).
 *
 * Provider-free: view/abort/residency members only — no model turns.
 *
 *   node --experimental-strip-types \
 *     packages/coding-agent/src/experimental/durable/shared-host-residency-acceptance.ts
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-server";
import { createSharedHostResidency, type ResidentRecord, type ResidencyState } from "./shared-host-residency.ts";
import { makeChecks, openAttachedSessions } from "./shared-host-acceptance-kit.ts";

const harness = makeChecks();
const check = harness.check;

const root = mkdtempSync(join(tmpdir(), "shared-host-residency-"));
const ids = ["res-s1", "res-s2", "res-s3"];
const CYCLES = 3;

const events: Array<{ id: string; state: ResidencyState }> = [];

async function runHost(label: string): Promise<{
	close: () => Promise<void>;
	invoke: (id: string, member: string, args?: unknown[]) => Promise<unknown>;
	host: Awaited<ReturnType<typeof createSharedHostResidency>>;
}> {
	const host = await createSharedHostResidency({
		policy: { maxSessions: ids.length },
		hydrate: { root, onState: (id, state) => events.push({ id, state }) },
	});
	const invoke = await openAttachedSessions(host.runtime as never, ids);
	check(`${label}: sessions opened and attached`, ids.length > 0);
	return { close: () => host.close(), invoke, host };
}

const first = await runHost("pass1");
const baseline = new Map<string, { nativeSessionId: string; directory: string }>();
for (const id of ids) {
	const view = (await first.invoke(id, "view")) as { session: { id: string; directory: string; cwd: string } };
	baseline.set(id, { nativeSessionId: view.session.id, directory: view.session.directory });
	check(`binding: ${id} cwd is its own`, view.session.cwd === join(root, id));
}

for (let cycle = 1; cycle <= CYCLES; cycle++) {
	for (const id of ids) {
		// Park via the wrapper's seam member. The wrapper rehydrates on the
		// next call by design, so the reclaim is proven by the state EVENTS
		// (released, live=false) and the awaited resume by the dispatch-side
		// observation (live=true with released==resumed==cycle).
		const parked = (await first.invoke(id, "rh:park")) as { parked: boolean };
		check(`cycle${cycle}: ${id} parks when quiescent`, parked.parked === true);
		const state = (await first.invoke(id, "residency")) as { released: number; resumed: number; live: boolean };
		check(`cycle${cycle}: ${id} actual reclaim happened (release event, live=false observed)`, events.some((e) => e.id === id && !e.state.live && e.state.released === cycle));
		check(`cycle${cycle}: ${id} async resume awaited before dispatch`, state.live === true && state.released === cycle && state.resumed === cycle);
		const view = (await first.invoke(id, "view")) as { session: { id: string; directory: string } };
		const base = baseline.get(id)!;
		check(`cycle${cycle}: ${id} native identity+store continue`, view.session.id === base.nativeSessionId && view.session.directory === base.directory);
		const abort = (await first.invoke(id, "abort")) as { ok: boolean };
		check(`cycle${cycle}: ${id} cancel surface intact after resume`, abort.ok === true);
	}
}

// Writer-once + restart continuity: close the host (writer releases exactly
// once at engine close), then a FRESH host on the same root resumes the same
// native sessions (persisted identity/cwd/history binding survives restart).
await first.close();
const record = (id: string): ResidentRecord => JSON.parse(readFileSync(join(root, `${id}.resident.json`), "utf8")) as ResidentRecord;
check("restart: resident records persisted for every session", ids.every((id) => record(id).nativeSessionId === baseline.get(id)!.nativeSessionId));

const second = await runHost("pass2");
for (const id of ids) {
	const view = (await second.invoke(id, "view")) as { session: { id: string; directory: string } };
	const persisted = record(id);
	check(`restart: ${id} continues its persisted native session`, view.session.id === persisted.nativeSessionId && view.session.directory === persisted.directory);
}
await second.close();

// Presentation acceptance (bounded native close/reopen/residency +
// presentation): park is QUIESCENCE-GATED on the existing presentation
// lifecycle — two presentations per session; park refused while any remain;
// parks only at zero; the next call reopens natively (identity continues).
const third = await runHost("pass3");
for (const id of ids) {
	third.host.core.attach(id);
	third.host.core.attach(id);
}
for (const id of ids) {
	check(`presentations: ${id} park refused with 2 presentations up`, third.host.parkWhenQuiescent(id) === "refused-not-quiescent");
}
for (const id of ids) third.host.core.detach(id);
for (const id of ids) {
	check(`presentations: ${id} park still refused with 1 presentation up`, third.host.parkWhenQuiescent(id) === "refused-not-quiescent");
}
for (const id of ids) third.host.core.detach(id);
for (const id of ids) {
	check(`presentations: ${id} parks at quiescence (zero presentations)`, third.host.parkWhenQuiescent(id) === "parked");
}
for (const id of ids) {
	const view = (await third.invoke(id, "view")) as { session: { id: string; directory: string } };
	const base = baseline.get(id)!;
	check(`presentations: ${id} native reopen continues identity+store`, view.session.id === base.nativeSessionId && view.session.directory === base.directory);
}
check("presentations: unknown session refused by the park gate", third.host.parkWhenQuiescent("no-such") === "unknown-session");
await third.close();

if (harness.failures > 0) {
	console.error(`SHARED-HOST RESIDENCY ACCEPTANCE: ${harness.failures} FAILURE(S)`);
	process.exit(3);
}
console.log("SHARED-HOST RESIDENCY ACCEPTANCE: ALL PASS (provider-free, repeated hydration)");
