/**
 * shared-host-dispatch — the durable member dispatch, ONE copy (shared by the
 * real entry (shared-host-main) and the residency adapter
 * (shared-host-residency)). Provider-free members only; no model turns are
 * forced — `submit`/`setModel` reach the live controller and are only used
 * when an application explicitly drives them.
 */
import {
	type InProcessEngineFactory,
	type InProcessRuntime,
	type InProcessSessionEngine,
	type InProcessSessionIdentity,
	SharedHostCore,
	type SharedHostHooks,
	type SharedHostPolicy,
	createInProcessRuntime,
} from "@earendil-works/pi-server";
import type { OpenDurableResult } from "./runtime.ts";

/** Opaque service member map for one durable session engine. */
export const DURABLE_MEMBERS = new Set(["submit", "compact", "abort", "cycleThinking", "setModel", "switchConversation", "view"]);

export async function dispatchDurableMember(opened: OpenDurableResult, call: { member?: unknown; args?: unknown }): Promise<unknown> {
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
			throw new Error(`Unknown shared-host member: ${member || "<empty>"} (allowed: ${[...DURABLE_MEMBERS].join(", ")})`);
	}
}

/** One copy of the durable engine shell shape (identity/attach/close). */
export function durableEngineShell(
	identity: InProcessSessionIdentity,
	invokeService: (call: { member?: unknown; args?: unknown }) => Promise<unknown>,
	close: () => Promise<void>,
): InProcessSessionEngine {
	return {
		identity,
		async attach() {
			return {
				invokeService: async (call: { member?: unknown; args?: unknown }) => invokeService(call),
				release: async () => undefined,
			};
		},
		async close() {
			await close();
		},
	};
}

/** One copy of the shared-host composition shell (core + runtime + close). */
export function composeSharedHost(
	factory: InProcessEngineFactory,
	policy: SharedHostPolicy,
	hooks: SharedHostHooks | undefined,
): { runtime: InProcessRuntime; core: SharedHostCore; close(): Promise<void> } {
	const core = new SharedHostCore({ maxSessions: policy.maxSessions }, hooks);
	const runtime = createInProcessRuntime(factory, {
		maxSessions: policy.maxSessions,
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
