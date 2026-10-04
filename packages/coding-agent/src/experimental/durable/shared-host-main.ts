/**
 * Shared-host entry (330 MANIFEST item 12, post-freeze slice).
 *
 * Real entry: openDurable per-session engines through the in-process seam.
 * DEFAULT OFF — importing this module runs nothing; the entry activates only
 * when invoked directly (import.meta.main) or when an application calls
 * createSharedHostMain. No fleet activation: nothing here is wired to a
 * default path, and no model calls happen unless a caller drives the
 * controller.
 *
 * The seam consumed: InProcess* + createInProcessRuntime (#1) +
 * SharedHostCore (#4) from @earendil-works/pi-server (assembly exports per
 * #3). The thin-client/presentation leg is pD's; this entry only hosts
 * engines and books presentation demand via the core.
 */
import type {
	InProcessEngineFactory,
	InProcessRuntime,
	InProcessSessionEngine,
	InProcessSessionIdentity,
	SessionMetadata,
	SharedHostCore,
	SharedHostHooks,
	SharedHostPolicy,
} from "@earendil-works/pi-server";
import { type OpenDurableOptions, type OpenDurableResult, openDurable } from "./runtime.ts";
import { composeSharedHost, dispatchDurableMember, durableEngineShell } from "./shared-host-dispatch.ts";

export type DurableOptionsResolver = (
	metadata: SessionMetadata,
	identity: InProcessSessionIdentity,
) => OpenDurableOptions | Promise<OpenDurableOptions>;

export interface SharedHostMainOptions {
	/** Cap policy for the shared host (refuse, never queue). */
	readonly policy: SharedHostPolicy;
	readonly hooks?: SharedHostHooks;
	/** Forwarded to openDurable for each session engine (fixed or per-session). */
	readonly durable?: OpenDurableOptions | DurableOptionsResolver;
}

export interface SharedHostMain {
	readonly runtime: InProcessRuntime;
	readonly core: SharedHostCore;
	close(): Promise<void>;
}

function wrapDurable(identity: InProcessSessionIdentity, opened: OpenDurableResult): InProcessSessionEngine {
	return durableEngineShell(
		identity,
		(call) => dispatchDurableMember(opened, call),
		// Releases this session's exclusive durable writer ownership.
		async () => {
			await opened.close();
		},
	);
}

export function durableEngineFactory(
	options: OpenDurableOptions | DurableOptionsResolver = {},
): InProcessEngineFactory {
	return {
		async open(metadata, identity): Promise<InProcessSessionEngine> {
			// Application-owned per-session context: the resolver carries each
			// session's own open options (cwd, continuation) without sharing.
			const resolved = typeof options === "function" ? await options(metadata, identity) : options;
			const opened = await openDurable(resolved);
			return wrapDurable(identity, opened);
		},
	};
}

export async function createSharedHostMain(options: SharedHostMainOptions): Promise<SharedHostMain> {
	return composeSharedHost(durableEngineFactory(options.durable), options.policy, options.hooks);
}

/** The real entry: a shared host with durable engines. DEFAULT OFF. */
export async function main(): Promise<void> {
	const host = await createSharedHostMain({ policy: { maxSessions: 8 } });
	process.stdout.write(`shared-host ready pid=${host.runtime.control.pid}\n`);
	const shutdown = (): void => {
		void host.close().then(
			() => process.exit(0),
			() => process.exit(3),
		);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

if (import.meta.main) {
	void main();
}
