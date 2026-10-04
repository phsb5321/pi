import type { JsonValue, RemoteServiceTransport, ServiceCall } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionTarget } from "@earendil-works/pi-protocol";
import type { Client } from "./index.ts";
import { createClientServiceTransport } from "./client.ts";
import { DisconnectedError } from "./errors.ts";

export const SESSION_MANAGEMENT_SERVICE = "pi.session-management";

/** One headless presentation attached to one hosted session. */
export interface AttachedSession {
	readonly sessionId: string;
	/** The routed identity ({serverId, sessionId, attachmentId}); undefined after detach. */
	readonly target: SessionTarget | undefined;
	/** Chord service transport bound to this attachment (invokeService round-trips). */
	readonly transport: RemoteServiceTransport;
	/** Convenience: `transport.invoke(call, BACKGROUND_CONTEXT)`. */
	invoke(call: ServiceCall): Promise<JsonValue | undefined>;
	/** Detach (best effort) and drop the route. */
	detach(): Promise<void>;
}

export interface AttachSessionsOptions {
	/**
	 * One fresh connection per session. The server contract keeps ONE routed
	 * attachment per presentation connection (`SessionRouter.attachClientNow`),
	 * so two hosted sessions take two connections.
	 */
	connect: () => Promise<Client>;
	sessionIds: readonly string[];
}

/**
 * Headless attach driver for the shared-isolate canary (330 slice): attach to
 * hosted sessions over the existing `Client`/protocol stack, expose a chord
 * `RemoteServiceTransport` per attachment (`createClientServiceTransport`) for
 * invokeService round-trips (echo/state), and handle detach semantics.
 *
 * Idempotent attach (server contract): re-attaching the same session on the
 * same connection is a no-op — the router keeps the existing attachment
 * (same `attachmentId`, no second route publish). Attaching to a different
 * session releases the previous route and publishes a new one.
 *
 * Synthetic-only composition surface; default OFF (nothing constructs these
 * outside tests or an explicit canary entry); no model/provider calls.
 */
export async function attachSession(client: Client, sessionId: string): Promise<AttachedSession> {
	const attaching = client.request({ serverId: client.serverId }, {
		serviceId: SESSION_MANAGEMENT_SERVICE,
		member: "attach",
		args: [sessionId],
	});
	await attaching;
	const target = client.attachment;
	if (target === undefined || target.sessionId !== sessionId) {
		throw new Error(`attach did not route session ${sessionId}`);
	}
	const transport = createClientServiceTransport(client, () => client.attachment);
	return {
		sessionId,
		get target() {
			return client.attachment;
		},
		transport,
		invoke: (call) => transport.invoke(call, BACKGROUND_CONTEXT),
		async detach() {
			if (!client.connected || client.attachment?.sessionId !== sessionId) return;
			await client.request({ serverId: client.serverId }, {
				serviceId: SESSION_MANAGEMENT_SERVICE,
				member: "detach",
				args: [],
			});
		},
	};
}

/**
 * Headless attach to several hosted sessions (one fresh connection each, per
 * the one-route-per-connection server contract). Each entry carries its own
 * attachment and service transport.
 */
export async function attachSessions(options: AttachSessionsOptions): Promise<AttachedSession[]> {
	const sessions: AttachedSession[] = [];
	try {
		for (const sessionId of options.sessionIds) {
			sessions.push(await attachSession(await options.connect(), sessionId));
		}
		return sessions;
	} catch (error) {
		await Promise.all(sessions.map((session) => session.detach()));
		throw error;
	}
}

/** The routed target of a connection, or DisconnectedError when no session is attached. */
export function requireSessionTarget(client: Client, sessionId: string): SessionTarget {
	const target = client.attachment;
	if (target === undefined || target.sessionId !== sessionId) throw new DisconnectedError();
	return target;
}
