import hljs from "highlight.js/lib/core.js";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import { highlight, supportsLanguage } from "../src/utils/syntax-highlight.ts";

const require = createRequire(import.meta.url);

const startupLanguages = [
	"bash",
	"c",
	"cpp",
	"csharp",
	"dart",
	"go",
	"groovy",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"nix",
	"perl",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"swift",
	"typescript",
];

const grammarModule = (name: string) => `highlight.js/lib/languages/${name}.js`;

describe("lazy grammar registration", () => {
	it("does not load grammar modules before first use", () => {
		for (const name of startupLanguages) {
			expect(require.cache[require.resolve(grammarModule(name))]).toBeUndefined();
		}
		expect(supportsLanguage("python")).toBe(true);
		expect(require.cache[require.resolve(grammarModule("python"))]).toBeDefined();
		for (const name of startupLanguages.filter((name) => name !== "python")) {
			expect(require.cache[require.resolve(grammarModule(name))]).toBeUndefined();
		}
	});

	// Pins the baked name/alias map to the pinned highlight.js grammars: a
	// dependency upgrade that adds or renames an alias fails here.
	it("accepts every name and alias the startup grammars declare before the full catalog loads", () => {
		for (const name of startupLanguages) {
			const factory = require(grammarModule(name)) as HighlightJsLanguageFactory;
			const definition = factory(hljs) as unknown as { aliases?: string[] };
			expect(supportsLanguage(name)).toBe(true);
			for (const alias of definition.aliases ?? []) {
				expect(supportsLanguage(alias)).toBe(true);
			}
		}
		expect(supportsLanguage("ada")).toBe(false);
	});

	// Prototype keys must stay unsupported exactly as before lazy registration.
	it("keeps prototype keys of the loader maps unsupported", () => {
		for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype"]) {
			expect(supportsLanguage(name)).toBe(false);
		}
	});

	it("renders the same output through an alias as through the canonical name", () => {
		const canonical = highlight("const value = 1", { language: "javascript", ignoreIllegals: true });
		const viaAlias = highlight("const value = 1", { language: "js", ignoreIllegals: true });
		expect(viaAlias).toBe(canonical);
	});
});
