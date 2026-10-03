import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import {
	createSharedProcessHost,
	type SharedProcessCapacityError,
	type SharedProcessPolicy,
	type WorkerIdentity,
} from "./shared-process.ts";
import type {
	MaybePromise,
	RoutedSessionAttachment,
	RoutedSessionHandle,
	ServerHost,
	SessionMetadata,
} from "./types.ts";

/**
 * In-process session runtime (memory-sound track A, shared-isolate slice).
 *
 * Hosts many session ENGINEs inside ONE Node process (no child Node per
 * session — that would be seat-replacement masquerading as sharing). The
 * runtime composes PR4's `createSharedProcessHost` for admission
 * reservations, the cap, retirement, and attach/close races, and adds the
 * engine side: stable per-session identity, exclusive durable writer
 * ownership, attach/detach, and recoverable shutdown.
 *
 * DEFAULT OFF: nothing is hosted unless an application explicitly creates
 * a runtime with an engine factory; the library itself starts no process,
 * thread, timer, or watcher.
 *
 * Narrow interface: pD's client and p9's falsifiers consume
 * `InProcessSessionIdentity` / `InProcessSessionEngine` /
 * `InProcessRuntimeControl` only; p2 integrates `createInProcessRuntime`
 * into the application host.
 */

/** Stable per-session identity inside the one shared process. */
export interface InProcessSessionIdentity {
	/** Durable session id. */
	readonly sessionId: string;
	/** Monotonic open sequence for this session id (no per-id ABA). */
	readonly generation: number;
	/** The ONE host process id — the sharing proof (all engines share it). */
	readonly pid: number;
	readonly model: "in-process";
}

/** Presentation attachment: the opaque service seam the server routes to. */
export interface InProcessSessionAttachment {
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

/**
 * One session engine living in the shared process. The engine owns its
 * durable writer exclusively for its lifetime; `close()` releases it.
 */
export interface InProcessSessionEngine {
	readonly identity: InProcessSessionIdentity;
	/** Resolves with an Error on unexpected termination, undefined on expected close. */
	readonly terminated?: Promise<Error | undefined>;
	attach(context: Context): MaybePromise<InProcessSessionAttachment>;
	close(context: Context): Promise<void>;
}

/**
 * Application-supplied engine construction. CONTRACT: `open` must create
 * the engine IN-PROCESS (same pid) and must not spawn processes, threads,
 * or agents; it acquires the session's durable writer exclusively and
 * releases it in `close`. Reopening the same sessionId after close is
 * supported (recovery) and must produce a new generation.
 */
export interface InProcessEngineFactory {
	open(
		metadata: SessionMetadata,
		identity: InProcessSessionIdentity,
		context: Context,
	): Promise<InProcessSessionEngine>;
}

export interface InProcessRuntimePolicy {
	/** Hard cap on concurrently hosted session engines. Positive finite integer. */
	maxSessions: number;
	/** Retirement window (ms); omit or 0 = never retire (default OFF). */
	retireAfterIdleMs?: number;
	/** REQUIRED when retirement is enabled (host knowledge of harness idleness). */
	isHarnessIdle?: (identity: WorkerIdentity) => boolean;
	onBeforeRetire?: SharedProcessPolicy["onBeforeRetire"];
	onAfterRetire?: SharedProcessPolicy["onAfterRetire"];
	onEngineOpen?: (identity: InProcessSessionIdentity) => void;
	onEngineRefused?: (refused: { sessionId: string; reason: "at-capacity" }) => void;
	onError?: (error: unknown) => void;
}

/** Control surface for probes, p9 falsifiers, and supervisors. */
export interface InProcessRuntimeControl {
	/** The one host process id. */
	readonly pid: number;
	/** Live engine identities (read-only view). */
	identities(): InProcessSessionIdentity[];
	/**
	 * Recoverable shutdown: closes every engine (releasing writer
	 * ownership) in dependency-free order; failures are collected, not
	 * thrown one-by-one. Reopening sessions afterwards recovers from
	 * durable state with fresh generations.
	 */
	shutdown(context: Context): Promise<void>;
}

export interface InProcessRuntime {
	/** Drop-in `ServerHost` for `packages/server`'s Server/SessionRouter. */
	readonly host: ServerHost<SessionMetadata>;
	readonly control: InProcessRuntimeControl;
}

/**
 * Create the in-process runtime. The returned host is a plain `ServerHost`:
 * pass it to `Server` exactly as before. Every engine lives in this
 * process; admission, cap, retirement, and close-races are PR4's.
 */
export function createInProcessRuntime(
	factory: InProcessEngineFactory,
	policy: InProcessRuntimePolicy,
): InProcessRuntime {
	const pid = process.pid;
	let generation = 0;
	const engines = new Map<string, InProcessSessionEngine>();

	const inner: ServerHost<SessionMetadata> = {
		serverServices: {
			attachClient() {
				throw new Error("server services are application-owned; this runtime only hosts session engines");
			},
		},
		async resolveSession(sessionId: string): Promise<SessionMetadata> {
			return { id: sessionId };
		},
		async openSession(metadata: SessionMetadata, context: Context): Promise<RoutedSessionHandle> {
			const identity: InProcessSessionIdentity = {
				sessionId: metadata.id,
				generation: ++generation,
				pid,
				model: "in-process",
			};
			const engine = await factory.open(metadata, identity, context);
			// Validate the full identity the factory echoed back: a session,
			// generation, or pid mismatch is a contract violation (no silent
			// mis-attribution of engines).
			if (
				engine.identity.pid !== pid ||
				engine.identity.sessionId !== metadata.id ||
				engine.identity.generation !== identity.generation
			) {
				await engine.close(context);
				throw new Error(
					`Engine factory violated the in-process contract (session ${metadata.id}: identity ` +
						`${engine.identity.sessionId}/${engine.identity.generation}/pid ${engine.identity.pid} != ` +
						`expected ${metadata.id}/${identity.generation}/pid ${pid})`,
				);
			}
			engines.set(metadata.id, engine);
			// Single notification point with the ENGINE identity (the decorator's
			// worker identity uses its own counter and must not notify). A
			// throwing hook must not leak the admitted engine or its writer.
			try {
				policy.onEngineOpen?.(engine.identity);
			} catch (error) {
				engines.delete(metadata.id);
				await engine.close(context).catch(() => undefined);
				throw error;
			}
			const handle: RoutedSessionHandle = {
				terminated: engine.terminated,
				attachClient(attachContext: Context): MaybePromise<RoutedSessionAttachment> {
					const lease = engine.attach(attachContext);
					return lease instanceof Promise
						? lease.then((l) => wrapEngineAttachment(engine, l))
						: wrapEngineAttachment(engine, lease);
				},
				async close(closeContext: Context): Promise<void> {
					try {
						// Releases the engine's exclusive durable writer ownership.
						await engine.close(closeContext);
					} finally {
						if (engines.get(metadata.id) === engine) engines.delete(metadata.id);
					}
				},
			};
			if (engine.terminated) {
				void engine.terminated.then(
					() => {
						if (engines.get(metadata.id) === engine) engines.delete(metadata.id);
					},
					() => {
						if (engines.get(metadata.id) === engine) engines.delete(metadata.id);
					},
				);
			}
			return handle;
		},
	};

	const host = createSharedProcessHost(inner, {
		maxWorkers: policy.maxSessions,
		retireAfterIdleMs: policy.retireAfterIdleMs,
		isHarnessIdle: policy.isHarnessIdle,
		onBeforeRetire: policy.onBeforeRetire,
		onAfterRetire: policy.onAfterRetire,
		onWorkerRefused: (refused) => policy.onEngineRefused?.(refused),
		onError: policy.onError,
	});

	// Full-stack handles (decorator slot + engine): closing one releases the
	// admission slot AND the engine's writer ownership. Shutdown must close
	// through these, never through the engines map alone — otherwise the
	// decorator's slot survives and a recovery open is answered by a dead
	// slot (the bug the acceptance caught).
	const handles = new Map<string, RoutedSessionHandle>();
	// Shutdown is an epoch, not a flag: an open that began before a shutdown
	// observes a different epoch when it completes and is refused+released;
	// opens begun after capture the current epoch and are admitted (recovery).
	let shutdownEpoch = 0;
	const trackedHost: ServerHost<SessionMetadata> = {
		serverServices: host.serverServices,
		resolveSession: (sessionId, context) => host.resolveSession(sessionId, context),
		async openSession(metadata: SessionMetadata, context: Context): Promise<RoutedSessionHandle> {
			const epoch = shutdownEpoch;
			const handle = await host.openSession(metadata, context);
			// A shutdown that began while this open was in flight owns the
			// outcome: refuse and release (slot + writer), or the engine escapes
			// tracking and holds its writer past the shutdown.
			if (epoch !== shutdownEpoch) {
				await handle.close(context).catch(() => undefined);
				throw new Error(`Session ${metadata.id} refused: runtime is shutting down`);
			}
			handles.set(metadata.id, handle);
			return handle;
		},
	};

	const control: InProcessRuntimeControl = {
		pid,
		identities(): InProcessSessionIdentity[] {
			return [...engines.values()].map((engine) => engine.identity);
		},
		async shutdown(context: Context): Promise<void> {
			shutdownEpoch++;
			const closing = [...handles.values()];
			handles.clear();
			const results = await Promise.allSettled(closing.map((handle) => handle.close(context)));
			const errors = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to shut down in-process session engines");
		},
	};

	return { host: trackedHost, control };
}

function wrapEngineAttachment(
	engine: InProcessSessionEngine,
	lease: InProcessSessionAttachment,
): RoutedSessionAttachment {
	return {
		async invokeService(
			call: ServiceCall,
			publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
			context: Context,
		): Promise<JsonValue | undefined> {
			return lease.invokeService(call, publish, context);
		},
		async release(context: Context): Promise<void> {
			await lease.release(context);
		},
	};
}

export { SharedProcessCapacityError } from "./shared-process.ts";
export type { SharedProcessPolicy, WorkerIdentity } from "./shared-process.ts";
