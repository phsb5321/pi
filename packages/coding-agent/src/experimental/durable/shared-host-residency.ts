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
 * - release/resume are ASYNC in the real SDK. p9's seam types them `() =>
 *   void` and does not await them (domain note filed), so this adapter
 *   serializes them on an internal gate that every engine call awaits —
 *   async release/resume is awaited end-to-end without touching p9's file;
 * - input/stream/publish/cancel pass through unchanged (the dispatch rides
 *   the same member seam), writer-once holds (writer release happens at
 *   engine close exactly once, independent of park/resume cycles), and the
 *   persisted record survives restart.
 *
 * DEFAULT OFF: nothing runs unless the application calls
 * `createSharedHostResidency`. Synthetic/provider-free; no model turns.
 *
 *   node --experimental-strip-types \
 *     packages/coding-agent/src/experimental/durable/shared-host-residency-acceptance.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionMetadata } from "@earendil-works/pi-server";
import {
	type HydrateSession,
	type InProcessEngineFactory,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
	SharedHostCore,
	type SharedHostHooks,
	type SharedHostPolicy,
	createInProcessRuntime,
	withRetainedHistory,
} from "@earendil-works/pi-server";
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
}

export interface ResidencyHydrateOptions {
	/** Root directory: one per-session cwd + resident record under it. */
	readonly root: string;
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
		const cwd = join(root, metadata.id);
		mkdirSync(cwd, { recursive: true });
		// Restart continuity: a persisted resident record means continue the
		// native session (same store/history); otherwise create one.
		let opened: OpenDurableResult = await openDurable({ cwd, continueSession: existsSync(recordPath(root, metadata.id)) });
		let live = true;
		let released = 0;
		let resumed = 0;
		// Serialized async release/resume: one promise chain the calls await.
		let gate: Promise<void> = Promise.resolve();
		const record = (): ResidentRecord => {
			const session = opened.view.current().session;
			return { sessionId: metadata.id, cwd, nativeSessionId: session.id, directory: session.directory };
		};
		writeFileSync(recordPath(root, metadata.id), `${JSON.stringify(record())}\n`);
		const emit = (): void => options.onState?.(metadata.id, { released, resumed, live });

		const dispatch = async (call: { member?: unknown; args?: unknown }): Promise<unknown> => {
			await gate;
			const member = typeof call.member === "string" ? call.member : "";
			// Adapter-state query works regardless of residency (it is not an
			// engine call); everything else needs the engine live.
			if (member === "residency") return { ...record(), released, resumed, live };
			if (!live) throw new Error(`residency: ${metadata.id} engine residency is not live`);
			return dispatchDurableMember(opened, call);
		};

		const engine: InProcessSessionEngine = durableEngineShell(
			identity,
			dispatch,
			// Writer-once: the writer releases here, exactly once per engine.
			async () => {
				await gate;
				if (live) {
					await opened.close();
					live = false;
				}
			},
		);

		return {
			engine,
			releaseResidency: () => {
				released += 1;
				const prior = gate;
				gate = (async () => {
					await prior;
					if (live) {
						await opened.close();
						live = false;
					}
					emit();
				})();
			},
			resumeResidency: () => {
				resumed += 1;
				const prior = gate;
				gate = (async () => {
					await prior;
					if (!live) {
						// NATIVE continuation: same cwd, same persisted store/history.
						opened = await openDurable({ cwd, continueSession: true });
						live = true;
						writeFileSync(recordPath(root, metadata.id), `${JSON.stringify(record())}\n`);
					}
					emit();
				})();
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

export interface SharedHostResidency {
	readonly runtime: ReturnType<typeof createInProcessRuntime>;
	readonly core: SharedHostCore;
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
	return composeSharedHost(factory, options.policy, options.hooks);
}
