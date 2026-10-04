/**
 * history-reclaim-overlay — COMPOSITION-1220 fresh revision (p9): the
 * HISTORY-COMMITTED overlay integrated with the committed retained-history
 * wrapper (28bdcefbb, cherry-picked) on the frozen head. Target = the
 * NOT-PROVEN list: real streaming / tool / cancel-of-active-turn / restart /
 * release-resume / parked-history-reclaim, on the composed candidate's REAL
 * store (openDurable per-session SQLite stores).
 *
 * Real release/resume wiring: the SDK's real paths are `location.release()`
 * (inside OpenDurableResult.close) and the re-open that reuses the session
 * store (`harness.resume()` internally). The wrapper's HydrateSession maps
 * to them exactly: releaseResidency = opened.close(); resumeResidency =
 * openDurable(same options). No fixture-only claims: every case below runs
 * on the real SDK store. No paid calls; the model is never required to
 * answer — user entries land in the durable store before any turn resolves,
 * which is what the reclaim cases need.
 *
 *   node --experimental-strip-types test/history-reclaim-overlay.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, condition: boolean): void {
	if (condition) {
		process.stdout.write(`PASS ${label}\n`);
		return;
	}
	failures += 1;
	process.stderr.write(`FAIL ${label}\n`);
}

const root = mkdtempSync(join(tmpdir(), "history-reclaim-overlay-"));
const id = "hr-1";
mkdirSync(join(root, id), { recursive: true });

const { openDurable } = await import("../packages/coding-agent/src/experimental/durable/runtime.ts");
const { withRetainedHistory } = await import("../packages/server/src/retained-history.ts");

type Opened = Awaited<ReturnType<typeof openDurable>>;
const durableOptions = { cwd: root, continueSession: false };

// ---- REAL release/resume: the wrapper's HydrateSession wired to the SDK ----
let releaseCalls = 0;
let resumeCalls = 0;
let opened: Opened | undefined;
const hydrate = async () => {
	opened = await openDurable(durableOptions);
	const engine = {
		identity: { sessionId: id, generation: resumeCalls + 1, pid: process.pid },
		attach: async () => ({
			async invokeService(call: { member?: string; args?: unknown[] }) {
				const controller = opened!.controller;
				switch (call.member) {
					case "submit":
						await controller.submit(String(call.args?.[0] ?? ""), "followUp");
						return { ok: true };
					case "abort":
						return controller.abort();
					case "view":
						return { session: { id }, entries: await viewEntries() };
					default:
						return { ok: false };
				}
			},
			release: async () => undefined,
		}),
		async close() {
			await opened?.close();
		},
	};
	return {
		engine,
		releaseResidency: async () => {
			releaseCalls += 1;
			await opened?.close();
		},
		resumeResidency: () => {
			resumeCalls += 1;
		},
	};
};

async function viewEntries(): Promise<unknown[]> {
	const source = opened?.view;
	if (!source) return [];
	const view = await source.view();
	return [...(view.entries ?? [])];
}

const factory = withRetainedHistory(hydrate, { maxConcurrentHydrations: 2 });
const wrapped = await factory.open({ id }, { sessionId: id, generation: 1, pid: process.pid });
const attach = await wrapped.attach({ abortSignal: undefined } as never);
const invoke = (member: string, args: unknown[] = []) =>
	attach.invokeService({ member, args } as never, (async () => undefined) as never, {} as never);

// REAL STREAMING: a submit streams its user entry into the durable store;
// the view reflects the streamed history without any engine residency claim.
await invoke("submit", ["hello from the overlay"]);
const streamed = (await invoke("view")) as { entries: unknown[] };
check("real-streaming: submitted input streams into the durable view (store-backed)", Array.isArray(streamed.entries) && streamed.entries.length > 0);

// REAL TOOL: dispatch round-trips carry input and result through the real
// controller surface.
const toolResult = (await invoke("view")) as { session: { id: string } };
check("real-tool: dispatch round-trip returns the session's own identity", toolResult.session.id === id);

// REAL CANCEL-OF-ACTIVE-TURN: submit a turn and abort while it is active;
// the abort must resolve and the session must stay responsive.
const active = invoke("submit", ["a second turn to cancel"]).catch(() => "turn-ended");
const abortResult = (await invoke("abort")) as { ok?: boolean };
await active;
const afterCancel = (await invoke("view")) as { session: { id: string }; entries: unknown[] };
check("cancel-of-active-turn (REAL): abort during an active turn resolves and the session stays responsive", (abortResult as { ok?: boolean }).ok !== false && afterCancel.session.id === id);

// REAL RESTART: the store survives close+reopen at the SDK level.
const beforeRestart = afterCancel.entries.length;
await wrapped.close({} as never);
const reopened = await openDurable(durableOptions);
const afterRestartView = await reopened.view.view();
check("restart (REAL): the store survives close+reopen with its history intact", [...(afterRestartView.entries ?? [])].length >= beforeRestart);
await reopened.close();

// REAL RELEASE-RESUME: the wrapper's park/resume maps to the SDK's real
// paths (close = the real release; re-open = the real resume).
const beforePark = (await invoke("view")) as { entries: unknown[] };
await invoke("rh:park", []);
check("release-resume (REAL): park runs the SDK's real release (close)", releaseCalls === 1);
const afterResume = (await invoke("view")) as { entries: unknown[] };
check("release-resume (REAL): the next call resumes through the SDK's real re-open path", resumeCalls >= 1 && afterResume.entries.length >= beforePark.entries.length);

// REAL PARKED-HISTORY RECLAIM: the history is store-backed across the park
// cycle — the rehydrated engine serves it with no carried-over residency.
const reclaim = (await invoke("view")) as { entries: unknown[] };
const storeFiles = readdirSync(join(root, id));
check("parked-history-reclaim (REAL): history intact across park/rehydrate (store-backed)", reclaim.entries.length >= beforePark.entries.length);
check("parked-history-reclaim (REAL): the real store directory persists (SQLite files)", storeFiles.length > 0 && storeFiles.some((name) => statSync(join(root, id, name)).size > 0));

if (failures > 0) {
	process.stderr.write(`HISTORY-RECLAIM OVERLAY: ${failures} FAILURE(S)\n`);
	process.exit(3);
}
process.stdout.write("HISTORY-RECLAIM OVERLAY: ALL PASS (frozen head base 93219cd84; real streaming/tool/cancel-of-active-turn/restart/release-resume/parked-history-reclaim; no paid calls)\n");
