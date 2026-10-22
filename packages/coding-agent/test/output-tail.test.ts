import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BoundedOutputTail } from "../src/core/tools/output-tail.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../src/core/tools/truncate.ts";

const CAPS = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
const HIGH = "\uD83C";
const LOW = "\uDF89";
const EMOJI = HIGH + LOW; // U+1F789

/** Every-append reference oracle: compare against truncateTail(full) and Buffer.byteLength(full). */
function checkStep(tail: BoundedOutputTail, full: string, caps: { maxLines: number; maxBytes: number }): void {
	const reference = truncateTail(full, caps);
	expect(tail.tailText).toBe(reference.content);
	expect(tail.truncated).toBe(reference.truncated);
	expect(full.endsWith(tail.output)).toBe(true);
	expect(tail.droppedBytes).toBe(Buffer.byteLength(full, "utf-8") - Buffer.byteLength(tail.output, "utf-8"));
}

function runChunks(
	chunks: string[],
	caps: { maxLines: number; maxBytes: number },
): { tail: BoundedOutputTail; full: string } {
	const tail = new BoundedOutputTail(caps);
	let full = "";
	for (const chunk of chunks) {
		tail.append(chunk);
		full += chunk;
		checkStep(tail, full, caps);
	}
	return { tail, full };
}

describe("BoundedOutputTail (W3 bounded tail retention)", () => {
	it("does not retain a large source allocation behind its short raw suffix", () => {
		const moduleUrl = new URL("../src/core/tools/output-tail.ts", import.meta.url).href;
		const child = spawnSync(
			process.execPath,
			["--expose-gc", "--experimental-strip-types", "--input-type=module", "--max-old-space-size=128"],
			{
				input: `import { randomBytes } from "node:crypto";
import { BoundedOutputTail } from ${JSON.stringify(moduleUrl)};
global.gc(); global.gc();
const before = process.memoryUsage();
const tail = new BoundedOutputTail();
tail.append(randomBytes(16 * 1024 * 1024).toString("hex"));
await new Promise(setImmediate);
global.gc(); global.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({ units: tail.output.length, retained: after.heapUsed + after.external - before.heapUsed - before.external }));`,
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 1024 * 1024,
			},
		);
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout) as { units: number; retained: number };
		expect(result.units).toBe(DEFAULT_MAX_BYTES + 4);
		expect(result.retained).toBeLessThan(8 * 1024 * 1024);
	});

	it("rejects limits that could disable or invalidate the memory bound", () => {
		for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
			expect(() => new BoundedOutputTail({ maxBytes: value })).toThrow(RangeError);
			expect(() => new BoundedOutputTail({ maxLines: value })).toThrow(RangeError);
		}
	});

	it("matches the full oracle across seeded Unicode chunk boundaries", () => {
		let seed = 123;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed >>> 16;
		};
		const parts = ["a", "\n", "é", "漢", EMOJI, HIGH, LOW, "x\nx\n"];
		for (let sample = 0; sample < 500; sample++) {
			const caps = { maxBytes: 1 + (random() % 80), maxLines: 1 + (random() % 8) };
			const chunks = Array.from({ length: 30 }, () => parts[random() % parts.length].repeat(1 + (random() % 12)));
			const { tail } = runChunks(chunks, caps);
			expect(tail.output.length).toBeLessThanOrEqual(caps.maxBytes + 4);
		}
	});

	it("root case 1: line order + separator + pair across chunks (a NL b NL c NL + HIGH, then LOW)", () => {
		const caps = { maxBytes: 5, maxLines: 2 };
		const { tail, full } = runChunks([`a\nb\nc\n${HIGH}`, LOW], caps);
		expect(tail.output).toBe(full);
		expect(tail.output).toContain(EMOJI);
		expect(tail.tailText).toBe(truncateTail(full, caps).content);
	});

	it("root case 2: global truncation sticks even when the retained suffix now fits", () => {
		const caps = { maxBytes: 5, maxLines: 2 };
		const { tail } = runChunks(["123456", "\nx", "\n"], caps);
		expect(tail.tailText).toBe("x");
		expect(tail.truncated).toBe(true);
	});

	it("root case 3: partial first line cannot be falsely retained (UTF-8 cut spare bytes)", () => {
		const caps = { maxBytes: 6, maxLines: 3 };
		const { tail } = runChunks([EMOJI + EMOJI + EMOJI, "\nx"], caps);
		expect(tail.tailText).toBe("x");
	});

	it("root repro: eight x + lone high surrogate, then low — pair preserved in raw, reference exact", () => {
		const caps = { maxBytes: 5, maxLines: 2 };
		const { tail, full } = runChunks([`xxxxxxxx${HIGH}`, LOW], caps);
		expect(tail.output).toContain(EMOJI);
		expect(tail.output).not.toContain("\uFFFD");
		expect(tail.tailText).toBe(truncateTail(full, caps).content);
		expect(tail.tailText).toBe(`x${EMOJI}`);
	});

	it("default caps: 50KiB long line with the pair split across appends", () => {
		const prefix = "x".repeat(DEFAULT_MAX_BYTES - 3);
		const { tail, full } = runChunks([prefix + HIGH, LOW + "y".repeat(63) + "\n", "tail\n"], CAPS);
		expect(full.endsWith(tail.output)).toBe(true);
		expect(tail.output).toContain(EMOJI);
		expect(tail.output).not.toContain("\uFFFD");
	});

	it("adversarial streaming, small caps: every append matches the full reference", () => {
		const caps = { maxBytes: 64, maxLines: 4 };
		const parts: string[] = [];
		for (let i = 0; i < 200; i++) {
			if (i > 0 && i % 37 === 0) parts.push(`HUGE-${i}-${"x".repeat(300)}\n`);
			else if (i % 23 === 0) parts.push("\n");
			else if (i % 11 === 0) parts.push(`多字节-${i}-${EMOJI} émoji ✨\n`);
			else parts.push(`line-${i} lorem ipsum dolor sit\n`);
		}
		parts.push("final partial 末尾");
		const full = parts.join("");
		const sizes = [1, 2, 7, 1300, 3, 4096, 31, 0, 17, 5];
		const chunks: string[] = [];
		for (let offset = 0, s = 0; offset < full.length; s++) {
			const size = sizes[s % sizes.length];
			chunks.push(full.slice(offset, offset + size));
			offset += size;
		}
		const { tail, full: got } = runChunks(chunks, caps);
		expect(got).toBe(full);
		expect(tail.truncated).toBe(true);
		expect(tail.droppedBytes).toBeGreaterThan(0);
	});

	it("adversarial streaming, default caps: every append matches the full reference", () => {
		const parts: string[] = [];
		for (let i = 0; i < 20; i++) {
			parts.push(`${"x".repeat(30_000)}${i % 3 === 0 ? EMOJI : ""}-tail-${i}\n`);
		}
		parts.push(`${HIGH}${LOW}end`);
		const full = parts.join("");
		const chunks: string[] = [];
		for (let offset = 0; offset < full.length; offset += 16_384) chunks.push(full.slice(offset, offset + 16_384));
		const { tail } = runChunks(chunks, CAPS);
		expect(tail.output).toContain(EMOJI);
		expect(tail.output.endsWith(`${EMOJI}end`)).toBe(true);
	});

	it("small streams are retained verbatim; split pairs and empty chunks are exact", () => {
		const small = new BoundedOutputTail();
		small.append("a\nb\n");
		expect(small.tailText).toBe("a\nb\n");
		expect(small.output).toBe("a\nb\n");
		expect(small.truncated).toBe(false);
		const split = new BoundedOutputTail();
		for (const c of ["多字节" + HIGH, "", LOW + " tail\n", "next"]) split.append(c);
		expect(split.output).toBe(`多字节${EMOJI} tail\nnext`);
		expect(split.tailText).toBe(split.output);
		expect(split.output).not.toContain("\uFFFD");
	});
});
