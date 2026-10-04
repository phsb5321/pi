/**
 * shared-host-residency — the minimal ACTUAL SDK residency adapter + host
 * entry (p4, PORT-PI-1241). Implements p9's `HydrateSession` seam
 * (`packages/server/src/retained-history.ts`, owned by p9 — never edited
 * here) over the real `openDurable` persistence:
 *
 * - each session's persisted identity/cwd/history binds to the SDK's NATIVE
 *   close/reopen/continuation (`openDurable({cwd, continueSession})` + the
 *   per-session store), recorded per session in `<root>/<id>.resident.json`;
 * - park drops the ACTUAL engine/context residency (the OpenDurable result —
 *   Harness + store handle — is closed), and only quiescent sessions park
 *   (the existing SharedHostCore quiescence is the gate; no new state
 *   machine);
 * - release/resume are ASYNC in the real SDK. the history wrapper awaits them; this adapter also
 *   serializes engine calls with those transitions on an internal gate;
 * - the member surface (input/abort/view/switch) passes through the same
 *   dispatch across park/resume; stream-DELTA and tool-call semantics are
 *   NOT claimed here (they belong to p9's parity suite), writer-once holds
 *   (writer release happens at engine close exactly once, independent of
 *   park/resume cycles), and the persisted record survives restart;
 * - park is QUIESCENCE-GATED at the host entry: a session parks only when
 *   the existing SharedHostCore presentation count is zero
 *   (`core.isQuiescent`) — the wrapper's raw `rh:park` seam member remains
 *   p9's bypass and is out of this gate's scope.
 *
 * DEFAULT OFF: nothing runs unless the application calls
 * `createSharedHostResidency`. Application-owned ModelRuntime is optional; no ambient model turns.
 *
 *   node --experimental-strip-types \
 *     packages/coding-agent/src/experimental/durable/shared-host-residency-acceptance.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { LiveState } from "@earendil-works/pi-durable";
import type { SessionMetadata } from "@earendil-works/pi-server";
import {
	type createInProcessRuntime,
	type HydrateSession,
	type InProcessEngineFactory,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
	type ParkableEngine,
	type SharedHostCore,
	type SharedHostHooks,
	type SharedHostPolicy,
	withRetainedHistory,
} from "@earendil-works/pi-server";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { type OpenDurableResult, openDurable } from "./runtime.ts";
import { composeSharedHost, dispatchDurableMember, durableEngineShell } from "./shared-host-dispatch.ts";

export interface ResidentRecord {
	readonly sessionId: string;
	readonly cwd: string;
	readonly nativeSessionId: string;
	readonly directory: string;
}

export interface ResidencyState {
	readonly released: number;
	readonly resumed: number;
	readonly live: boolean;
	/** False after a park: the engine/context reference was dropped (GC-able). */
	readonly openedRetained: boolean;
	/** Weak reference to the live engine object (GC evidence for reclaims). */
	readonly openedRef?: WeakRef<object>;
}

/** In-process probe of the adapter's ACTUAL state (no dispatch, no rehydrate). */
export interface ResidencyProbe {
	readonly busy: number;
	readonly nativeActive: boolean;
	readonly live: boolean;
	readonly openedRetained: boolean;
}

export interface ResidencyHydrateOptions {
	/** Root directory: one per-session cwd + resident record under it. */
	readonly root: string;
	/** Application-owned models, retained across park/reopen. */
	readonly modelRuntime?: ModelRuntime | ((metadata: SessionMetadata) => ModelRuntime);
	/** Observed state transitions (acceptance/instrumentation; optional). */
	readonly onState?: (sessionId: string, state: ResidencyState) => void;
}

const recordPath = (root: string, sessionId: string): string => join(root, `${sessionId}.resident.json`);

/**
 * The real-SDK HydrateSession: one engine per (session, generation) over a
 * live `OpenDurableResult` holder. releaseResidency/resumeResidency return
 * promises (assignable to p9's `() => void` seam) and every engine call
 * awaits the serialized gate, so the async work is awaited end-to-end.
 */
export function sdkResidencyHydrate(options: ResidencyHydrateOptions): HydrateSession {
	const root = options.root;
	mkdirSync(root, { recursive: true });
	return async (metadata: SessionMetadata, identity: InProcessSessionIdentity) => {
		// Resolve once per engine identity: reopen must retain the original account context.
		const modelRuntime =
			typeof options.modelRuntime === "function" ? options.modelRuntime(metadata) : options.modelRuntime;
		const cwd = join(root, metadata.id);
		mkdirSync(cwd, { recursive: true });
		// Restart continuity: a persisted resident record means continue the
		// native session (same store/history); otherwise create one.
		let opened: OpenDurableResult | null = await openDurable({
			cwd,
			continueSession: existsSync(recordPath(root, metadata.id)),
			modelRuntime,
		});
		let live = true;
		let released = 0;
		let resumed = 0;
		// Serialized async release/resume: one promise chain the calls await.
		let gate: Promise<void> = Promise.resolve();
		// The small durable identity is cached so a parked engine's object graph
		// (Harness/store/closures) can be dropped without losing the binding.
		const snapshot = (current: OpenDurableResult): ResidentRecord => {
			const session = current.view.current().session;
			return { sessionId: metadata.id, cwd, nativeSessionId: session.id, directory: session.directory };
		};
		let cached: ResidentRecord = snapshot(opened);
		writeFileSync(recordPath(root, metadata.id), `${JSON.stringify(cached)}\n`);
		let busy = 0;
		let openedRef: WeakRef<object> | undefined = new WeakRef(opened as object);
		const emit = (): void =>
			options.onState?.(metadata.id, { released, resumed, live, openedRetained: opened !== null, openedRef });
		// ACTUAL native work signal: in-flight dispatches plus the live turn
		// state (pi.live run or compaction, including tools between dispatches).
		const nativeActive = (): boolean => {
			const current = opened;
			if (current === null) return false;
			const liveDoc = current.view.current().conversation.docs["pi.live"] as LiveState | undefined;
			return liveDoc?.run !== undefined || (liveDoc?.compactions?.length ?? 0) > 0;
		};
		const probe = (): ResidencyProbe => ({
			busy,
			nativeActive: nativeActive(),
			live,
			openedRetained: opened !== null,
		});

		const dispatch = async (call: { member?: unknown; args?: unknown }): Promise<JsonValue | undefined> => {
			busy += 1;
			try {
				await gate;
				const member = typeof call.member === "string" ? call.member : "";
				// Adapter-state query works regardless of residency (it is not an
				// engine call); everything else needs the engine live.
				if (member === "residency")
					return {
						...cached,
						released,
						resumed,
						live,
						openedRetained: opened !== null,
						busy,
						nativeActive: nativeActive(),
					};
				const current = opened;
				if (!live || current === null) throw new Error(`residency: ${metadata.id} engine residency is not live`);
				return await dispatchDurableMember(current, call);
			} finally {
				busy -= 1;
			}
		};

		const engine = Object.assign(
			durableEngineShell(
				identity,
				dispatch,
				// Writer-once: the writer releases here, exactly once per engine.
				async () => {
					await gate;
					const current = opened;
					if (current !== null) {
						await current.close();
						opened = null;
						live = false;
					}
				},
				() => {
					if (!opened) throw new Error("Durable engine is parked");
					return opened;
				},
			),
			{ residencyProbe: probe },
		) as InProcessSessionEngine & { residencyProbe: () => ResidencyProbe };

		emit();
		return {
			engine,
			releaseResidency: () => {
				released += 1;
				const prior = gate;
				gate = (async () => {
					await prior;
					const current = opened;
					if (current !== null) {
						await current.close();
						// PRIMARY RAM fix (1504): drop the engine/context reference so
						// the closed object graph is actually reclaimable — only the
						// cached durable identity survives the park. No per-parked-seat
						// process/isolate; the wrapper's bounded hydration pool unchanged.
						opened = null;
						live = false;
					}
					emit();
				})();
				return gate;
			},
			resumeResidency: () => {
				resumed += 1;
				const prior = gate;
				gate = (async () => {
					await prior;
					if (opened === null) {
						// NATIVE continuation: same cwd, same persisted store/history.
						const reopened = await openDurable({
							cwd,
							continueSession: true,
							modelRuntime,
						});
						opened = reopened;
						openedRef = new WeakRef(reopened as object);
						cached = snapshot(reopened);
						writeFileSync(recordPath(root, metadata.id), `${JSON.stringify(cached)}\n`);
						live = true;
					}
					emit();
				})();
				return gate;
			},
		};
	};
}

export interface SharedHostResidencyOptions {
	readonly policy: SharedHostPolicy;
	readonly hooks?: SharedHostHooks;
	readonly hydrate: ResidencyHydrateOptions;
	readonly maxConcurrentHydrations?: number;
}

export type ParkOutcome = "parked" | "refused-not-quiescent" | "refused-active-work" | "unknown-session";

export interface SharedHostResidency {
	readonly runtime: ReturnType<typeof createInProcessRuntime>;
	readonly core: SharedHostCore;
	/** Quiescence-gated park: refuses while the session has presentations. */
	parkWhenQuiescent(sessionId: string): Promise<ParkOutcome>;
	close(): Promise<void>;
}

/**
 * Host entry: p9's withRetainedHistory over the real-SDK hydrate, with the
 * EXISTING quiescence lifecycle as the park gate (a session parks only when
 * its presentation count reaches zero — `core.isQuiescent`). No new state
 * machine: the wrapper's parked flag is the only state.
 */
export async function createSharedHostResidency(options: SharedHostResidencyOptions): Promise<SharedHostResidency> {
	const factory: InProcessEngineFactory = withRetainedHistory(sdkResidencyHydrate(options.hydrate), {
		maxConcurrentHydrations: options.maxConcurrentHydrations ?? 4,
	});
	const parks = new Map<string, { park: () => Promise<void>; probe: () => ResidencyProbe }>();
	let closed = false;
	const gated: InProcessEngineFactory = {
		async open(metadata, identity, context) {
			const engine = await factory.open(metadata, identity, context);
			const probed = engine as ParkableEngine & { residencyProbe: () => ResidencyProbe };
			if (typeof probed.park !== "function" || typeof probed.residencyProbe !== "function") {
				throw new Error("Shared residency wrapper lost its native park/probe capabilities");
			}
			parks.set(metadata.id, { park: () => probed.park(), probe: () => probed.residencyProbe() });
			return engine;
		},
	};
	const composed = composeSharedHost(gated, options.policy, options.hooks);
	return {
		runtime: composed.runtime,
		core: composed.core,
		async parkWhenQuiescent(sessionId: string): Promise<ParkOutcome> {
			const entry = parks.get(sessionId);
			if (entry === undefined) return "unknown-session";
			// Existing lifecycle gate: zero presentations = quiescent (now proven
			// by production attach/release binding in composeSharedHost).
			if (!composed.core.isQuiescent(sessionId)) return "refused-not-quiescent";
			// ACTIVE NATIVE WORK BLOCKS PARK: in-flight dispatches or a live turn
			// (pi.live tool slots/submissions) — read from the actual engine state.
			const state = entry.probe();
			if (state.busy > 0 || state.nativeActive) return "refused-active-work";
			await entry.park();
			return "parked";
		},
		async close(): Promise<void> {
			// Idempotent teardown: a second close resolves without re-entering the
			// seam (writer-once at the engine level; no double release).
			if (closed) return;
			closed = true;
			await composed.close();
		},
	};
}
