import assert from "node:assert";
import { describe, it } from "node:test";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";

/**
 * Discriminating regression for the fuzzy autocomplete hot path (normal
 * input): `fuzzyFilter` used to lowercase the full item text once per token
 * per item — O(items x tokens) full-string allocations on every keystroke
 * that filters suggestions. The fix folds case once per item and once per
 * token. The cost test below fails on the old shape and passes on the new;
 * the behavior pins guard the refactor surface.
 */
describe("fuzzyFilter case folding (input hot path)", () => {
	it("folds case once per item and token, not per token per item", () => {
		const items = Array.from({ length: 8 }, (_, i) => `Item-Path-Number-${i}-With-A-Reasonably-Long-Name`);
		const original = String.prototype.toLowerCase;
		let calls = 0;
		String.prototype.toLowerCase = function lowercaseCounted(this: string): string {
			calls++;
			return original.call(this);
		};
		try {
			const result = fuzzyFilter(items, "number0 path", (item) => item);
			assert.ok(result.length >= 1);
		} finally {
			String.prototype.toLowerCase = original;
		}
		const tokens = 2;
		assert.ok(
			calls <= items.length + tokens,
			`expected <= ${items.length + tokens} toLowerCase calls (once per item + per token), got ${calls}`,
		);
	});

	it("behavior pins across the refactor surface", () => {
		// exact match ranks first; later occurrences rank after prefixes
		assert.deepStrictEqual(
			fuzzyFilter(["xfoo", "foo"], "foo", (s) => s),
			["foo", "xfoo"],
		);
		// case-insensitive on both sides, including length-changing lowercase (U+0130 -> i + U+0307)
		assert.strictEqual(fuzzyMatch("FoO", "foo").matches, true);
		assert.strictEqual(fuzzyMatch("i\u0307", "\u0130").matches, true);
		// tokens split on whitespace and slashes; all tokens must match
		assert.deepStrictEqual(
			fuzzyFilter(["foo bar", "zzz", "bar"], "foo/bar", (s) => s),
			["foo bar"],
		);
		// digit/letter swap heuristic preserved
		assert.strictEqual(fuzzyMatch("2ab", "ab2").matches, true);
		// whitespace-only query returns items unchanged (no folding work)
		assert.deepStrictEqual(
			fuzzyFilter(["a", "b"], "  ", (s) => s),
			["a", "b"],
		);
	});
});
