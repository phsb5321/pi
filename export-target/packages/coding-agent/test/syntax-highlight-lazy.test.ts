import { readdirSync } from "fs";
import hljs from "highlight.js/lib/core.js";
import { createRequire } from "module";
import { dirname } from "path";
import { describe, expect, it } from "vitest";
import { highlight, loadAllHighlightLanguages, supportsLanguage } from "../src/utils/syntax-highlight.ts";

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
const catalogModule = "highlight.js/lib/index.js";

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

	// The complete map pin: every name and alias in the pinned catalog is
	// renderable on demand by loading exactly its own grammar, the full
	// catalog is never evaluated by resolution, and every name resolves to
	// the same grammar the full catalog would pick (disputed aliases too).
	it("resolves every catalog name and alias to its exact grammar, matching the full catalog", async () => {
		const languagesDir = dirname(require.resolve(grammarModule("bash")));
		const ids = readdirSync(languagesDir)
			.filter((file) => file.endsWith(".js"))
			.map((file) => file.slice(0, -3))
			.sort();
		expect(ids.length).toBeGreaterThanOrEqual(191);

		const resolved: Array<[string, string | undefined]> = [];
		for (const id of ids) {
			const factory = require(grammarModule(id)) as HighlightJsLanguageFactory;
			const definition = factory(hljs) as unknown as { aliases?: string[] };
			for (const key of [id, ...(definition.aliases ?? [])]) {
				const name = key.toLowerCase();
				expect(supportsLanguage(name)).toBe(true);
				resolved.push([name, hljs.getLanguage(name)?.name]);
			}
		}
		expect(require.cache[require.resolve(catalogModule)]).toBeUndefined();

		await loadAllHighlightLanguages();
		for (const [name, beforeName] of resolved) {
			expect(hljs.getLanguage(name)?.name).toBe(beforeName);
		}
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

	it("renders rare aliases identically to their canonical name", () => {
		expect(supportsLanguage("yml")).toBe(true);
		const canonical = highlight("key: value", { language: "yaml", ignoreIllegals: true });
		const viaAlias = highlight("key: value", { language: "yml", ignoreIllegals: true });
		expect(viaAlias).toBe(canonical);
	});
});
