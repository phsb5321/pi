import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../src/storage/sqlite/node.ts";

// Stands in for a disk stall: the first WAL switch on a fresh file blocks the calling thread for this long.
const STALL_MS = 250;
// Largest tolerated gap between event-loop ticks while a database opens.
const MAX_TICK_GAP_MS = 100;

const directories = new Set<string>();

afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

function blockThread(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end);
}

describe("sqlite open keeps the event loop responsive", () => {
	it("does not freeze timers while a fresh database switches to WAL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-responsive-"));
		directories.add(directory);

		const original = DatabaseSync.prototype.exec;
		vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
			if (sql.startsWith("PRAGMA journal_mode")) blockThread(STALL_MS);
			return original.call(this, sql);
		});

		const ticks: number[] = [];
		const ticker = setInterval(() => ticks.push(performance.now()), 5);
		const started = performance.now();
		try {
			const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
			await database.close();
		} finally {
			clearInterval(ticker);
		}
		// The open's end closes the last gap, so a stall that swallows every tick still reports its length.
		const samples = [started, ...ticks, performance.now()];
		const worstGap = Math.max(...samples.slice(1).map((tick, i) => tick - samples[i]!));

		// The open blocks for STALL_MS on the calling thread; a responsive open never lets a 5 ms ticker go silent that long.
		expect(worstGap).toBeLessThan(MAX_TICK_GAP_MS);
	});
});
