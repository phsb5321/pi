import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const BIG = 8 * 1024;

function bigUser(label: string) {
	return userMsg(`${label} ${"é€x".repeat(BIG / 4)}`);
}

function bigAssistant(label: string) {
	return assistantMsg(`${label} ${"y".repeat(BIG)}`);
}

function isCold(entry: unknown): boolean {
	const message = (entry as { message?: object }).message;
	return !!message && !!Object.getOwnPropertyDescriptor(message, "content")?.get;
}

/** Session: u0 a0 u1 a1 | compaction (keeps u2) | u2 a2 u3 a3, persisted to disk. */
function buildSession(dir: string): { file: string; ids: string[]; compactionId: string } {
	const session = SessionManager.create(dir, dir);
	const ids: string[] = [];
	for (let i = 0; i < 2; i++) {
		ids.push(session.appendMessage(bigUser(`u${i}`)));
		ids.push(session.appendMessage(bigAssistant(`a${i}`)));
	}
	const u2 = session.appendMessage(bigUser("u2"));
	const compactionId = session.appendCompaction("summary", u2, 1000);
	ids.push(u2);
	ids.push(session.appendMessage(bigAssistant("a2")));
	ids.push(session.appendMessage(bigUser("u3")));
	ids.push(session.appendMessage(bigAssistant("a3")));
	return { file: session.getSessionFile()!, ids, compactionId };
}

describe("SessionManager cold message payloads", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-cold-"));
	});
	afterEach(() => {
		delete process.env.PI_SESSION_COLD_CONTENT;
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps only the active branch since the last compaction hot on resume, without changing any entry", () => {
		const { file, ids } = buildSession(dir);
		const reopened = SessionManager.open(file, dir);
		const hot = ids.slice(4);
		const cold = ids.slice(0, 4);

		for (const id of cold) expect(isCold(reopened.getEntry(id))).toBe(true);
		for (const id of hot) expect(isCold(reopened.getEntry(id))).toBe(false);

		const onDisk = loadEntriesFromFile(file).filter((e) => e.type !== "session");
		expect(JSON.stringify(reopened.getEntries())).toBe(JSON.stringify(onDisk));
		expect(reopened.getBranch()).toHaveLength(onDisk.length);
	});

	it("builds the same context and tree as with cold payloads disabled", () => {
		const { file } = buildSession(dir);
		const cold = SessionManager.open(file, dir);
		process.env.PI_SESSION_COLD_CONTENT = "0";
		const plain = SessionManager.open(file, dir);
		expect(isCold(plain.getEntries()[0])).toBe(false);
		expect(JSON.stringify(cold.buildSessionContext())).toBe(JSON.stringify(plain.buildSessionContext()));
		expect(JSON.stringify(cold.getTree())).toBe(JSON.stringify(plain.getTree()));
	});

	it("serves a cold payload to repeated reads and lets it be reassigned", () => {
		const { file, ids } = buildSession(dir);
		const reopened = SessionManager.open(file, dir);
		const entry = reopened.getEntry(ids[0]) as { message: { content: string } };
		expect(isCold(entry)).toBe(true);
		const first = entry.message.content;
		expect(first.startsWith("u0 é€x")).toBe(true);
		expect(entry.message.content).toBe(first);
		entry.message.content = "edited";
		expect(entry.message.content).toBe("edited");
		expect(isCold(entry)).toBe(false);
	});

	it("tiers entries appended in the live session when a compaction lands", () => {
		const session = SessionManager.create(dir, dir);
		const old = session.appendMessage(bigUser("old"));
		session.appendMessage(bigAssistant("old-reply"));
		const kept = session.appendMessage(bigUser("kept"));
		expect(isCold(session.getEntry(old))).toBe(false);
		session.appendCompaction("summary", kept, 1000);
		expect(isCold(session.getEntry(old))).toBe(true);
		expect(isCold(session.getEntry(kept))).toBe(false);
		const entry = session.getEntry(old) as { message: { content: string } };
		expect(entry.message.content.startsWith("old é€x")).toBe(true);
	});

	it("navigates to a cold entry and branches from it", () => {
		const { file, ids } = buildSession(dir);
		const session = SessionManager.open(file, dir);
		session.branch(ids[1]);
		expect(session.getBranch().map((e) => e.id)).toEqual([ids[0], ids[1]]);
		// Navigating onto the old path makes it hot again.
		expect(isCold(session.getEntry(ids[1]))).toBe(false);
		const fork = session.appendMessage(bigUser("fork"));
		expect(session.getBranch().map((e) => e.id)).toEqual([ids[0], ids[1], fork]);
		const reloaded = SessionManager.open(file, dir);
		expect(JSON.stringify(reloaded.getEntries())).toBe(
			JSON.stringify(loadEntriesFromFile(file).filter((e) => e.type !== "session")),
		);
		expect(reloaded.getChildren(ids[1]).map((e) => e.id)).toContain(fork);
	});

	it("keeps createBranchedSession content intact and independent of the source file", () => {
		const { file, ids } = buildSession(dir);
		const session = SessionManager.open(file, dir);
		const newFile = session.createBranchedSession(ids[1]);
		expect(newFile).toBeDefined();
		rmSync(file);
		const branched = loadEntriesFromFile(newFile!).filter((e) => e.type === "message");
		expect(branched).toHaveLength(2);
		expect(JSON.stringify(branched)).toContain("u0 é€x");
		expect(JSON.stringify(session.getBranch())).toContain("u0 é€x");
	});

	it("still reads the payload when the file shifted under the stored offset", () => {
		const { file, ids } = buildSession(dir);
		const session = SessionManager.open(file, dir);
		const lines = readFileSync(file, "utf8").split("\n");
		lines.splice(
			1,
			0,
			JSON.stringify({ type: "label", id: "zzzzzzzz", parentId: null, timestamp: "x", targetId: ids[0] }),
		);
		writeFileSync(file, lines.join("\n"));
		const entry = session.getEntry(ids[0]) as { message: { content: string } };
		expect(entry.message.content.startsWith("u0 é€x")).toBe(true);
	});

	it("does not tier small entries or in-memory sessions", () => {
		const small = SessionManager.create(dir, dir);
		const a = small.appendMessage(userMsg("tiny"));
		const kept = small.appendMessage(userMsg("kept"));
		small.appendCompaction("s", kept, 1);
		expect(isCold(small.getEntry(a))).toBe(false);

		const memory = SessionManager.inMemory();
		const m = memory.appendMessage(bigUser("mem"));
		const k = memory.appendMessage(bigUser("kept"));
		memory.appendCompaction("s", k, 1);
		expect(isCold(memory.getEntry(m))).toBe(false);
		expect(existsSync(dir)).toBe(true);
	});
});
