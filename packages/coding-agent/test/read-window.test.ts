import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

// Large local files take the chunked window path; custom operations keep the whole-file path.
// Both must produce identical content and details.
const dir = mkdtempSync(join(tmpdir(), "read-window-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const windowed = createReadTool(dir);
const whole = createReadTool(dir, { operations: { readFile: (p) => readFile(p), access: (p) => access(p) } });

const MB = 1024 * 1024;
const files: Record<string, string> = {
	short: Array.from({ length: 300_000 }, (_, i) => `line ${i} é`).join("\n"),
	shortTrailing: `${Array.from({ length: 300_000 }, (_, i) => `line ${i}`).join("\n")}\n`,
	wide: Array.from({ length: 2_000 }, (_, i) => `${i}:${"x".repeat(700)}`).join("\n"),
	hugeFirstLine: `${"y".repeat(2 * MB)}\nsecond\nthird`,
	multibyteCut: `${"ü".repeat(30_000)}${"€".repeat(20_000)}\n${"a\n".repeat(600_000)}`,
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);

const cases: Array<[string, number | undefined, number | undefined]> = [];
for (const name of Object.keys(files)) {
	for (const [offset, limit] of [
		[undefined, undefined],
		[1, 10],
		[2, undefined],
		[1999, 5],
		[299_999, undefined],
		[300_000, undefined],
		[300_001, undefined],
		[150_000, 3_000],
		[3, 1],
	] as const) {
		cases.push([name, offset, limit]);
	}
}

async function run(tool: typeof windowed, path: string, offset?: number, limit?: number) {
	try {
		const result = await tool.execute("t", { path, offset, limit });
		return { content: result.content, details: result.details };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

describe("read tool window path", () => {
	it.each(cases)("%s offset=%s limit=%s matches the whole-file path", async (name, offset, limit) => {
		const path = join(dir, name);
		expect(await run(windowed, path, offset, limit)).toEqual(await run(whole, path, offset, limit));
	});
});
