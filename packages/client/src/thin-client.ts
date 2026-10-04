import type { JsonValue, RemoteServiceTransport, ServiceCall } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/**
 * Real thin-client leg (pD) for the shared-host canary seam
 * (`packages/coding-agent/src/experimental/durable/shared-host-canary.ts`
 * exports the interface and a labeled synthetic provider stand-in).
 *
 * Factory shape is the canary's contract: `(sessionId, invoke) => ThinClient`
 * where `invoke({member, args})` routes to the engine's `invokeService`.
 * Members used (engine-compatible as landed): `submit` with `args: [text]`,
 * `observe` with no args returning `readonly string[]`. No seam adjustment
 * needed — the impls meet there unchanged.
 *
 * What the real leg adds over the stand-in: ordered/serialized submits (no
 * interleaving under concurrency), close semantics (idempotent close, rejects
 * submit/observe afterwards, drains in-flight submits), and payload
 * validation on observe. Duplicate-send protection at the wire layer lives in
 * the session-presentation client (seq/ack replay); this leg is exactly-once
 * per call.
 *
 * Default OFF: constructed only by tests or an explicit canary/entry; no
 * model/provider calls anywhere in this file.
 */
export interface ThinClient {
	readonly sessionId: string;
	submit(text: string): Promise<void>;
	observe(): Promise<readonly string[]>;
	close(): Promise<void>;
}

export type Invoke = (call: { member: string; args?: unknown[] }) => Promise<unknown>;

export function createThinClient(sessionId: string, invoke: Invoke): ThinClient {
	let closed = false;
	let queue: Promise<unknown> = Promise.resolve();
	const guard = (): void => {
		if (closed) throw new Error(`thin client ${sessionId} is closed`);
	};
	return {
		sessionId,
		submit(text: string): Promise<void> {
			try {
				guard();
			} catch (error) {
				return Promise.reject(error);
			}
			// Serialize submissions: the engine's transcript order must match
			// submit order even when callers fire concurrently.
			const run = queue.then(() => invoke({ member: "submit", args: [text] }));
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			return run.then(() => undefined);
		},
		async observe(): Promise<readonly string[]> {
			guard();
			const result = await invoke({ member: "observe" });
			if (!Array.isArray(result) || result.some((line) => typeof line !== "string")) {
				throw new Error(`thin client ${sessionId}: observe returned a non-string[] payload`);
			}
			return result as readonly string[];
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await queue;
		},
	};
}

/**
 * Bridge a chord service transport into the factory's `invoke` shape, so the
 * real leg plugs over the wire (client-attach transports) exactly as it plugs
 * into the canary's in-process attachment.
 */
export function createSessionInvoke(
	transport: RemoteServiceTransport,
	serviceId = "canary.session",
): Invoke {
	return (call) => {
		const serviceCall: ServiceCall = { serviceId, member: call.member, args: (call.args ?? []) as JsonValue[] };
		return transport.invoke(serviceCall, BACKGROUND_CONTEXT);
	};
}
