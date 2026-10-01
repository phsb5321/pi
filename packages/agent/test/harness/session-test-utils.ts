import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { JSONL_FORMAT_VERSION, type JsonlStorageHeader } from "../../src/harness/session/jsonl/index.ts";

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

/** Standard JsonlStorage header fixture for retention/conformance tests. */
export function standardTestHeader(id: string, createdAt: number = 1_700_000_000_000): JsonlStorageHeader {
	return { v: JSONL_FORMAT_VERSION, kind: "header", id, storageVersion: 1, createdAt, cwd: "/workspace" };
}
