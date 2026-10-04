/**
 * Thin-residency binding (pD, PORT-PI-BLOCKERS-1315) — CLIENT-side binding to
 * the EXACT committed adapter in `ms/composition-1241` (693a01802:
 * `shared-host-residency.ts` + `shared-host-dispatch.ts` +
 * `packages/server/src/retained-history.ts`). No p4/p9 source edits; this is
 * my own client/presentation slice consuming their committed seam.
 *
 * MINIMAL CALLER CONTRACT (published from the composition source):
 * - host: `createSharedHostResidency({ policy, hooks?, hydrate: { root, onState? } })`
 *   -> `{ runtime, core, close() }`; per-session cwd lives under `hydrate.root`;
 *   `sdkResidencyHydrate` opens the REAL durable session
 *   (`openDurable({cwd, continueSession})`) and parks/rehydrates via
 *   `withRetainedHistory` (quiescence-gated).
 * - attachment: `runtime.host.openSession({id})` -> `attachClient(ctx)` ->
 *   `invokeService({ member, args })` with members
 *   `DURABLE_MEMBERS = { submit, compact, abort, cycleThinking, setModel,
 *   switchConversation, view }` plus the adapter-state member `residency`.
 * - mapping to the required acceptance surface:
 *   input -> `submit`; deltas -> `view`; tool events -> `view` tool entries;
 *   active-cancel -> `abort`; close -> engine close + attachment release;
 *   re-attach -> a new attach on the same durable session; cwd/history ->
 *   `residency` record + `view`/`switchConversation` (park/rehydrate keeps
 *   the durable record across the cycle).
 *
 * NEGATIVE CASES (contract-derived; asserted by the acceptance):
 * - unknown member -> Error naming the allowed set;
 * - non-`residency` calls while parked -> gated by the serialized
 *   hydration gate (await, then rehydrate on first call);
 * - `residency` works regardless of engine liveness;
 * - double-close / post-close calls are rejected client-side;
 * - attach of an unknown session -> bounded routing error.
 */
import type { ThinClient } from "@earendil-works/pi-client";

export const DURABLE_MEMBERS = [
	"submit",
	"compact",
	"abort",
	"cycleThinking",
	"setModel",
	"switchConversation",
	"view",
] as const;
export type DurableMember = (typeof DURABLE_MEMBERS)[number];

export type ResidencyInvoke = (call: { member: string; args?: unknown[] }) => Promise<unknown>;

export interface ResidencyRecordView {
	readonly sessionId: string;
	readonly cwd: string;
	readonly nativeSessionId: string;
	readonly directory: string;
	readonly released: number;
	readonly resumed: number;
	readonly live: boolean;
}

/** Typed client over the committed adapter's member set (no parallel protocol). */
export class ResidencyClient {
	#invoke: ResidencyInvoke;
	#closed = false;

	constructor(invoke: ResidencyInvoke) {
		this.#invoke = invoke;
	}

	get closed(): boolean {
		return this.#closed;
	}

	call<T = unknown>(member: DurableMember | "residency", args?: unknown[]): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("residency client closed"));
		return this.#invoke({ member, args }) as Promise<T>;
	}

	submit(text: string): Promise<unknown> {
		return this.call("submit", [text]);
	}

	view(): Promise<unknown> {
		return this.call("view");
	}

	abort(): Promise<unknown> {
		return this.call("abort");
	}

	compact(): Promise<unknown> {
		return this.call("compact");
	}

	switchConversation(target: string): Promise<unknown> {
		return this.call("switchConversation", [target]);
	}

	residency(): Promise<ResidencyRecordView> {
		return this.call<ResidencyRecordView>("residency");
	}

	close(): void {
		this.#closed = true;
	}
}

/**
 * Adapt the residency client to the EXISTING ThinClient API so the rendered
 * thin presentation (and its acceptance) drives the real engine unchanged:
 * `submit` -> durable submit; `observe` -> the view's text lines; `close` ->
 * client close (engine/attachment lifecycle stays with the caller).
 */
export function toThinClient(client: ResidencyClient, sessionId: string): ThinClient {
	return {
		sessionId,
		submit: (text: string) => client.submit(text).then(() => undefined),
		observe: async (): Promise<readonly string[]> => {
			const view = await client.view();
			const lines = (view as { lines?: unknown }).lines;
			if (Array.isArray(lines)) return lines.map((line) => String(line));
			return [JSON.stringify(view ?? null)];
		},
		close: async () => {
			client.close();
		},
	};
}
