/**
 * contractFixture — the shared falsifier fixture (p9, 005 track). Synthetic
 * writer tracking with (session, generation) keys, identity/engine builders,
 * and fail-fast checks. Public synthetic fixtures only.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { InProcessSessionEngine, InProcessSessionIdentity } from "../src/in-process-runtime.ts";
import type { SessionMetadata } from "../src/types.ts";

export const CONTEXT = BACKGROUND_CONTEXT;

export function metadata(id: string): SessionMetadata {
	return { id };
}

export function identityFor(sessionId: string, generation: number, pid = process.pid): InProcessSessionIdentity {
	return { sessionId, generation, pid, model: "in-process" };
}

/** Exactly-one durable-writer acquisition per (session, generation). */
export class WriterTracker {
	readonly acquisitions = new Map<string, number>();
	readonly releases = new Map<string, number>();
	acquire(sessionId: string, generation: number): void {
		const key = `${sessionId}#${generation}`;
		const count = (this.acquisitions.get(key) ?? 0) + 1;
		this.acquisitions.set(key, count);
		if (count > 1) throw new Error(`double writer acquisition for ${key}`);
	}
	release(sessionId: string, generation: number): void {
		const key = `${sessionId}#${generation}`;
		this.releases.set(key, (this.releases.get(key) ?? 0) + 1);
	}
	releasedExactlyOnce(): boolean {
		return [...this.releases.values()].every((count) => count === 1);
	}
}

export function engineWith(
	identity: InProcessSessionIdentity,
	tracker: WriterTracker,
	onClose?: () => void | Promise<void>,
): InProcessSessionEngine {
	return {
		identity,
		attach: () => ({ invokeService: async () => undefined, release: async () => undefined }),
		close: async () => {
			tracker.release(identity.sessionId, identity.generation);
			await onClose?.();
		},
	};
}

export class Checks {
	failures = 0;
	check(label: string, condition: boolean): void {
		if (condition) {
			console.log(`PASS ${label}`);
			return;
		}
		this.failures += 1;
		console.error(`FAIL ${label}`);
	}
	finish(name: string): void {
		if (this.failures > 0) {
			console.error(`${name}: ${this.failures} FAILURE(S)`);
			process.exit(1);
		}
		console.log(`${name}: ALL PASS`);
	}
}
