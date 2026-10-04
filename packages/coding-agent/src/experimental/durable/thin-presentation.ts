/**
 * Thin-presentation slice (pD, PORT-PI-1229) — CLIENT presentation acceptance.
 *
 * Connects demand attach/detach/re-attach through the EXISTING ThinClient API
 * (`submit`/`observe`/`close`, factory shape) to a REAL rendered presentation
 * built from existing pi-tui widgets (Container/Text/Input — reuse, no
 * cosmetics, no parallel protocol). Reuses the transport stack untouched.
 *
 * PUBLISHED ADAPTER TRANSITION (app-owned surfaces, not taken over here):
 * - native presenter call site: `experimental/durable/main.ts:17`
 *   `runDurableTui(durable.view, durable.controller, durable.settings)` with
 *   `Handlers {submit, followUp, abort, exit, …}` at `tui.ts:145`;
 *   owner = the durable-harness slice (p2 T1/T2) + SDK parity (p9).
 *   Transition: wire those handlers to `createThinHandlers(...)` from this
 *   module and the native DurableTui drives a shared session unchanged.
 * - engine binding: `InProcessSessionEngine.attach().invokeService` members
 *   `submit`/`observe` (as landed) and turn-cancel; **cancel-on-wire is
 *   p9's SDK cancel parity overlay** (owner p9) — `abort()` here is the
 *   presentation-level cancel (drops in-flight invoke, resyncs state) and
 *   renders the observable marker until the overlay lands.
 *
 * Lifecycle: presentation state exists only after first use (demand attach
 * via the lazy factory); `exit()` closes the leg (detach+disconnect) and the
 * next `submit` re-attaches on demand (re-attach through the same factory).
 */
import { Container, type Component, Input, Text } from "@earendil-works/pi-tui";
import type { ThinClient } from "@earendil-works/pi-client";

export interface ThinPresentationOptions {
	/** Creates the leg on demand (typically `createLazyThinClient`). */
	create: () => ThinClient;
	/** Called with each observed state snapshot (stream/state surface). */
	onState?: (lines: readonly string[]) => void;
	/** Poll period for streaming state; 0 disables (default 250 ms, unref'd). */
	pollMs?: number;
}

export interface ThinPresentation {
	readonly component: Component;
	submit(text: string): Promise<void>;
	abort(): void;
	exit(): Promise<void>;
	refresh(): Promise<void>;
	status(): { attached: boolean; cancelled: boolean; attachedGeneration: number };
	dispose(): void;
}

export function createThinPresentation(options: ThinPresentationOptions): ThinPresentation {
	const log = new Container();
	const input = new Input();
	let leg: ThinClient | undefined;
	let opening: Promise<ThinClient> | undefined;
	let cancelled = false;
	let attachedGeneration = 0;
	let disposed = false;
	const append = (line: string): void => {
		log.addChild(new Text(line, 1, 0));
	};
	const ensure = async (): Promise<ThinClient> => {
		if (disposed) throw new Error("thin presentation disposed");
		if (leg) return leg;
		opening ??= Promise.resolve(options.create()).then((created) => {
			leg = created;
			attachedGeneration += 1;
			cancelled = false;
			append(`[thin] attach demand (generation ${attachedGeneration})`);
			return created;
		});
		const current = opening;
		return current.catch((error: unknown) => {
			if (opening === current) opening = undefined;
			throw error;
		});
	};
	const refresh = async (): Promise<void> => {
		const current = leg;
		if (!current) return;
		const lines = await current.observe();
		options.onState?.(lines);
	};
	const submit = async (text: string): Promise<void> => {
		const current = await ensure();
		await current.submit(text);
		append(`[thin] submit visible: ${text}`);
		await refresh();
	};
	input.onSubmit = (value: string) => {
		const text = value.trim();
		if (text.length === 0) return;
		input.setValue("");
		if (text === "exit" || text === "/exit") {
			void exit(); // printable disconnect; Ctrl-D/Ctrl-X also mapped
			return;
		}
		void submit(text);
	};
	const root = new Container();
	root.addChild(log);
	root.addChild(input);
	const component: Component = {
		render: (width: number) => root.render(width),
		invalidate: () => root.invalidate(),
		handleInput: (data: string) => {
			if (data === "\x03" || data === "\x1b") {
				aborts();
				return;
			}
			if (data === "\x04" || data === "\x18") {
				// Ctrl-D, with Ctrl-X as a PTY-safe twin
				void exit();
				return;
			}
			input.handleInput(data);
		},
	};
	const aborts = (): void => {
		cancelled = true;
		// Presentation-level cancel: drop the in-flight surface and resync.
		// Turn-cancel on the wire = p9's SDK overlay (published transition).
		append("[thin] cancel (presentation; SDK turn-cancel = p9 overlay)");
		void refresh();
	};
	const exit = async (): Promise<void> => {
		const current = leg;
		leg = undefined;
		opening = undefined;
		append("[thin] disconnect (leg closed; next submit re-attaches on demand)");
		if (current) await current.close();
	};
	const poll =
		options.pollMs === 0
			? undefined
			: setInterval(() => void refresh().catch(() => undefined), options.pollMs ?? 250);
	poll?.unref?.();
	append("[thin] presentation ready (no state until first use)");
	return {
		component,
		submit,
		abort: aborts,
		exit,
		refresh,
		status: () => ({ attached: leg !== undefined, cancelled, attachedGeneration }),
		dispose(): void {
			disposed = true;
			if (poll) clearInterval(poll);
			const current = leg;
			leg = undefined;
			opening = undefined;
			if (current) void current.close();
		},
	};
}
