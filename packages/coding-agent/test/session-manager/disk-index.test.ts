import { appendFileSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { sessionDiskIndexPath } from "../../src/core/session-disk-index.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

function assistant(content: unknown[], timestamp: number) {
	return {
		role: "assistant" as const,
		content,
		api: "faux",
		provider: "synthetic",
		model: "faux-1",
		usage,
		stopReason: "stop" as const,
		timestamp,
	} as never;
}

/** Internal state the memory claim rests on. */
function internals(manager: SessionManager) {
	return manager as unknown as {
		fileEntries: unknown[];
		disk: { refresh(): { strategy: string }; deferredSyncError: unknown } | undefined;
	};
}

describe("SessionManager disk index (PI_SESSION_DISK_INDEX=1)", () => {
	let dir: string;
	let file: string;
	let ids: Record<string, string>;

	beforeEach(() => {
		dir = join(tmpdir(), `session-disk-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		vi.stubEnv("PI_SESSION_DISK_INDEX_DIR", join(dir, "index"));
		// An assistant message exists, so the file is flushed. The last entry is a PENDING tool call (no result yet).
		const m = SessionManager.create(dir, join(dir, "history"));
		ids = {};
		ids.u1 = m.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
		ids.a1 = m.appendMessage(assistant([{ type: "text", text: "ok" }], 2));
		ids.label = m.appendLabelChange(ids.u1, "start");
		ids.name = m.appendSessionInfo("  my session  ");
		ids.u2 = m.appendMessage({ role: "user", content: "kept", timestamp: 3 });
		ids.model = m.appendModelChange("synthetic", "faux-2");
		ids.cut = m.appendCompaction("summary", ids.u2, 99, undefined, false);
		ids.u3 = m.appendMessage({ role: "user", content: "run it", timestamp: 4 });
		ids.pending = m.appendMessage(
			assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 9" } }], 5),
		);
		file = m.getSessionFile() as string;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	function eager(path = file): SessionManager {
		vi.stubEnv("PI_SESSION_DISK_INDEX", "0");
		return SessionManager.open(path, dir);
	}

	function lazy(path = file): SessionManager {
		vi.stubEnv("PI_SESSION_DISK_INDEX", "1");
		const manager = SessionManager.open(path, dir);
		expect(internals(manager).disk).toBeDefined();
		return manager;
	}

	function lines(path = file): string[] {
		return readFileSync(path, "utf8").split("\n").filter(Boolean);
	}

	it("is off by default", () => {
		const manager = eager();
		expect(internals(manager).disk).toBeUndefined();
		expect(internals(manager).fileEntries.length).toBeGreaterThan(5);
	});

	it("serves exactly what the eager loader serves, holding only the header", () => {
		const e = eager();
		const l = lazy();
		expect(internals(l).fileEntries).toHaveLength(1);
		expect(l.getSessionId()).toBe(e.getSessionId());
		expect(l.getHeader()).toStrictEqual(e.getHeader());
		expect(l.getEntries()).toStrictEqual(e.getEntries());
		expect(l.getLeafId()).toBe(e.getLeafId());
		expect(l.getLeafEntry()).toStrictEqual(e.getLeafEntry());
		for (const entry of e.getEntries()) {
			expect(l.getEntry(entry.id)).toStrictEqual(entry);
			expect(l.getBranch(entry.id)).toStrictEqual(e.getBranch(entry.id));
			expect(l.getChildren(entry.id)).toStrictEqual(e.getChildren(entry.id));
			expect(l.getLabel(entry.id)).toBe(e.getLabel(entry.id));
		}
		expect(l.getEntry("nope")).toBeUndefined();
		expect(l.getSessionName()).toBe("my session");
		expect(l.buildSessionContext()).toStrictEqual(e.buildSessionContext());
		expect(l.buildContextEntries()).toStrictEqual(e.buildContextEntries());
		expect(l.getTree()).toStrictEqual(e.getTree());
		const visited: SessionEntry[] = [];
		l.forEachEntry((entry) => visited.push(entry));
		expect(visited).toStrictEqual(e.getEntries());
	});

	it("answers path queries from row metadata with the eager results", () => {
		const e = eager();
		const l = lazy();
		for (const id of [undefined, ids.pending, ids.cut, ids.u2, ids.a1, ids.u1]) {
			expect(l.getBranchFromLatestCompaction(id)).toStrictEqual(e.getBranchFromLatestCompaction(id));
		}
		expect(l.getBranchFromLatestCompaction()[0]?.id).toBe(ids.cut);
		expect(l.getBranch("missing")).toStrictEqual([]);
	});

	it("matches the eager context for branches, thinking level, a missing kept entry and an empty leaf", () => {
		const m = SessionManager.open(file, dir);
		const thinking = m.appendThinkingLevelChange("high");
		m.appendMessage({ role: "user", content: "after", timestamp: 8 });
		m.branch(ids.a1);
		m.appendModelChange("synthetic", "faux-3");
		const alt = m.appendMessage({ role: "user", content: "other branch", timestamp: 9 });
		const raw = lines();
		// a compaction whose firstKeptEntryId is not on the path
		const orphan = {
			type: "compaction",
			id: "cccccccc",
			parentId: alt,
			timestamp: "2026-01-01T00:00:00Z",
			summary: "s",
			firstKeptEntryId: "nope",
			tokensBefore: 1,
		};
		writeFileSync(file, `${raw.join("\n")}\n${JSON.stringify(orphan)}\n`);
		const e = eager();
		const l = lazy();
		for (const leaf of [undefined, thinking, ids.pending, alt, "cccccccc", ids.u1]) {
			if (leaf) {
				e.branch(leaf);
				l.branch(leaf);
			}
			expect(l.buildSessionContext()).toStrictEqual(e.buildSessionContext());
			expect(l.buildContextEntries()).toStrictEqual(e.buildContextEntries());
		}
		e.resetLeaf();
		l.resetLeaf();
		expect(l.buildSessionContext()).toStrictEqual(e.buildSessionContext());
	});

	it("keeps the pending tool call as the leaf, unchanged on read-back", () => {
		const l = lazy();
		const leaf = l.getLeafEntry();
		expect(leaf?.id).toBe(ids.pending);
		expect(leaf?.type === "message" && leaf.message.role === "assistant" && leaf.message.content).toStrictEqual([
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 9" } },
		]);
		const context = l.buildSessionContext();
		expect(context.messages.at(-1)).toStrictEqual(eager().buildSessionContext().messages.at(-1));
		// The tool result arrives later, as a child of the pending call; it must attach to the same chain.
		const resultId = l.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 6,
		} as never);
		expect(l.getEntry(resultId)?.parentId).toBe(ids.pending);
		expect(l.getBranch().map((entry) => entry.id)).toStrictEqual(
			eager()
				.getBranch()
				.map((entry) => entry.id),
		);
	});

	it("appends exactly the lines the eager writer would, without rescanning the history", () => {
		const l = lazy();
		const before = lines().length;
		const id1 = l.appendMessage({ role: "user", content: "second prompt", timestamp: 7 });
		const id2 = l.appendCustomEntry("note", { n: 1 });
		const written = lines();
		expect(written).toHaveLength(before + 2);
		expect(JSON.parse(written[before])).toStrictEqual(l.getEntry(id1));
		expect(JSON.parse(written[before + 1])).toStrictEqual(l.getEntry(id2));
		expect(written[before]).toBe(JSON.stringify(l.getEntry(id1)));
		// Own appends are recorded at their known offset: a refresh finds nothing to scan.
		expect(internals(l).disk?.refresh().strategy).toBe("unchanged");
		// A fresh eager load and a fresh lazy load agree with the live manager.
		expect(eager().getEntries()).toStrictEqual(l.getEntries());
		expect(lazy().getEntries()).toStrictEqual(l.getEntries());
		expect(lazy().getLeafId()).toBe(id2);
	});

	it("picks up an append made by another writer", () => {
		const l = lazy();
		const foreign = {
			type: "custom",
			id: "ffffffff",
			parentId: ids.pending,
			timestamp: "2026-01-01T00:00:00Z",
			customType: "x",
		};
		appendFileSync(file, `${JSON.stringify(foreign)}\n`);
		expect(l.getEntry("ffffffff")).toStrictEqual(foreign);
		expect(internals(l).disk?.refresh().strategy).toBe("unchanged");
		// and a later own append still lands on its own line
		const id = l.appendCustomEntry("mine");
		expect(eager().getEntry(id)).toStrictEqual(l.getEntry(id));
		expect(eager().getEntry("ffffffff")).toStrictEqual(foreign);
	});

	it("does not return stale entries after the transcript is truncated", () => {
		const l = lazy();
		const all = lines();
		const keep = all.slice(0, 4).join("\n");
		// cut in the middle of the 5th record
		writeFileSync(file, `${keep}\n${all[4].slice(0, 20)}`);
		expect(l.getEntry(ids.pending)).toBeUndefined();
		expect(l.getEntry(ids.u3)).toBeUndefined();
		expect(l.getEntry(ids.u1)).toStrictEqual(eager().getEntry(ids.u1));
		expect(l.getEntries().map((e) => e.id)).toStrictEqual(
			eager()
				.getEntries()
				.map((e) => e.id),
		);
	});

	it("keeps an appended entry when another process holds the index database, and re-syncs on the next read", () => {
		const l = lazy();
		const other = new DatabaseSync(sessionDiskIndexPath(file, getAgentDir()));
		other.exec("BEGIN IMMEDIATE"); // a second Pi process in the middle of its own index write
		let id: string;
		try {
			id = l.appendCustomEntry("while-locked", { n: 1 }); // waits for the busy timeout, then defers the index write
		} finally {
			other.exec("ROLLBACK");
			other.close();
		}
		expect(lines().at(-1)).toBe(JSON.stringify(l.getEntry(id)));
		expect(l.getLeafId()).toBe(id);
		expect(internals(l).disk?.deferredSyncError).toBeDefined();
		// next read finds the line by scanning only the new bytes
		expect(lazy().getEntry(id)).toStrictEqual(l.getEntry(id));
		expect(l.getEntries().at(-1)?.id).toBe(id);
		expect(eager().getEntries()).toStrictEqual(l.getEntries());
		const next = l.appendCustomEntry("after");
		expect(internals(l).disk?.deferredSyncError).toBeUndefined();
		expect(lazy().getLeafId()).toBe(next);
	});

	it("opens a transcript whose last line is unterminated and repairs it like the eager loader", () => {
		const all = lines();
		const torn = join(dir, "torn.jsonl");
		writeFileSync(torn, `${all.join("\n")}\n{"type":"custom","id":"zzzzzzzz","parentId":null,"time`);
		const e = eager(torn);
		const eagerBytes = readFileSync(torn, "utf8");
		writeFileSync(torn, `${all.join("\n")}\n{"type":"custom","id":"zzzzzzzz","parentId":null,"time`);
		const l = lazy(torn);
		expect(readFileSync(torn, "utf8")).toBe(eagerBytes);
		expect(l.getEntries()).toStrictEqual(e.getEntries());
		expect(l.getLeafId()).toBe(e.getLeafId());
	});

	it("rebuilds when an early record is rewritten in place with the same size", () => {
		const l = lazy();
		const original = readFileSync(file, "utf8");
		expect(original).toContain("first prompt");
		writeFileSync(file, original.replace("first prompt", "FIRST PROMPT"));
		const entry = l.getEntry(ids.u1);
		expect(entry?.type === "message" && entry.message.role === "user" && entry.message.content).toBe("FIRST PROMPT");
		expect(internals(l).disk?.refresh().strategy).toBe("unchanged");
		expect(l.getEntries()).toStrictEqual(eager().getEntries());
	});

	it("does not mistake a rewrite that also grows the file for an append", () => {
		const l = lazy();
		const original = readFileSync(file, "utf8");
		const grown = {
			type: "custom",
			id: "eeeeeeee",
			parentId: ids.pending,
			timestamp: "2026-01-01T00:00:00Z",
			customType: "x",
		};
		writeFileSync(
			file,
			`${original.replace("first prompt", "a much longer first prompt")}${JSON.stringify(grown)}\n`,
		);
		const entry = l.getEntry(ids.u1);
		expect(entry?.type === "message" && entry.message.role === "user" && entry.message.content).toBe(
			"a much longer first prompt",
		);
		expect(l.getEntry("eeeeeeee")).toStrictEqual(grown);
		expect(l.getEntry(ids.u2)).toStrictEqual(eager().getEntry(ids.u2)); // later records moved to new offsets
		expect(l.getEntries()).toStrictEqual(eager().getEntries());
	});

	it("rebuilds when the file is replaced by a shorter rewrite", () => {
		const l = lazy();
		const all = lines();
		writeFileSync(file, `${[all[0], all[1]].join("\n")}\n`);
		expect(l.getEntry(ids.cut)).toBeUndefined();
		expect(l.getEntries().map((e) => e.id)).toStrictEqual([ids.u1]);
		l.buildSessionContext(); // must not throw on a leaf that vanished: falls back to the last entry
	});

	it("falls back to the eager loader when the index cannot be trusted", () => {
		// duplicate ids
		const dup = join(dir, "dup.jsonl");
		const all = lines();
		writeFileSync(dup, `${[...all, all[1]].join("\n")}\n`);
		vi.stubEnv("PI_SESSION_DISK_INDEX", "1");
		expect(internals(SessionManager.open(dup, dir)).disk).toBeUndefined();
		// an old session version needs migration, which only the eager loader does
		const old = join(dir, "old.jsonl");
		writeFileSync(old, `${[all[0].replace('"version":3', '"version":2'), ...all.slice(1)].join("\n")}\n`);
		expect(internals(SessionManager.open(old, dir)).disk).toBeUndefined();
		// a corrupt index file
		const indexFile = sessionDiskIndexPath(file, getAgentDir());
		writeFileSync(indexFile, "this is not a sqlite database");
		const m = SessionManager.open(file, dir);
		expect(internals(m).disk).toBeUndefined();
		expect(m.getEntries()).toStrictEqual(eager().getEntries());
	});

	it("leaves the transcript untouched when only reading", () => {
		const before = readFileSync(file);
		const l = lazy();
		l.getEntries();
		l.buildSessionContext();
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("folds usage incrementally and matches an eager full pass", () => {
		const fold = () => ({ n: 0, ids: "" });
		const step = (acc: { n: number; ids: string }, entry: SessionEntry) => {
			acc.n++;
			acc.ids += entry.id[0];
		};
		const copy = join(dir, "copy.jsonl");
		writeFileSync(copy, readFileSync(file));
		const l = lazy();
		const e = eager(copy);
		expect(l.reduceEntries("k", fold, step).n).toBe(e.reduceEntries("k", fold, step).n);
		l.appendMessage({ role: "user", content: "more", timestamp: 9 });
		e.appendMessage({ role: "user", content: "more", timestamp: 9 });
		expect(l.reduceEntries("k", fold, step).n).toBe(e.reduceEntries("k", fold, step).n);
		expect(l.reduceEntries("k", fold, step).n).toBe(l.getEntries().length);
	});

	it("moves to an eager, smaller session on branch and new session", () => {
		const e = eager();
		const l = lazy();
		const eagerPath = e.createBranchedSession(ids.u2);
		const lazyPath = l.createBranchedSession(ids.u2);
		expect(internals(l).disk).toBeUndefined();
		expect(eagerPath).toBeDefined();
		expect(lazyPath).toBeDefined();
		// Re-created label entries get fresh random ids; everything else must match exactly.
		const shape = (m: SessionManager) =>
			m.getEntries().map((entry) => (entry.type === "label" ? { ...entry, id: "-", parentId: "-" } : entry));
		expect(shape(l)).toStrictEqual(shape(e));
		const fresh = lazy();
		fresh.newSession();
		expect(internals(fresh).disk).toBeUndefined();
		expect(fresh.getEntries()).toStrictEqual([]);
	});

	it("keeps the resident cache bounded on a large transcript", () => {
		const big = join(dir, "big.jsonl");
		const header = JSON.parse(lines()[0]);
		const rows = [JSON.stringify(header)];
		let parent: string | null = null;
		for (let i = 0; i < 3000; i++) {
			const id = `m${i.toString(16).padStart(6, "0")}`;
			rows.push(
				JSON.stringify({
					type: "message",
					id,
					parentId: parent,
					timestamp: "2026-01-01T00:00:00Z",
					message: { role: "user", content: `x${i}`.repeat(50), timestamp: i },
				}),
			);
			parent = id;
		}
		writeFileSync(big, `${rows.join("\n")}\n`);
		const l = lazy(big);
		expect(l.getBranch()).toHaveLength(3000);
		expect(internals(l).fileEntries).toHaveLength(1);
		const cache = (internals(l).disk as unknown as { cache: Map<string, unknown> }).cache;
		expect(cache.size).toBeLessThanOrEqual(256);
		expect(l.getEntries()).toStrictEqual(eager(big).getEntries());
		truncateSync(big, 0);
	});
});
