import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { InMemoryStorageState } from "../../src/harness/session/in-memory-storage-state.ts";
import { JsonlStorage } from "../../src/harness/session/jsonl/index.ts";
import type { Write } from "../../src/harness/session/types.ts";
import { createTempDir, standardTestHeader } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

function messageEntry(parentId: string | null, index: number) {
	return sessionWrites.insertEntry({
		id: `entry-${index}`,
		parentId,
		type: "message",
		message: { role: "user", timestamp: NOW, content: [{ type: "text", text: `message ${index}` }] },
	});
}

async function createStorageWith(writes: Write[], retentionWindowEntries?: number) {
	const suffix = retentionWindowEntries === undefined ? "plain" : "windowed";
	return JsonlStorage.create(
		{
			fileSystem: new NodeExecutionEnv({ cwd: createTempDir() }),
			path: `${suffix}.jsonl`,
			now: () => NOW,
			retentionWindowEntries,
		},
		standardTestHeader(suffix, NOW),
		writes,
		BACKGROUND_CONTEXT,
	);
}

describe("MS-21 s1 retention window", () => {
	it("evicts full entries beyond the window but keeps skeletons", async () => {
		const state = new InMemoryStorageState({
			entryWindow: 2,
			hydration: { loadEntries: async () => [] },
		});
		let parentId: string | null = null;
		for (let index = 0; index < 5; index++) {
			const prepared = state.prepareCommit([messageEntry(parentId, index)], NOW + index);
			state.applyValidated(prepared.writes);
			const entry = state.getEntries([`entry-${index}`]).get(`entry-${index}`);
			expect(entry).toBeDefined();
			parentId = `entry-${index}`;
		}
		// All five ids exist; only the last two hold payloads.
		expect(state.getSkeletons()).toHaveLength(5);
		expect(state.unmaterializedIds(["entry-0", "entry-1", "entry-2", "entry-3", "entry-4"])).toEqual([
			"entry-0",
			"entry-1",
			"entry-2",
		]);
		// Existence checks (validation, fork planning) still see everything.
		expect(state.hasEntry("entry-0")).toBe(true);
	});

	it("hydrates from the JSONL so every read matches an unwindowed storage", async () => {
		const writes: Write[] = [];
		let parentId: string | null = null;
		for (let index = 0; index < 12; index++) {
			const entry = messageEntry(parentId, index);
			writes.push(entry);
			parentId = `entry-${index}`;
		}

		const plain = await createStorageWith(writes);
		const windowed = await createStorageWith(writes, 4);

		// scanEntries over the whole history hydrates and matches.
		const allPlain = await plain.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		const allWindowed = await windowed.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(allWindowed).toEqual(allPlain);
		expect(allWindowed).toHaveLength(12);

		// Point lookups of window-evicted ids hydrate.
		const oldPlain = await plain.getEntries(["entry-0", "entry-5"], BACKGROUND_CONTEXT);
		const oldWindowed = await windowed.getEntries(["entry-0", "entry-5"], BACKGROUND_CONTEXT);
		expect([...oldWindowed.entries()]).toEqual([...oldPlain.entries()]);

		// Branch walks to the root hydrate the full path.
		const branchPlain = await plain.scanBranch({ start: "entry-11", order: "oldestFirst" }, BACKGROUND_CONTEXT);
		const branchWindowed = await windowed.scanBranch({ start: "entry-11", order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(branchWindowed).toEqual(branchPlain);
		expect(branchWindowed).toHaveLength(12);

		// Structure scans never hydrate and still match.
		const structurePlain = await plain.scanBranchStructure({ start: "entry-11" }, BACKGROUND_CONTEXT);
		const structureWindowed = await windowed.scanBranchStructure({ start: "entry-11" }, BACKGROUND_CONTEXT);
		expect(structureWindowed).toEqual(structurePlain);

		// New commits after hydration keep sequence and stats correct.
		const nextPlain = await plain.commit([messageEntry("entry-11", 12)], BACKGROUND_CONTEXT);
		const nextWindowed = await windowed.commit([messageEntry("entry-11", 12)], BACKGROUND_CONTEXT);
		expect(nextWindowed.stats).toEqual(nextPlain.stats);
		expect(nextWindowed.seqs).toEqual(nextPlain.seqs);

		await plain.close(BACKGROUND_CONTEXT);
		await windowed.close(BACKGROUND_CONTEXT);
	});
});
