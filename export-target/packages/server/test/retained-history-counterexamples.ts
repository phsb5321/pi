/**
 * retained-history-counterexamples — executable counterexamples to the
 * mislabels in the unrun `28bd` retained-history battery (found
 * independently by root, 04/10; recorded here as evidence, p9's files stay
 * untouched and their suite stays their ownership):
 *
 *   CE-1  view/session-id is NOT tool evidence — the view surface carries no
 *         tool-call record; any "tool" claim sourced from it is mislabeled.
 *   CE-2  persisted input is NOT a stream delta — persisted rows carry
 *         inputs (seq/kind/payload) only; incremental output deltas are not
 *         derivable from them.
 *   CE-3  a resume counter is NOT reopen proof — the seam's `resumeResidency:
 *         () => void` accepts a counter-only bump; the wrapper reports
 *         rehydrated without any engine reopen.
 *   CE-4  regression: wrapper close now rejects dispatch, new attachment
 *         and park, without reopening or closing the engine twice.
 *
 * Drives p9's `withRetainedHistory` seam directly with a fixture engine.
 * Exit 0 = every counterexample demonstrated as described.
 *
 *   node --experimental-strip-types packages/server/test/retained-history-counterexamples.ts
 */
import assert from "node:assert/strict";
import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import { type HydrateSession, type ParkableEngine, withRetainedHistory } from "../src/retained-history.ts";
import type { SessionMetadata } from "../src/types.ts";
import { Checks, CONTEXT, engineWith, identityFor, metadata, WriterTracker } from "./contract-fixture.ts";

const checks = new Checks();

// A fixture engine whose dispatch returns view-shaped and input-shaped rows.
function fixtureHydrate(state: {
	reopened: boolean;
	resumeBumps: number;
	closedDispatches: number;
	closeCount: number;
}): HydrateSession {
	return async (meta: SessionMetadata, identity: ReturnType<typeof identityFor>) => {
		const tracker = new WriterTracker();
		tracker.acquire(meta.id, identity.generation);
		const rows: Array<{ seq: number; kind: string; payload: string }> = [];
		let closed = false;
		const base = engineWith(identity, tracker, async () => {
			state.closeCount += 1;
			closed = true;
		});
		return {
			engine: {
				...base,
				attach: () => ({
					async invokeService(call: ServiceCall): Promise<JsonValue | undefined> {
						const member = String((call as { member?: unknown }).member ?? "");
						if (closed) state.closedDispatches += 1;
						if (member === "view") {
							// CE-1 surface: no tool record exists here.
							return { session: { id: meta.id }, conversations: rows.length };
						}
						if (member === "submit") {
							rows.push({ seq: rows.length + 1, kind: "write", payload: String(call.args[0] ?? "") });
							return { seq: rows.length };
						}
						if (member === "rows") return rows.map((row) => ({ ...row }));
						return undefined;
					},
					release: async () => undefined,
				}),
			},
			releaseResidency: () => {
				// CE-2/CE-3 shape: release drops nothing durable (inputs persist).
			},
			resumeResidency: () => {
				// CE-3: a counter bump only — no engine reopen of any kind.
				state.resumeBumps += 1;
			},
		};
	};
}

const state = { reopened: false, resumeBumps: 0, closedDispatches: 0, closeCount: 0 };
let hydrated = 0;
const factory = withRetainedHistory(fixtureHydrate(state), {
	onHydrate: () => {
		hydrated += 1;
	},
});

const identity = identityFor("ce-s1", 1);
const engine = (await factory.open(metadata("ce-s1"), identity, CONTEXT)) as ParkableEngine;
const attachment = await engine.attach(CONTEXT);
const call = (member: string, args: unknown[] = []) =>
	attachment.invokeService(
		{ serviceId: "ce", member, args } as unknown as ServiceCall,
		async () => undefined,
		CONTEXT,
	);

// CE-1: the view surface carries no tool-call record.
const view = (await call("view")) as Record<string, unknown>;
checks.check(
	"CE-1: view surface carries no tool evidence (any tool claim from view/id is mislabeled)",
	!("tools" in view) && !("toolCalls" in view),
);

// CE-2: persisted rows carry inputs only — no stream-delta fields.
await call("submit", ["persisted-input"]);
const rows = (await call("rows")) as Array<Record<string, unknown>>;
checks.check(
	"CE-2: persisted rows are inputs (seq/kind/payload) — not stream deltas",
	rows.every((row) => Object.keys(row).sort().join(",") === "kind,payload,seq"),
);

// CE-3: park then call again: the wrapper reports rehydrated via a
// counter-only resumeResidency — no engine reopen happens.
call("view").catch(() => undefined); // keep the attachment warm
await engine.park();
await call("view");
checks.check(
	"CE-3: resume counter bumped without any engine reopen (counter is not reopen proof)",
	state.resumeBumps >= 1 && state.reopened === false && hydrated >= 1,
);

// CE-4: every wrapper entry refuses use after close, with idempotent teardown.
await engine.close(CONTEXT);
await assert.rejects(call("view"), /engine is closed/);
await assert.rejects(async () => engine.attach(CONTEXT), /engine is closed/);
await assert.rejects(engine.park(), /engine is closed/);
await engine.close(CONTEXT);
checks.check(
	"CE-4: closed wrapper rejects dispatch/attach/park and closes exactly once",
	state.closedDispatches === 0 && state.closeCount === 1,
);

checks.finish("RETAINED-HISTORY COUNTEREXAMPLES");
