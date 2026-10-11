import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatTokens } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * Behavior pins for the status-line counters and the sparkline readout
 * semantics: exact counter formatting, exact footer counter rendering, and
 * byte-identical passthrough of sparkline readouts (▁▂▃▄▅▆▇█) carried in
 * extension status text (the fleet footer's meter cell uses this path).
 */

const SPARK_READOUT = "🧠 ▁▂▃▄▅▆▇█ 42% · 435k/1.0M head 613k ~496t";

function createSession(): AgentSession {
	const usage = { input: 1200, output: 800, cacheRead: 3000, cacheWrite: 100, cost: { total: 0.5 } };
	const entries = [{ type: "message", message: { role: "assistant", usage } }];
	const session = {
		state: {
			model: {
				id: "test-model",
				provider: "test",
				contextWindow: 200_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => "session",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	};
	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["fleet-meter", SPARK_READOUT]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	} as unknown as ReadonlyFooterDataProvider;
}

beforeAll(() => {
	initTheme(undefined, false);
});

describe("status-line counters", () => {
	it("formats token counters exactly", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(3000)).toBe("3.0k");
		expect(formatTokens(43_500)).toBe("44k");
		expect(formatTokens(435_000)).toBe("435k");
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(12_000_000)).toBe("12M");
	});

	it("renders footer counters exactly and passes sparkline readouts through byte-identically", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		const lines = footer.render(120).map(stripAnsi);
		expect(lines[0]!.trimEnd()).toBe("/tmp/project (main) • session");
		expect(lines[1]).toContain("↑1.2k ↓800 R3.0k W100 CH69.8% $0.500 12.3%/200k (auto)");
		expect(lines[1]!.trimEnd().endsWith("test-model")).toBe(true);
		expect(lines[2]!.trimEnd()).toBe(SPARK_READOUT);
	});
});
