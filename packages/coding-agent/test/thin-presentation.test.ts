import { describe, expect, it } from "vitest";
import type { ThinClient } from "@earendil-works/pi-client";
import {
	createThinPresentation,
	presentationStats,
	resetPresentationStats,
} from "../src/experimental/durable/thin-presentation.ts";

function stubLeg(): ThinClient & { submitted: string[] } {
	const submitted: string[] = [];
	return {
		sessionId: "s1",
		submitted,
		async submit(text: string) {
			submitted.push(text);
		},
		async observe() {
			return [...submitted];
		},
		async close() {},
	};
}

describe("thin-presentation v2 (lazy + shared, 100x presentation tier)", () => {
	it("construction builds no widgets and attaches nothing", () => {
		resetPresentationStats();
		let creates = 0;
		const presentation = createThinPresentation({
			create: () => {
				creates += 1;
				return stubLeg();
			},
			pollMs: 0,
		});
		expect(creates).toBe(0);
		expect(presentationStats.widgetsBuilt).toBe(0);
		expect(presentation.status().painted).toBe(false);
		expect(presentation.status().attached).toBe(false);
		presentation.dispose();
	});

	it("first render paints once and attaches on demand; repaints do not rebuild", () => {
		resetPresentationStats();
		let creates = 0;
		const presentation = createThinPresentation({
			create: () => {
				creates += 1;
				return stubLeg();
			},
			pollMs: 0,
		});
		const first = presentation.component.render(80);
		const second = presentation.component.render(80);
		expect(first.length).toBeGreaterThan(0);
		expect(second.length).toBeGreaterThan(0);
		expect(creates).toBe(1); // attach on first render, exactly once
		expect(presentationStats.painted).toBe(1);
		expect(presentationStats.widgetsBuilt).toBe(2); // Input + Container only
		presentation.dispose();
	});

	it("shared glyph/theme/width cache is reused across presentations", () => {
		resetPresentationStats();
		const make = () => createThinPresentation({ create: () => stubLeg(), pollMs: 0 });
		const one = make();
		const two = make();
		one.component.render(100);
		const missesAfterFirst = presentationStats.cacheMisses;
		two.component.render(100); // identical (line,width) entries → cache hits
		expect(presentationStats.cacheMisses).toBe(missesAfterFirst);
		expect(presentationStats.cacheHits).toBeGreaterThan(0);
		one.dispose();
		two.dispose();
	});

	it("keeps the acceptance marker strings (PTY capture contract)", async () => {
		resetPresentationStats();
		const leg = stubLeg();
		const presentation = createThinPresentation({ create: () => leg, pollMs: 0 });
		const rendered = (): string => presentation.component.render(80).join("\n");
		expect(rendered()).toContain("[thin] presentation ready");
		await presentation.submit("hello");
		expect(rendered()).toContain("[thin] attach demand (generation 1)");
		expect(rendered()).toContain("[thin] submit visible: hello");
		presentation.abort();
		expect(rendered()).toContain("[thin] cancel");
		await presentation.exit();
		expect(rendered()).toContain("[thin] disconnect");
		// exit() is a disconnect, not a dispose: the next submit re-attaches on
		// demand (the documented contract), with a new generation.
		await presentation.submit("again");
		expect(rendered()).toContain("[thin] attach demand (generation 2)");
		expect(rendered()).toContain("[thin] submit visible: again");
		presentation.dispose();
		await expect(presentation.submit("late")).rejects.toThrow(/disposed/);
		presentation.dispose();
	});

	it("dispose detaches without touching unpainted presentations", () => {
		resetPresentationStats();
		const presentation = createThinPresentation({ create: () => stubLeg(), pollMs: 0 });
		presentation.dispose();
		expect(presentationStats.widgetsBuilt).toBe(0);
		expect(presentation.status().attached).toBe(false);
	});
});

describe("windowed virtualized views (R-A win20 shape)", () => {
	it("keeps only the window: oldest entries drop as new ones arrive", async () => {
		resetPresentationStats();
		const leg = stubLeg();
		const presentation = createThinPresentation({ create: () => leg, pollMs: 0, window: 5 });
		presentation.component.render(80);
		for (let index = 0; index < 20; index++) await presentation.submit(`msg-${index}`);
		const rendered = presentation.component.render(80).join("\n");
		expect(rendered).toContain("msg-19");
		expect(rendered).not.toContain("msg-0");
		expect(rendered).not.toContain("[thin] presentation ready"); // evicted by the window
	});

	it("virtualizes: rendered output size is bounded by the window, not the log", async () => {
		resetPresentationStats();
		const leg = stubLeg();
		const presentation = createThinPresentation({ create: () => leg, pollMs: 0, window: 4 });
		presentation.component.render(80);
		for (let index = 0; index < 40; index++) await presentation.submit(`m${index}`);
		const rendered = presentation.component.render(80);
		// window (4) + input line(s): far below one line per submitted message
		expect(rendered.length).toBeLessThan(12);
	});

	it("unrendered presentation stays at construction cost (demand everything)", () => {
		resetPresentationStats();
		const presentation = createThinPresentation({ create: () => stubLeg(), pollMs: 0 });
		expect(presentationStats.widgetsBuilt).toBe(0);
		expect(presentationStats.painted).toBe(0);
		presentation.dispose();
		expect(presentationStats.created).toBe(1);
	});
});
