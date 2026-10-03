import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	MaybePromise,
	RoutedSessionAttachment,
	RoutedSessionHandle,
	ServerHost,
	SessionMetadata,
} from "./types.ts";

/**
 * Opt-in shared-process worker slice (FINISH-0310-1644, memory-sound track A).
 *
 * Decorates an application's `ServerHost` to bound the session handles it
 * opens. Actual process sharing remains the supplied host's responsibility:
 *
 * - **opt-in only**: composition at the host boundary — existing seats and
 *   sessions are never replaced; this module spawns no process or thread and
 *   performs no signal delivery (in-process worker model, FEASIBILITY-A).
 * - **bounded**: a hard `maxWorkers` cap enforced with reservations (a
 *   pending open holds its slot) and explicit retirement.
 * - **isolated**: every worker owns private slot state; contexts are never
 *   pooled or shared across sessions; identity (session id + generation) is
 *   recorded per worker for mechanical cohort grouping.
 * - **crash parity**: the wrapped handle passes `terminated` through exactly
 *   as the upstream contract states — a Promise that RESOLVES with an Error
 *   for unexpected termination, or `undefined` after an expected close
 *   (including retirement) — and one session's termination never disturbs
 *   another session's slot.
 */

export type WorkerModel = "in-process";

export interface WorkerIdentity {
	/** Durable Session id the worker hosts. */
	readonly sessionId: string;
	/**
	 * Monotonic open generation for this session id. A retirement or crash
	 * increments it on the next open, so probes can tell reopened workers
	 * apart without process identity.
	 */
	readonly generation: number;
	readonly openedAt: number;
	readonly model: WorkerModel;
}

export interface SharedProcessWorkerInfo {
	readonly identity: WorkerIdentity;
	/** Live presentation attachments on this worker. */
	readonly demand: number;
	/** In-flight service operations on this worker. */
	readonly inFlight: number;
	/** Attachments currently being acquired (race guard against retirement). */
	readonly attaching: number;
	readonly retiring: boolean;
}

export interface SharedProcessPolicy {
	/** Hard cap on concurrently hosted workers (bounded blast radius). Positive finite integer. */
	maxWorkers: number;
	/**
	 * Retire a worker after this many milliseconds with zero presentation
	 * demand, zero in-flight operations, and `isHarnessIdle` true. Omit or 0
	 * disables retirement (the upstream behavior). Finite, >= 0.
	 */
	retireAfterIdleMs?: number;
	/**
	 * Host knowledge of worker-local Harness activity (per the server
	 * contract the host owns the Session and Harness). A worker is never
	 * retired while this returns false. REQUIRED when retirement is enabled
	 * (validated); unused when `retireAfterIdleMs` is 0/omitted.
	 */
	isHarnessIdle?: (identity: WorkerIdentity) => boolean;
	/** Opt-in retirement hooks (plugin-break catalog: worker retirement hooks). */
	onBeforeRetire?: (info: SharedProcessWorkerInfo) => MaybePromise<void>;
	onAfterRetire?: (info: SharedProcessWorkerInfo) => void;
	/** Observability seams; admission and refusal are distinct events. */
	onWorkerOpen?: (info: SharedProcessWorkerInfo) => void;
	onWorkerRefused?: (refused: { sessionId: string; reason: "at-capacity" }) => void;
	/**
	 * Retirement-time failures (hooks, close) are never unhandled rejections:
	 * the worker stays hosted and the failure is reported here.
	 */
	onError?: (error: unknown) => void;
}

interface WorkerSlot {
	identity: WorkerIdentity;
	handle: RoutedSessionHandle;
	demand: number;
	inFlight: number;
	attaching: number;
	retiring: boolean;
	/** Once a close has begun, attaches fail closed (deferred-close race). */
	closeBegun: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
}

/** Invalid policy values fail fast: bounded behavior needs bounded inputs. */
export class SharedProcessPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SharedProcessPolicyError";
	}
}

/** Attach refused once the worker's close has begun (fail closed). */
export class SharedProcessClosingError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Shared-process worker ${sessionId} is closing; attach refused`);
		this.name = "SharedProcessClosingError";
		this.sessionId = sessionId;
	}
}

function validatePolicy(policy: SharedProcessPolicy): { maxWorkers: number; retireAfterIdleMs: number } {
	const { maxWorkers, retireAfterIdleMs } = policy;
	if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || !Number.isFinite(maxWorkers)) {
		throw new SharedProcessPolicyError(
			`maxWorkers must be a positive finite integer (received ${String(maxWorkers)})`,
		);
	}
	const idle = retireAfterIdleMs ?? 0;
	if (typeof idle !== "number" || Number.isNaN(idle) || !Number.isFinite(idle) || idle < 0) {
		throw new SharedProcessPolicyError(`retireAfterIdleMs must be a finite number >= 0 (received ${String(idle)})`);
	}
	if (idle > 2_147_483_647) {
		// Node clamps setTimeout delays above 2^31-1 to 1ms: accepting this
		// value would mean surprise immediate retirement.
		throw new SharedProcessPolicyError(
			`retireAfterIdleMs must be <= 2147483647 (Node timer limit; received ${String(idle)})`,
		);
	}
	if (idle > 0 && typeof policy.isHarnessIdle !== "function") {
		// Retiring on an assumed-idle Harness would risk evicting live work.
		// Harness idleness is host knowledge; require it explicitly.
		throw new SharedProcessPolicyError("isHarnessIdle is required when retireAfterIdleMs > 0");
	}
	return { maxWorkers, retireAfterIdleMs: idle };
}

/**
 * Wrap a ServerHost so `openSession` admits sessions as bounded shared-process
 * workers. The returned host is a drop-in `ServerHost` for the existing
 * `Server`/`SessionRouter` — no server, protocol, or application change.
 */
export function createSharedProcessHost<TMetadata extends SessionMetadata>(
	inner: ServerHost<TMetadata>,
	policy: SharedProcessPolicy,
): ServerHost<TMetadata> {
	const { maxWorkers, retireAfterIdleMs } = validatePolicy(policy);
	const isHarnessIdle = policy.isHarnessIdle ?? (() => true);
	const slots = new Map<string, WorkerSlot>();
	/** Pending opens hold their capacity reservation and are shared per session. */
	const pendingOpens = new Map<string, Promise<WorkerSlot>>();
	/** Globally monotonic open sequence: bounded memory, no per-id ABA. */
	let generationCounter = 0;

	const describe = (slot: WorkerSlot): SharedProcessWorkerInfo => ({
		identity: slot.identity,
		demand: slot.demand,
		inFlight: slot.inFlight,
		attaching: slot.attaching,
		retiring: slot.retiring,
	});

	const clearIdleTimer = (slot: WorkerSlot): void => {
		if (slot.idleTimer !== undefined) {
			clearTimeout(slot.idleTimer);
			slot.idleTimer = undefined;
		}
	};

	const isBusy = (slot: WorkerSlot): boolean => slot.demand > 0 || slot.inFlight > 0 || slot.attaching > 0;

	const scheduleRetirement = (slot: WorkerSlot): void => {
		if (retireAfterIdleMs <= 0 || slot.retiring) return;
		clearIdleTimer(slot);
		if (isBusy(slot)) return;
		slot.idleTimer = setTimeout(() => {
			slot.idleTimer = undefined;
			// Retirement failures are reported, never unhandled rejections.
			attemptRetire(slot).catch((error: unknown) => {
				slot.retiring = false;
				policy.onError?.(error);
			});
		}, retireAfterIdleMs);
		// A pending retirement must never hold the process open by itself.
		slot.idleTimer.unref?.();
	};

	const attemptRetire = async (slot: WorkerSlot): Promise<void> => {
		if (slot.retiring) return;
		if (slots.get(slot.identity.sessionId) !== slot) return;
		if (isBusy(slot)) return;
		// Host knowledge wins: a busy Harness blocks retirement. It may go
		// idle later without any attachment event, so keep one bounded idle
		// timer running.
		if (!isHarnessIdle(slot.identity)) {
			scheduleRetirement(slot);
			return;
		}
		slot.retiring = true;
		const info = describe(slot);
		try {
			await policy.onBeforeRetire?.(info);
			// A hook await can interleave an attach or harness activity:
			// re-check both before committing to close.
			if (isBusy(slot) || !isHarnessIdle(slot.identity)) {
				slot.retiring = false;
				scheduleRetirement(slot);
				return;
			}
			slot.closeBegun = true;
			// Expected close: terminated resolves undefined (crash parity).
			await slot.handle.close(BACKGROUND_CONTEXT);
			if (slots.get(slot.identity.sessionId) === slot) slots.delete(slot.identity.sessionId);
			clearIdleTimer(slot);
			slot.retiring = false;
			policy.onAfterRetire?.(info);
		} catch (error) {
			// A failed close leaves the worker live and capacity held (release
			// happens only on actual termination or successful close); attaches
			// stay fail-closed because close was already attempted.
			slot.retiring = false;
			throw error;
		}
	};

	const releaseSlot = (slot: WorkerSlot): void => {
		if (slots.get(slot.identity.sessionId) === slot) slots.delete(slot.identity.sessionId);
		clearIdleTimer(slot);
	};

	const wrapAttachment = (slot: WorkerSlot, lease: RoutedSessionAttachment): RoutedSessionAttachment => {
		slot.demand++;
		scheduleRetirement(slot);
		let released = false;
		return {
			async invokeService(
				call: ServiceCall,
				publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
				context: Context,
			): Promise<JsonValue | undefined> {
				slot.inFlight++;
				clearIdleTimer(slot);
				try {
					return await lease.invokeService(call, publish, context);
				} finally {
					slot.inFlight--;
					scheduleRetirement(slot);
				}
			},
			async release(context: Context): Promise<void> {
				if (released) return;
				released = true;
				try {
					await lease.release(context);
				} finally {
					slot.demand = Math.max(0, slot.demand - 1);
					scheduleRetirement(slot);
				}
			},
		};
	};

	const wrapHandle = (slot: WorkerSlot): RoutedSessionHandle => ({
		terminated: slot.handle.terminated,
		attachClient(context: Context): MaybePromise<RoutedSessionAttachment> {
			// Fail closed once a close has begun: a client must never receive a
			// closing worker (deferred-close race). Before the close commit an
			// attach still cancels a pending retire via the post-hook re-check.
			if (slot.closeBegun) return Promise.reject(new SharedProcessClosingError(slot.identity.sessionId));
			// Synchronous reservation: an in-flight attach blocks retirement
			// even while the inner attach is still pending.
			slot.attaching++;
			clearIdleTimer(slot);
			let lease: MaybePromise<RoutedSessionAttachment>;
			try {
				lease = slot.handle.attachClient(context);
			} catch (error) {
				slot.attaching--;
				scheduleRetirement(slot);
				throw error;
			}
			const attach = (l: RoutedSessionAttachment): RoutedSessionAttachment => {
				slot.attaching--;
				return wrapAttachment(slot, l);
			};
			const fail = (error: unknown): never => {
				slot.attaching--;
				scheduleRetirement(slot);
				throw error;
			};
			return lease instanceof Promise ? lease.then(attach, fail) : attach(lease);
		},
		async close(context: Context): Promise<void> {
			clearIdleTimer(slot);
			slot.closeBegun = true;
			// Capacity is released only after the close actually succeeds (or
			// terminated settles): a rejected close must not free the slot while
			// the worker is still live (live workers would exceed the cap).
			await slot.handle.close(context);
			releaseSlot(slot);
		},
	});

	const openOne = (metadata: TMetadata, context: Context): Promise<WorkerSlot> => {
		const generation = ++generationCounter;
		const pending = Promise.resolve()
			.then(() => inner.openSession(metadata, context))
			.then((handle): WorkerSlot => {
				const slot: WorkerSlot = {
					identity: { sessionId: metadata.id, generation, openedAt: Date.now(), model: "in-process" },
					handle,
					demand: 0,
					inFlight: 0,
					attaching: 0,
					retiring: false,
					closeBegun: false,
				};
				slots.set(metadata.id, slot);
				void handle.terminated?.then(
					() => releaseSlot(slot),
					() => releaseSlot(slot),
				);
				scheduleRetirement(slot);
				return slot;
			});
		pendingOpens.set(metadata.id, pending);
		const cleanup = (): void => {
			if (pendingOpens.get(metadata.id) === pending) pendingOpens.delete(metadata.id);
		};
		pending.then(cleanup, cleanup);
		return pending;
	};

	return {
		serverServices: inner.serverServices,
		resolveSession: (sessionId, context) => inner.resolveSession(sessionId, context),
		async openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle> {
			const existing = slots.get(metadata.id);
			if (existing) return wrapHandle(existing);
			const pending = pendingOpens.get(metadata.id);
			if (pending) {
				// Same-session concurrent opens share one inner open.
				return wrapHandle(await pending);
			}
			// The pending entry is the capacity reservation: this check and the
			// insertion below run without an intervening await, so concurrent
			// opens cannot both pass it (cap race fixed).
			if (slots.size + pendingOpens.size >= maxWorkers) {
				policy.onWorkerRefused?.({ sessionId: metadata.id, reason: "at-capacity" });
				throw new SharedProcessCapacityError(metadata.id, maxWorkers);
			}
			const slot = await openOne(metadata, context);
			policy.onWorkerOpen?.(describe(slot));
			return wrapHandle(slot);
		},
	};
}

/** Refusal when the shared-process worker cap is reached (opt-in, bounded). */
export class SharedProcessCapacityError extends Error {
	readonly sessionId: string;
	readonly maxWorkers: number;

	constructor(sessionId: string, maxWorkers: number) {
		super(`Shared-process worker capacity reached (${maxWorkers}); session ${sessionId} refused`);
		this.name = "SharedProcessCapacityError";
		this.sessionId = sessionId;
		this.maxWorkers = maxWorkers;
	}
}

/** Introspection for probes and regressions; read-only view of live workers. */
export function sharedProcessSnapshot(infos: readonly SharedProcessWorkerInfo[]): {
	workers: number;
	demand: number;
	inFlight: number;
} {
	let demand = 0;
	let inFlight = 0;
	for (const info of infos) {
		demand += info.demand;
		inFlight += info.inFlight;
	}
	return { workers: infos.length, demand, inFlight };
}
