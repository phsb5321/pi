import { describe, expect, it } from "vitest";
import { CompressedContentStore } from "../src/storage/compressed-content-store.ts";

describe("CompressedContentStore", () => {
	it("round-trips text and blobs value-equal", () => {
		const store = new CompressedContentStore({ windowSize: 2 });
		const text = "héllo — wörld ✓\nline two";
		const blob = new Uint8Array([0, 1, 2, 250, 255]);
		store.set("t", text);
		store.set("b", blob, "blob");
		expect(store.get("t")).toBe(text);
		expect(store.get("b")).toEqual(blob);
	});

	it("settles entries outside the window into compressed backing", () => {
		const store = new CompressedContentStore({ windowSize: 2 });
		const payload = "compressible payload ".repeat(200);
		for (let i = 0; i < 5; i++) store.set(`k${i}`, `${payload}${i}`);
		const stats = store.stats();
		expect(stats.compressedEntries).toBe(3);
		expect(stats.plainText).toBe(2);
		// lossless after settling
		expect(store.get("k0")).toBe(`${payload}0`);
	});

	it("keeps blobs raw and out of the codec", () => {
		const store = new CompressedContentStore({ windowSize: 1 });
		const blob = new Uint8Array(4096).fill(7);
		for (let i = 0; i < 4; i++) store.set(`b${i}`, blob, "blob");
		const stats = store.stats();
		expect(stats.compressedEntries).toBe(0);
		expect(stats.retainedBytes).toBe(4 * 4096);
		expect(store.get("b0")).toEqual(blob);
	});

	it("promotes accessed entries back into the working window", () => {
		const store = new CompressedContentStore({ windowSize: 2 });
		for (let i = 0; i < 5; i++) store.set(`k${i}`, `value ${i} `.repeat(50));
		expect(store.stats().compressedEntries).toBe(3);
		expect(store.get("k0")).toBe(`value 0 `.repeat(50));
		// Promotion keeps the window exactly full: the accessed entry joins it and
		// the oldest plain entry settles out.
		const stats = store.stats();
		expect(stats.plainText).toBe(2);
		expect(stats.compressedEntries).toBe(3);
	});

	it("compresses real prose well above the 2x gate", () => {
		const store = new CompressedContentStore({ windowSize: 1 });
		const payload = "the quick brown fox jumps over the lazy dog. ".repeat(200);
		for (let i = 0; i < 3; i++) store.set(`k${i}`, `${payload}${i}`);
		const stats = store.stats();
		const original = Buffer.byteLength(`${payload}0`) + Buffer.byteLength(`${payload}1`) + Buffer.byteLength(`${payload}2`);
		expect(original / stats.retainedBytes).toBeGreaterThan(2);
	});

	it("escapes no backing references (object-granularity identity)", () => {
		const store = new CompressedContentStore({ windowSize: 1 });
		const blob = new Uint8Array([1, 2, 3]);
		store.set("b", blob, "blob");
		const got = store.get("b") as Uint8Array;
		got[0] = 99; // mutating the returned object must not touch the store
		expect((store.get("b") as Uint8Array)[0]).toBe(1);
		const text = "stable text ".repeat(80);
		store.set("t", text);
		store.set("t2", "pushes t out ".repeat(80));
		expect(store.get("t")).toBe(text);
	});

	it("deletes entries from the window and the backing", () => {
		const store = new CompressedContentStore({ windowSize: 1 });
		store.set("a", "aaa ".repeat(100));
		store.set("b", "bbb ".repeat(100));
		store.delete("a");
		store.delete("b");
		expect(store.get("a")).toBeUndefined();
		expect(store.stats().entries).toBe(0);
	});
});
