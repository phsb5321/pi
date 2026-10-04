/**
 * retained-history — parked-session hydration/reclamation (p9, PORT-PI-EXEC-
 * 1133-HISTORY). ONE bounded slice: parked histories release reclaimable
 * engine/context residency and rehydrate on demand, preserving
 * stream/input/cancellation/tools semantics, writer-once accounting, and
 * crash recovery. DEFAULT-OFF (the wrapper is opt-in per factory); rollback
 * = stop wrapping. Bounded rehydration pool = the fault/isolation limit.
 *
 * Non-overlapping: this is a decorator over the InProcessEngineFactory seam
 * (p4's in-process-runtime); no runtime or SDK files are touched.
 *
 * 100x whole-fleet RAM remains UNPROVEN — this slice is the reclamation
 * mechanism, not the fleet claim; heavy memory acceptance belongs to p3's
 * admitted offhost serialized slot.
 */
import type { InProcessEngineFactory, InProcessSessionEngine, InProcessSessionIdentity } from "./in-process-runtime.ts";
import type { SessionMetadata } from "./types.ts";

export interface RetainedHistoryPolicy {
	/** Max concurrent rehydrations (the fault/isolation bound). Default 4. */
	maxConcurrentHydrations?: number;
	/** Called when a session parks: the engine's reclaimable residency must be dropped. */
	onPark?: (sessionId: string) => void;
	/** Called when a parked session rehydrates (before the first post-park call). */
	onHydrate?: (sessionId: string) => void;
}

type Attach = InProcessSessionEngine["attach"];

/**
 * The application-supplied park/resume pair: `releaseResidency` drops the
 * reclaimable engine/context residency at park; `resumeResidency` rebuilds
 * it on demand (the rehydration). The engine and its durable record are
 * untouched across the cycle.
 *
 * These callbacks are FIXTURE HOOKS until the real SDK release/resume path
 * is wired (PORT-PI-1214): no SDK acceptance is claimed for this slice.
 */
export type HydrateSession = (
	metadata: SessionMetadata,
	identity: InProcessSessionIdentity,
) => Promise<{
	engine: InProcessSessionEngine;
	releaseResidency: () => void | Promise<void>;
	resumeResidency: () => void | Promise<void>;
}>;

/**
 * Wrap an engine factory with park/rehydrate semantics. The factory builds
 * the engine once per generation; `releaseResidency` drops the reclaimable
 * engine/context residency at park; the first call after park rehydrates.
 */
export type ParkableEngine = InProcessSessionEngine & { park(): Promise<void> };

export function withRetainedHistory(
	hydrate: HydrateSession,
	policy: RetainedHistoryPolicy = {},
): InProcessEngineFactory {
	const maxConcurrentHydrations = Math.max(1, policy.maxConcurrentHydrations ?? 4);
	let inFlightHydrations = 0;

	return {
		async open(metadata: SessionMetadata, identity: InProcessSessionIdentity) {
			const { engine, releaseResidency, resumeResidency } = await hydrate(metadata, identity);
			let parked = false;
			let rehydrating: Promise<void> | undefined;

			const ensureHydrated = async (): Promise<void> => {
				if (!parked) return;
				if (rehydrating) return rehydrating;
				const attempt = (async () => {
					if (inFlightHydrations >= maxConcurrentHydrations) {
						// Bounded pool: the fault/isolation limit — refuse rather than
						// grow an unbounded rehydration storm.
						throw new Error("retained-history: rehydration pool exhausted");
					}
					inFlightHydrations += 1;
					try {
						await resumeResidency();
						policy.onHydrate?.(metadata.id);
						parked = false;
					} finally {
						inFlightHydrations -= 1;
					}
				})();
				rehydrating = attempt;
				// Clear at settle (resolve AND reject) for the initiator and every
				// concurrent caller alike. It must attach to the promise: the IIFE's
				// synchronous part (including its own finally) runs before this
				// assignment lands, so an in-body clear would be overwritten.
				void attempt
					.finally(() => {
						if (rehydrating === attempt) rehydrating = undefined;
					})
					.catch(() => undefined);
				return attempt;
			};

			/** Park the session: release reclaimable engine/context residency. */
			const park = async (): Promise<void> => {
				if (parked) return;
				parked = true;
				// Wrapper-wide await (PORT-PI-1241): async reclaim proof requires the
				// release/resume callbacks to be awaited, not fired and forgotten.
				await releaseResidency();
				policy.onPark?.(metadata.id);
			};

			const attach: Attach = async (context) => {
				await ensureHydrated();
				const attachment = await engine.attach(context);
				return {
					async invokeService(call, publish, callContext) {
						// Reserved member: the policy-level park entry rides the existing
						// service seam (no new protocol surface).
						if (String((call as { member?: unknown }).member ?? "") === "rh:park") {
							await park();
							return { parked: true };
						}
						await ensureHydrated();
						// Stream/publish, input (args), and cancellation (abortSignal) pass
						// through unchanged across park/rehydrate.
						return attachment.invokeService(call, publish, callContext);
					},
					async release(releaseContext) {
						return attachment.release(releaseContext);
					},
				};
			};

			return {
				identity: engine.identity,
				terminated: engine.terminated,
				attach,
				async close(context) {
					// Writer-once: close releases the writer exactly once regardless of
					// park state (crash recovery semantics unchanged).
					await engine.close(context);
				},
				// The park entry point for policy-level retire hooks; the service-level
				// `rh:park` member is the seam-compatible reach for it.
				park,
			};
		},
	};
}
