/**
 * Seam-only shared-host core (330). Consumes ONLY the published in-process
 * seam (InProcess* types + createInProcessRuntime); base-independent by
 * construction — it imports no server-router types, so it compiles on the
 * Chord-era (memory-sound) and PiServer (supported main) bases alike.
 *
 * The base-dependent glue (RoutedServerServiceHost / PiSessionRuntime
 * adapter) lives with the runtime; this core exposes the registry +
 * presentation bookkeeping that glue calls into. DEFAULT OFF: constructing
 * this runs nothing ambient.
 */
import type { InProcessRuntimeControl, InProcessSessionIdentity } from "./in-process-runtime.ts";

export interface SharedHostPolicy {
	/** Hard cap: over-cap opens are REFUSED (never queued). Positive integer. */
	readonly maxSessions: number;
}

export interface SharedHostHooks {
	/** Invoked when an open is refused at cap (bounded, recorded). */
	onEngineRefused?(sessionId: string): void;
}

export interface SharedHostState {
	readonly identities: readonly InProcessSessionIdentity[];
	readonly presentations: ReadonlyMap<string, number>;
}

/**
 * Application-side bookkeeping over the seam: presentation demand tracking
 * (the host decides retirement; the seam enforces writer ownership + cap).
 */
export class SharedHostCore {
	readonly #presentations = new Map<string, number>();
	readonly #policy: SharedHostPolicy;
	readonly #hooks: SharedHostHooks;

	constructor(policy: SharedHostPolicy, hooks: SharedHostHooks = {}) {
		if (!Number.isInteger(policy.maxSessions) || policy.maxSessions < 1) {
			throw new Error("maxSessions must be a positive integer");
		}
		this.#policy = policy;
		this.#hooks = hooks;
	}

	get policy(): SharedHostPolicy {
		return this.#policy;
	}

	/** Presentation demand for a session (attach/detach bookkeeping). */
	attach(sessionId: string): number {
		const next = (this.#presentations.get(sessionId) ?? 0) + 1;
		this.#presentations.set(sessionId, next);
		return next;
	}

	detach(sessionId: string): number {
		const next = Math.max(0, (this.#presentations.get(sessionId) ?? 0) - 1);
		if (next === 0) this.#presentations.delete(sessionId);
		else this.#presentations.set(sessionId, next);
		return next;
	}

	/** True when zero presentations remain (worker-retirement precondition). */
	isQuiescent(sessionId: string): boolean {
		return !this.#presentations.has(sessionId);
	}

	state(control: InProcessRuntimeControl): SharedHostState {
		return { identities: control.identities(), presentations: new Map(this.#presentations) };
	}

	/** Record a cap refusal without queueing (contract: refuse, not queue). */
	noteRefused(sessionId: string): void {
		this.#hooks.onEngineRefused?.(sessionId);
	}
}
