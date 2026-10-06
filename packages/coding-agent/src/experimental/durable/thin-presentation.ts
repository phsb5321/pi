/**
 * Thin presentation v2 — LAZY + SHARED (100x AIM, pD).
 *
 * The presentation tier is the binding constraint (53 MiB/presentation →
 * 16 GiB at 306). This slice targets ≤ 2 MiB/presentation (≤ 6 MiB = 10x):
 *
 * - **Attach on first render:** the leg (`ThinClient`) is created inside the
 *   first `render()` call — not at construction, not at first input.
 * - **No per-presentation TUI until painted:** construction holds closures +
 *   a string log only; the widget tree (Input + focus surface) is built at
 *   first paint and rebuilt never (invalidate() clears only the measured
 *   cache, not the tree).
 * - **Shared glyph/theme/width caches (S11 learnings):** one module-level
 *   cache memoizes styled+measured line renders keyed by (width, text) across
 *   ALL presentations; theme resolution and glyph segmentation stay on pi-tui
 *   shared singletons. Per-presentation render state is O(1) plus the string
 *   log; no per-line widget objects are ever allocated.
 *
 * Marker strings are the acceptance contract (thin-residency-acceptance.ts
 * captures them from the PTY): `[thin] presentation ready`, `[thin] attach
 * demand (generation N)`, `[thin] submit visible: X`, `[thin] cancel …`,
 * `[thin] disconnect …`.
 *
 * The architecture table is pE's research deliverable (R-A seat) — this file
 * implements the slice and does not duplicate that table.
 */
import { Container, type Component, Input, Text } from "@earendil-works/pi-tui";
import type { ThinClient } from "@earendil-works/pi-client";

export interface ThinPresentationOptions {
	/** Creates the leg on demand at first paint (typically `createLazyThinClient`). */
	create: () => ThinClient;
	/** Windowed view buffer size (R-A win20 shape: 0.53–0.64 MiB measured).
	 *  FOLD-IN POINT for pF's state-floor number: `window = clamp(pF per-surface
	 *  floor / per-entry bytes, 1, 256)` — the constant stays here. */
	window?: number;
	/** Surface identity (A1/A9: one writer per surface; lease = surfaceId). */
	surfaceId?: string;
	/** Called with each observed state snapshot (stream/state surface). */
	onState?: (lines: readonly string[]) => void;
	/** Poll period for streaming state; 0 disables (default 250 ms, unref'd). */
	pollMs?: number;
}

/** Presentation geometry (A3): drives the windowed rendering anchor. */
export interface PresentationGeometry {
	rows: number;
	cols: number;
	/** Window anchor: the view renders the window ENDING at the viewport top+offset. */
	viewportTop: number;
	mode: "main" | "alt";
}

export interface ThinPresentation {
	readonly component: Component;
	readonly surfaceId: string;
	/** A1: the attach generation (host `attachGeneration` model; stale-surface
	 *  writes are refused across re-attach). */
	readonly attachGeneration: number;
	setGeometry(geometry: PresentationGeometry): void;
	submit(text: string): Promise<void>;
	abort(): void;
	exit(): Promise<void>;
	refresh(): Promise<void>;
	status(): {
		attached: boolean;
		cancelled: boolean;
		attachedGeneration: number;
		painted: boolean;
		surfaceId: string;
		geometry: PresentationGeometry;
	};
	dispose(): void;
}

/** Shared styled+measured line cache (S11 lesson: measure work is per-line,
 *  per-width and identical across presentations — share it). */
const sharedLineCache = new Map<string, string[]>();
const SHARED_CACHE_MAX = 512;
function sharedRenderLine(line: string, width: number, style: (text: string) => string): string[] {
	const key = `${width}\u0000${line}`;
	const cached = sharedLineCache.get(key);
	if (cached !== undefined) {
		sharedLineCache.delete(key);
		sharedLineCache.set(key, cached); // recency
		return cached;
	}
	const rendered = new Text(style(line), 1, 0).render(width);
	sharedLineCache.set(key, rendered);
	if (sharedLineCache.size > SHARED_CACHE_MAX) {
		const oldest = sharedLineCache.keys().next();
		if (!oldest.done) sharedLineCache.delete(oldest.value);
	}
	return rendered;
}

/** Per-process presentation stats (for the measured cost row + cases). */
export const presentationStats = {
	created: 0,
	painted: 0,
	widgetsBuilt: 0,
	cacheHits: 0,
	cacheMisses: 0,
};

export function resetPresentationStats(): void {
	presentationStats.created = 0;
	presentationStats.painted = 0;
	presentationStats.widgetsBuilt = 0;
	presentationStats.cacheHits = 0;
	presentationStats.cacheMisses = 0;
}

export function createThinPresentation(options: ThinPresentationOptions): ThinPresentation {
	presentationStats.created += 1;
	const surfaceId = options.surfaceId ?? "surface-1";
	let geometry: PresentationGeometry = { rows: 24, cols: 80, viewportTop: 0, mode: "main" };
	const windowSize = Math.max(1, options.window ?? 20);
	const view: string[] = ["[thin] presentation ready (no state until first use)"];
	const append = (line: string): void => {
		view.push(line);
		// Windowed view buffer (R-A verdict: unwindowed transcripts re-create
		// the tier constraint; the 20-msg window is the measured shape).
		if (view.length > windowSize) view.splice(0, view.length - windowSize);
	};
	let leg: ThinClient | undefined;
	let opening: Promise<ThinClient> | undefined;
	let cancelled = false;
	let attachedGeneration = 0;
	let disposed = false;
	let painted = false;

	// Widget tree — built at first paint only (no per-presentation TUI until
	// painted); kept for the lifetime of the presentation.
	let input: Input | undefined;
	let root: Container | undefined;
	const ensurePainted = (): void => {
		if (root !== undefined) return;
		presentationStats.painted += 1;
		presentationStats.widgetsBuilt += 2; // Input + Container (log renders as lines)
		root = new Container();
		input = new Input();
		root.addChild(input);
		input.onSubmit = (value: string) => {
			const text = value.trim();
			if (text.length === 0) return;
			input?.setValue("");
			if (text === "exit" || text === "/exit") {
				void exit();
				return;
			}
			void submit(text);
		};
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
	let lastObserved = "";
	const refresh = async (): Promise<void> => {
		const current = leg;
		if (!current) return;
		const lines = await current.observe();
		options.onState?.(lines);
		// Windowed view state: the observed messages ARE the presentation
		// content (R-A win20 shape) — appended on change only, capped at the
		// window, oldest dropped first.
		const joined = lines.join("\n");
		if (joined !== lastObserved) {
			lastObserved = joined;
			for (const line of lines) append(line);
		}
	};
	const submit = async (text: string): Promise<void> => {
		const current = await ensure();
		await current.submit(text);
		append(`[thin] submit visible: ${text}`);
		await refresh();
	};
	const aborts = (): void => {
		cancelled = true;
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

	const setGeometry = (next: PresentationGeometry): void => {
		geometry = next;
	};
	const component: Component = {
		render: (width: number) => {
			ensurePainted();
			void ensure().catch(() => undefined);
			// A3/R3: the window anchors to the viewport; entries above the
			// viewport top are dropped from the render (never re-materialized).
			const anchor = Math.max(0, view.length - geometry.viewportTop);
			const windowed = view.slice(Math.max(0, anchor - windowSize), anchor);
			const lines: string[] = [];
			for (const entry of windowed) {
				const key = `${width}\u0000${entry}`;
				if (sharedLineCache.has(key)) presentationStats.cacheHits += 1;
				else presentationStats.cacheMisses += 1;
				lines.push(...sharedRenderLine(entry, width, (text) => text));
			}
			lines.push(...(root as Container).render(width));
			return lines;
		},
		invalidate: () => {
			root?.invalidate();
		},
		handleInput: (data: string) => {
			ensurePainted();
			if (data === "\x03" || data === "\x1b") {
				aborts();
				return;
			}
			if (data === "\x04" || data === "\x18") {
				void exit();
				return;
			}
			input?.handleInput(data);
		},
	};

	const poll =
		options.pollMs === 0
			? undefined
			: setInterval(() => void refresh().catch(() => undefined), options.pollMs ?? 250);
	poll?.unref?.();
	return {
		component,
		surfaceId,
		get attachGeneration(): number {
			return attachedGeneration;
		},
		setGeometry,
		submit,
		abort: aborts,
		exit,
		refresh,
		status: () => ({ attached: leg !== undefined, cancelled, attachedGeneration, painted, surfaceId, geometry }),
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
