import type { JsonValue, RemoteServiceTransport, ServiceCall } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Client } from "./client.ts";
import { attachSession, type AttachedSession } from "./client-attach.ts";

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
export function createSessionInvoke(transport: RemoteServiceTransport, serviceId = "canary.session"): Invoke {
	return (call) => {
		const serviceCall: ServiceCall = { serviceId, member: call.member, args: (call.args ?? []) as JsonValue[] };
		return transport.invoke(serviceCall, BACKGROUND_CONTEXT);
	};
}

export interface LazyThinClientOptions {
	/** Creates the connection on first use — never at construction. */
	connect: () => Promise<Client>;
	sessionId: string;
	serviceId?: string;
}

/**
 * LAZY-PRESENTATION mode (target shape: thin/lazy presentations). The
 * presentation holds NO state until first render/request: no connection, no
 * attach, no transcript view. First submit/observe opens the connection and
 * attaches (idempotent under racing first-uses — one connect, one route
 * publish); `close()` before first use is a zero-cost no-op and afterwards
 * detaches and disconnects exactly once. Unrendered presentations cost only
 * their closure — the per-presentation row for p3's N-series.
 */
export function createLazyThinClient(options: LazyThinClientOptions): ThinClient {
	let session: AttachedSession | undefined;
	let connection: Client | undefined;
	let leg: ThinClient | undefined;
	let opening: Promise<ThinClient> | undefined;
	let closed = false;
	const ensure = async (): Promise<ThinClient> => {
		if (closed) throw new Error(`lazy thin client ${options.sessionId} is closed`);
		if (leg) return leg;
		opening ??= (async () => {
			const connected = await options.connect();
			const attached = await attachSession(connected, options.sessionId);
			connection = connected;
			session = attached;
			leg = createThinClient(options.sessionId, createSessionInvoke(attached.transport, options.serviceId));
			return leg;
		})();
		const current = opening;
		return current.catch((error: unknown) => {
			if (opening === current) opening = undefined; // allow retry after a failed open
			throw error;
		});
	};
	return {
		sessionId: options.sessionId,
		async submit(text: string): Promise<void> {
			await (await ensure()).submit(text);
		},
		async observe(): Promise<readonly string[]> {
			return (await ensure()).observe();
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const opened = leg;
			const attached = session;
			const connected = connection;
			leg = undefined;
			session = undefined;
			connection = undefined;
			opening = undefined;
			if (opened) await opened.close();
			if (attached) await attached.detach();
			if (connected) connected.disconnect();
		},
	};
}
