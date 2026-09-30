import hljs from "highlight.js/lib/core.js";
import { createRequire } from "module";
import { decodeHtmlEntityAt } from "./html.ts";

const require = createRequire(import.meta.url);

// The most common languages stay available without loading the full catalog,
// but each grammar module loads only when its language is first used.
const languageLoaders: Record<string, () => HighlightJsLanguageFactory> = {
	bash: () => require("highlight.js/lib/languages/bash.js"),
	c: () => require("highlight.js/lib/languages/c.js"),
	cpp: () => require("highlight.js/lib/languages/cpp.js"),
	csharp: () => require("highlight.js/lib/languages/csharp.js"),
	dart: () => require("highlight.js/lib/languages/dart.js"),
	go: () => require("highlight.js/lib/languages/go.js"),
	groovy: () => require("highlight.js/lib/languages/groovy.js"),
	java: () => require("highlight.js/lib/languages/java.js"),
	javascript: () => require("highlight.js/lib/languages/javascript.js"),
	json: () => require("highlight.js/lib/languages/json.js"),
	kotlin: () => require("highlight.js/lib/languages/kotlin.js"),
	lua: () => require("highlight.js/lib/languages/lua.js"),
	nix: () => require("highlight.js/lib/languages/nix.js"),
	perl: () => require("highlight.js/lib/languages/perl.js"),
	php: () => require("highlight.js/lib/languages/php.js"),
	python: () => require("highlight.js/lib/languages/python.js"),
	ruby: () => require("highlight.js/lib/languages/ruby.js"),
	rust: () => require("highlight.js/lib/languages/rust.js"),
	scala: () => require("highlight.js/lib/languages/scala.js"),
	swift: () => require("highlight.js/lib/languages/swift.js"),
	typescript: () => require("highlight.js/lib/languages/typescript.js"),
};

// Aliases declared by the pinned highlight.js@10.7.3 grammar definitions, so
// lazy registration accepts exactly the names the registered set always has.
const languageAliases: Record<string, string> = {
	sh: "bash",
	zsh: "bash",
	h: "c",
	cc: "cpp",
	"c++": "cpp",
	"h++": "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	cxx: "cpp",
	cs: "csharp",
	"c#": "csharp",
	golang: "go",
	jsp: "java",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	kt: "kotlin",
	kts: "kotlin",
	nixos: "nix",
	pl: "perl",
	pm: "perl",
	php3: "php",
	php4: "php",
	php5: "php",
	php6: "php",
	php7: "php",
	php8: "php",
	py: "python",
	gyp: "python",
	ipython: "python",
	rb: "ruby",
	gemspec: "ruby",
	podspec: "ruby",
	thor: "ruby",
	irb: "ruby",
	rs: "rust",
	ts: "typescript",
	tsx: "typescript",
};

function requireOrNull(specifier: string): HighlightJsLanguageFactory | null {
	try {
		return require(specifier) as HighlightJsLanguageFactory;
	} catch {
		return null;
	}
}

let catalogLoaded = false;

// Registers the grammar for `name` on first use and reports whether the name
// is renderable. Every highlight consumer goes through here, so a render
// never falls back to plain output while a grammar is merely not loaded yet.
function ensureLanguageRegistered(name: string): boolean {
	if (hljs.getLanguage(name) !== undefined) {
		return true;
	}
	const key = name.toLowerCase();
	// hasOwn gate: plain-object lookups resolve prototype keys ("constructor",
	// "toString", …) to functions, and those names must stay unsupported.
	const canonical = languageAliases[key] ?? key;
	if (Object.hasOwn(languageLoaders, canonical)) {
		hljs.registerLanguage(canonical, languageLoaders[canonical]());
		return hljs.getLanguage(name) !== undefined;
	}
	// Any other grammar loads from its own module (in highlight.js@10.7.3 the
	// module file is named after the canonical language id: "ada" → ada.js),
	// so a rare-language render costs exactly one grammar.
	const factory = requireOrNull(`highlight.js/lib/languages/${key}.js`);
	if (factory) {
		hljs.registerLanguage(key, factory);
		return hljs.getLanguage(name) !== undefined;
	}
	// Names that are aliases of rare grammars ("yml", "htm", …) resolve
	// through the full catalog, loaded at most once. The catalog is otherwise
	// only a warm-up preload.
	if (!catalogLoaded) {
		catalogLoaded = true;
		requireOrNull("highlight.js/lib/index.js");
	}
	return hljs.getLanguage(name) !== undefined;
}

let allLanguagesPromise: Promise<void> | undefined;

export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			setImmediate(() => {
				void import("highlight.js/lib/index.js").then(
					() => resolve(),
					() => {
						// Eager languages and plaintext fallback remain available.
						resolve();
					},
				);
			});
		});
	}
	return allLanguagesPromise;
}

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter
			? textBuffer
					.split("\n")
					.map((line) => (line ? formatter(line) : line))
					.join("\n")
			: textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	if (options.language) {
		ensureLanguageRegistered(options.language);
	} else {
		// highlightAuto guesses across the registered languages; keep the set it
		// saw before grammars became lazy.
		for (const name of Object.keys(languageLoaders)) {
			ensureLanguageRegistered(name);
		}
	}
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return ensureLanguageRegistered(name);
}
