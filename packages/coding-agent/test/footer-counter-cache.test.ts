import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Behavior pin (1615 P6): the footer's live token counters must keep EXACT values through
// the SessionStats counter cache, and must refresh on change (entry growth), not per
// render. Fails if cached and uncached computation ever diverge (information loss) or if
// the on-change refresh regresses into per-frame recompute.

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

const assistantEntry = (usage: AssistantUsage) => ({
	type: "message",
	message: { role: "assistant", usage },
});

function createSession(entries: unknown[], walks: { count: number }): AgentSession {
	return {
		state: { model: { id: "test-model" } },
		model: { id: "test-model" },
		getContextUsage: () => ({ percent: 12.5, contextWindow: 1000 }),
		modelRuntime: { isUsingSubscription: () => false },
		sessionManager: {
			getEntries: () => {
				walks.count += 1;
				return entries;
			},
			getEntryCount: () => entries.length,
			getSessionId: () => "session-1",
			getLeafId: () => null,
			getCwd: () => "/home/test",
			getSessionName: () => undefined,
		},
	} as unknown as AgentSession;
}

const footerData = {
	getGitBranch: () => undefined,
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
} as unknown as ReadonlyFooterDataProvider;

const renderAll = (footer: FooterComponent): string => footer.render(120).map(stripAnsi).join("\n");

describe("footer counter cache is value-identical and on-change", () => {
	it("renders identical counters to the uncached computation and re-walks only on change", () => {
		initTheme("dark");
		const usage: AssistantUsage = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 0 } };

		// Uncached reference: a fresh component computes its stats on first render.
		const refWalks = { count: 0 };
		const reference = renderAll(new FooterComponent(createSession([assistantEntry(usage)], refWalks), footerData));
		expect(reference).toContain("1.0k");
		expect(reference).toContain("500");

		// Cached path: values identical to the reference.
		const walks = { count: 0 };
		const entries: unknown[] = [assistantEntry(usage)];
		const footer = new FooterComponent(createSession(entries, walks), footerData);
		expect(renderAll(footer)).toBe(reference);
		expect(renderAll(footer)).toBe(reference);
		expect(walks.count).toBe(1); // repeated renders must NOT re-walk entries (on-change refresh)

		// Entry growth: cache key moves → recompute → values exactly match a fresh computation.
		entries.push(assistantEntry({ input: 4000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 0 } }));
		const grownWalks = { count: 0 };
		const grownReference = renderAll(new FooterComponent(createSession(entries, grownWalks), footerData));
		expect(grownReference).toContain("5.0k");
		expect(grownReference).not.toBe(reference);
		expect(renderAll(footer)).toBe(grownReference);
		expect(walks.count).toBe(2); // entry growth must trigger exactly one recompute
	});
});
