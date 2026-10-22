import { createUnixServer } from "@earendil-works/pi-server/unix";
import { createExperimentalServerServices } from "../services/server.ts";
import { createSharedHostResidency, type SharedHostResidencyOptions } from "./shared-host-residency.ts";

/** Opt-in, fixed private session partition. No discovery, model turn or live migration. */
export async function createSharedDurableUnixHost(
	options: SharedHostResidencyOptions & {
		readonly socket: string;
		readonly serverId: string;
		readonly sessions: readonly string[];
	},
) {
	const ids = new Set(options.sessions);
	if (ids.size !== options.sessions.length || ids.size === 0 || ids.size > options.policy.maxSessions)
		throw new Error("Invalid private pilot session partition");
	for (const id of ids) {
		if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid private pilot session id");
	}
	const host = await createSharedHostResidency(options);
	const unsupported = async (): Promise<never> => {
		throw new Error("Private pilot session partition is immutable");
	};
	const services = await createExperimentalServerServices({
		list: async () => [...ids].map((sessionId) => ({ serverId: options.serverId, sessionId, createdAt: 0 })),
		create: unsupported,
		remove: unsupported,
		prepareSessionPlugins: unsupported,
		reloadPresentationPlugins: unsupported,
	});
	const server = createUnixServer(
		{
			serverServices: services.host,
			async resolveSession(id) {
				if (!ids.has(id)) throw new Error("Unknown private pilot session");
				return { id };
			},
			openSession: (metadata, context) => host.runtime.host.openSession(metadata, context),
		},
		{ path: options.socket, serverId: options.serverId },
	);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		try {
			await server.close();
		} finally {
			try {
				await services.dispose();
			} finally {
				await host.close();
			}
		}
	};
	try {
		await server.start();
	} catch (error) {
		await close();
		throw error;
	}
	return { ...host, close };
}
