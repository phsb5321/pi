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
import {
	SharedHostCore,
	createInProcessRuntime,
	type InProcessEngineFactory,
	type InProcessRuntime,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
	type SharedHostHooks,
	type SharedHostPolicy,
} from "@earendil-works/pi-server";
import { type OpenDurableOptions, type OpenDurableResult, openDurable } from "./runtime.ts";

export interface SharedHostMainOptions {
	/** Cap policy for the shared host (refuse, never queue). */
	readonly policy: SharedHostPolicy;
	readonly hooks?: SharedHostHooks;
	/** Forwarded to openDurable for each session engine. */
	readonly durable?: OpenDurableOptions;
}

export interface SharedHostMain {
	readonly runtime: InProcessRuntime;
	readonly core: SharedHostCore;
	close(): Promise<void>;
}

/** Opaque service member map for one durable session engine. */
const DURABLE_MEMBERS = new Set(["submit", "compact", "abort", "cycleThinking", "setModel", "switchConversation", "view"]);

function wrapDurable(identity: InProcessSessionIdentity, opened: OpenDurableResult): InProcessSessionEngine {
	return {
		identity,
		async attach() {
			return {
				async invokeService(call: { member?: unknown; args?: unknown }) {
					const member = typeof call.member === "string" ? call.member : "";
					const args = Array.isArray(call.args) ? call.args : [];
					const controller = opened.controller;
					switch (member) {
						case "submit": {
							const text = String(args[0] ?? "");
							const whenBusy = args[1] === "steer" ? "steer" : "followUp";
							await controller.submit(text, whenBusy);
							return { ok: true };
						}
						case "compact":
							await controller.compact(args[0] === undefined ? undefined : String(args[0]));
							return { ok: true };
						case "abort":
							await controller.abort();
							return { ok: true };
						case "cycleThinking":
							await controller.cycleThinking();
							return { ok: true };
						case "setModel":
							await controller.setModel(args[0] as never);
							return { ok: true };
						case "switchConversation":
							await controller.switchConversation(String(args[0] ?? ""));
							return { ok: true };
						case "view": {
							const view = opened.view.current();
							return {
								session: view.session,
								conversations: view.conversations.length,
								models: view.models.length,
								notices: view.notices.length,
							};
						}
						default:
							throw new Error(
								`Unknown shared-host member: ${member || "<empty>"} (allowed: ${[...DURABLE_MEMBERS].join(", ")})`,
							);
					}
				},
				async release(): Promise<void> {
					// Presentation drop: per-presentation state lives in the view; the
					// engine-level release happens at handle.close.
				},
			};
		},
		async close(): Promise<void> {
			// Releases this session's exclusive durable writer ownership.
			await opened.close();
		},
	};
}

export function durableEngineFactory(options: OpenDurableOptions = {}): InProcessEngineFactory {
	return {
		async open(_metadata, identity): Promise<InProcessSessionEngine> {
			const opened = await openDurable(options);
			return wrapDurable(identity, opened);
		},
	};
}

export async function createSharedHostMain(options: SharedHostMainOptions): Promise<SharedHostMain> {
	const core = new SharedHostCore({ maxSessions: options.policy.maxSessions }, options.hooks);
	const runtime = createInProcessRuntime(durableEngineFactory(options.durable), {
		maxSessions: options.policy.maxSessions,
		// Retirement stays OFF at the entry (host policy decides later);
		// the seam enforces writer ownership and the cap regardless.
		onEngineRefused: (refused) => core.noteRefused(refused.sessionId),
	});
	return {
		runtime,
		core,
		async close(): Promise<void> {
			await runtime.control.shutdown({} as never);
		},
	};
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
