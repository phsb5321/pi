import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompactionEntry, SessionManager } from "../../src/core/session-manager.ts";

function assistantMessage() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ordinary reply" }],
		api: "faux",
		provider: "synthetic",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

describe("SessionManager entries survive the persistence round-trip unchanged", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Custom-hook compaction shape: the hook returned no details/usage. */
	function buildHookCompactionSession(): SessionManager {
		const manager = SessionManager.create(tempDir, join(tempDir, "history"));
		manager.appendMessage({ role: "user", content: "SYNTHETIC-RETAINED-PUBLIC", timestamp: 1 });
		manager.appendMessage(assistantMessage());
		const keptId = manager.appendMessage({ role: "user", content: "kept tail", timestamp: 3 });
		manager.appendCompaction("synthetic summary", keptId, 85, undefined, true);
		return manager;
	}

	it("reopened entries strictly equal in-memory entries when optional fields are omitted", () => {
		const manager = buildHookCompactionSession();
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		const before = manager.getEntries();
		const compaction = before.at(-1) as CompactionEntry;
		expect(compaction.type).toBe("compaction");
		expect(compaction.summary).toBe("synthetic summary");
		expect(Object.hasOwn(compaction, "details")).toBe(false);
		expect(Object.hasOwn(compaction, "usage")).toBe(false);
		const reopened = SessionManager.open(file as string, tempDir);
		expect(reopened.getEntries()).toStrictEqual(before);
		expect(reopened.getLeafId()).toBe(manager.getLeafId());
	});

	it("custom, custom-message, branch-summary and label entries also round-trip unchanged", () => {
		const manager = buildHookCompactionSession();
		manager.appendCustomEntry("my_data");
		manager.appendCustomMessageEntry("my_type", "displayed", true);
		manager.branchWithSummary(null, "abandoned path summary");
		const firstId = manager.getEntries()[0]?.id;
		expect(firstId).toBeDefined();
		manager.appendLabelChange(firstId as string, undefined);
		const file = manager.getSessionFile() as string;
		const before = manager.getEntries();
		const reopened = SessionManager.open(file, tempDir);
		expect(reopened.getEntries()).toStrictEqual(before);
		expect(reopened.getLeafId()).toBe(manager.getLeafId());
	});

	it("control: a value-level change in a persisted row is still detected", () => {
		const manager = buildHookCompactionSession();
		const file = manager.getSessionFile() as string;
		const before = manager.getEntries();
		const original = readFileSync(file, "utf8");
		const tampered = original.replace("synthetic summary", "tampered summary");
		expect(tampered).not.toBe(original);
		writeFileSync(file, tampered);
		const reopened = SessionManager.open(file, tempDir);
		expect(reopened.getEntries()).not.toStrictEqual(before);
	});
});
