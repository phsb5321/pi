import hljs from "highlight.js/lib/core.js";
import { createRequire } from "module";
import { decodeHtmlEntityAt } from "./html.ts";

const require = createRequire(import.meta.url);

// Grammar loaders for every language in the pinned highlight.js@10.7.3
// catalog (generated from that catalog; syntax-highlight-lazy.test.ts pins
// it for drift). Each factory runs only when its language is first used, and
// the require literals stay static so every bundler embeds the modules.
const languageLoaders: Record<string, () => HighlightJsLanguageFactory> = {
	"1c": () => require("highlight.js/lib/languages/1c.js"),
	abnf: () => require("highlight.js/lib/languages/abnf.js"),
	accesslog: () => require("highlight.js/lib/languages/accesslog.js"),
	actionscript: () => require("highlight.js/lib/languages/actionscript.js"),
	ada: () => require("highlight.js/lib/languages/ada.js"),
	angelscript: () => require("highlight.js/lib/languages/angelscript.js"),
	apache: () => require("highlight.js/lib/languages/apache.js"),
	applescript: () => require("highlight.js/lib/languages/applescript.js"),
	arcade: () => require("highlight.js/lib/languages/arcade.js"),
	arduino: () => require("highlight.js/lib/languages/arduino.js"),
	armasm: () => require("highlight.js/lib/languages/armasm.js"),
	xml: () => require("highlight.js/lib/languages/xml.js"),
	asciidoc: () => require("highlight.js/lib/languages/asciidoc.js"),
	aspectj: () => require("highlight.js/lib/languages/aspectj.js"),
	autohotkey: () => require("highlight.js/lib/languages/autohotkey.js"),
	autoit: () => require("highlight.js/lib/languages/autoit.js"),
	avrasm: () => require("highlight.js/lib/languages/avrasm.js"),
	awk: () => require("highlight.js/lib/languages/awk.js"),
	axapta: () => require("highlight.js/lib/languages/axapta.js"),
	bash: () => require("highlight.js/lib/languages/bash.js"),
	basic: () => require("highlight.js/lib/languages/basic.js"),
	bnf: () => require("highlight.js/lib/languages/bnf.js"),
	brainfuck: () => require("highlight.js/lib/languages/brainfuck.js"),
	"c-like": () => require("highlight.js/lib/languages/c-like.js"),
	c: () => require("highlight.js/lib/languages/c.js"),
	cal: () => require("highlight.js/lib/languages/cal.js"),
	capnproto: () => require("highlight.js/lib/languages/capnproto.js"),
	ceylon: () => require("highlight.js/lib/languages/ceylon.js"),
	clean: () => require("highlight.js/lib/languages/clean.js"),
	clojure: () => require("highlight.js/lib/languages/clojure.js"),
	"clojure-repl": () => require("highlight.js/lib/languages/clojure-repl.js"),
	cmake: () => require("highlight.js/lib/languages/cmake.js"),
	coffeescript: () => require("highlight.js/lib/languages/coffeescript.js"),
	coq: () => require("highlight.js/lib/languages/coq.js"),
	cos: () => require("highlight.js/lib/languages/cos.js"),
	cpp: () => require("highlight.js/lib/languages/cpp.js"),
	crmsh: () => require("highlight.js/lib/languages/crmsh.js"),
	crystal: () => require("highlight.js/lib/languages/crystal.js"),
	csharp: () => require("highlight.js/lib/languages/csharp.js"),
	csp: () => require("highlight.js/lib/languages/csp.js"),
	css: () => require("highlight.js/lib/languages/css.js"),
	d: () => require("highlight.js/lib/languages/d.js"),
	markdown: () => require("highlight.js/lib/languages/markdown.js"),
	dart: () => require("highlight.js/lib/languages/dart.js"),
	delphi: () => require("highlight.js/lib/languages/delphi.js"),
	diff: () => require("highlight.js/lib/languages/diff.js"),
	django: () => require("highlight.js/lib/languages/django.js"),
	dns: () => require("highlight.js/lib/languages/dns.js"),
	dockerfile: () => require("highlight.js/lib/languages/dockerfile.js"),
	dos: () => require("highlight.js/lib/languages/dos.js"),
	dsconfig: () => require("highlight.js/lib/languages/dsconfig.js"),
	dts: () => require("highlight.js/lib/languages/dts.js"),
	dust: () => require("highlight.js/lib/languages/dust.js"),
	ebnf: () => require("highlight.js/lib/languages/ebnf.js"),
	elixir: () => require("highlight.js/lib/languages/elixir.js"),
	elm: () => require("highlight.js/lib/languages/elm.js"),
	ruby: () => require("highlight.js/lib/languages/ruby.js"),
	erb: () => require("highlight.js/lib/languages/erb.js"),
	"erlang-repl": () => require("highlight.js/lib/languages/erlang-repl.js"),
	erlang: () => require("highlight.js/lib/languages/erlang.js"),
	excel: () => require("highlight.js/lib/languages/excel.js"),
	fix: () => require("highlight.js/lib/languages/fix.js"),
	flix: () => require("highlight.js/lib/languages/flix.js"),
	fortran: () => require("highlight.js/lib/languages/fortran.js"),
	fsharp: () => require("highlight.js/lib/languages/fsharp.js"),
	gams: () => require("highlight.js/lib/languages/gams.js"),
	gauss: () => require("highlight.js/lib/languages/gauss.js"),
	gcode: () => require("highlight.js/lib/languages/gcode.js"),
	gherkin: () => require("highlight.js/lib/languages/gherkin.js"),
	glsl: () => require("highlight.js/lib/languages/glsl.js"),
	gml: () => require("highlight.js/lib/languages/gml.js"),
	go: () => require("highlight.js/lib/languages/go.js"),
	golo: () => require("highlight.js/lib/languages/golo.js"),
	gradle: () => require("highlight.js/lib/languages/gradle.js"),
	groovy: () => require("highlight.js/lib/languages/groovy.js"),
	haml: () => require("highlight.js/lib/languages/haml.js"),
	handlebars: () => require("highlight.js/lib/languages/handlebars.js"),
	haskell: () => require("highlight.js/lib/languages/haskell.js"),
	haxe: () => require("highlight.js/lib/languages/haxe.js"),
	hsp: () => require("highlight.js/lib/languages/hsp.js"),
	htmlbars: () => require("highlight.js/lib/languages/htmlbars.js"),
	http: () => require("highlight.js/lib/languages/http.js"),
	hy: () => require("highlight.js/lib/languages/hy.js"),
	inform7: () => require("highlight.js/lib/languages/inform7.js"),
	ini: () => require("highlight.js/lib/languages/ini.js"),
	irpf90: () => require("highlight.js/lib/languages/irpf90.js"),
	isbl: () => require("highlight.js/lib/languages/isbl.js"),
	java: () => require("highlight.js/lib/languages/java.js"),
	javascript: () => require("highlight.js/lib/languages/javascript.js"),
	"jboss-cli": () => require("highlight.js/lib/languages/jboss-cli.js"),
	json: () => require("highlight.js/lib/languages/json.js"),
	julia: () => require("highlight.js/lib/languages/julia.js"),
	"julia-repl": () => require("highlight.js/lib/languages/julia-repl.js"),
	kotlin: () => require("highlight.js/lib/languages/kotlin.js"),
	lasso: () => require("highlight.js/lib/languages/lasso.js"),
	latex: () => require("highlight.js/lib/languages/latex.js"),
	ldif: () => require("highlight.js/lib/languages/ldif.js"),
	leaf: () => require("highlight.js/lib/languages/leaf.js"),
	less: () => require("highlight.js/lib/languages/less.js"),
	lisp: () => require("highlight.js/lib/languages/lisp.js"),
	livecodeserver: () => require("highlight.js/lib/languages/livecodeserver.js"),
	livescript: () => require("highlight.js/lib/languages/livescript.js"),
	llvm: () => require("highlight.js/lib/languages/llvm.js"),
	lsl: () => require("highlight.js/lib/languages/lsl.js"),
	lua: () => require("highlight.js/lib/languages/lua.js"),
	makefile: () => require("highlight.js/lib/languages/makefile.js"),
	mathematica: () => require("highlight.js/lib/languages/mathematica.js"),
	matlab: () => require("highlight.js/lib/languages/matlab.js"),
	maxima: () => require("highlight.js/lib/languages/maxima.js"),
	mel: () => require("highlight.js/lib/languages/mel.js"),
	mercury: () => require("highlight.js/lib/languages/mercury.js"),
	mipsasm: () => require("highlight.js/lib/languages/mipsasm.js"),
	mizar: () => require("highlight.js/lib/languages/mizar.js"),
	perl: () => require("highlight.js/lib/languages/perl.js"),
	mojolicious: () => require("highlight.js/lib/languages/mojolicious.js"),
	monkey: () => require("highlight.js/lib/languages/monkey.js"),
	moonscript: () => require("highlight.js/lib/languages/moonscript.js"),
	n1ql: () => require("highlight.js/lib/languages/n1ql.js"),
	nginx: () => require("highlight.js/lib/languages/nginx.js"),
	nim: () => require("highlight.js/lib/languages/nim.js"),
	nix: () => require("highlight.js/lib/languages/nix.js"),
	"node-repl": () => require("highlight.js/lib/languages/node-repl.js"),
	nsis: () => require("highlight.js/lib/languages/nsis.js"),
	objectivec: () => require("highlight.js/lib/languages/objectivec.js"),
	ocaml: () => require("highlight.js/lib/languages/ocaml.js"),
	openscad: () => require("highlight.js/lib/languages/openscad.js"),
	oxygene: () => require("highlight.js/lib/languages/oxygene.js"),
	parser3: () => require("highlight.js/lib/languages/parser3.js"),
	pf: () => require("highlight.js/lib/languages/pf.js"),
	pgsql: () => require("highlight.js/lib/languages/pgsql.js"),
	php: () => require("highlight.js/lib/languages/php.js"),
	"php-template": () => require("highlight.js/lib/languages/php-template.js"),
	plaintext: () => require("highlight.js/lib/languages/plaintext.js"),
	pony: () => require("highlight.js/lib/languages/pony.js"),
	powershell: () => require("highlight.js/lib/languages/powershell.js"),
	processing: () => require("highlight.js/lib/languages/processing.js"),
	profile: () => require("highlight.js/lib/languages/profile.js"),
	prolog: () => require("highlight.js/lib/languages/prolog.js"),
	properties: () => require("highlight.js/lib/languages/properties.js"),
	protobuf: () => require("highlight.js/lib/languages/protobuf.js"),
	puppet: () => require("highlight.js/lib/languages/puppet.js"),
	purebasic: () => require("highlight.js/lib/languages/purebasic.js"),
	python: () => require("highlight.js/lib/languages/python.js"),
	"python-repl": () => require("highlight.js/lib/languages/python-repl.js"),
	q: () => require("highlight.js/lib/languages/q.js"),
	qml: () => require("highlight.js/lib/languages/qml.js"),
	r: () => require("highlight.js/lib/languages/r.js"),
	reasonml: () => require("highlight.js/lib/languages/reasonml.js"),
	rib: () => require("highlight.js/lib/languages/rib.js"),
	roboconf: () => require("highlight.js/lib/languages/roboconf.js"),
	routeros: () => require("highlight.js/lib/languages/routeros.js"),
	rsl: () => require("highlight.js/lib/languages/rsl.js"),
	ruleslanguage: () => require("highlight.js/lib/languages/ruleslanguage.js"),
	rust: () => require("highlight.js/lib/languages/rust.js"),
	sas: () => require("highlight.js/lib/languages/sas.js"),
	scala: () => require("highlight.js/lib/languages/scala.js"),
	scheme: () => require("highlight.js/lib/languages/scheme.js"),
	scilab: () => require("highlight.js/lib/languages/scilab.js"),
	scss: () => require("highlight.js/lib/languages/scss.js"),
	shell: () => require("highlight.js/lib/languages/shell.js"),
	smali: () => require("highlight.js/lib/languages/smali.js"),
	smalltalk: () => require("highlight.js/lib/languages/smalltalk.js"),
	sml: () => require("highlight.js/lib/languages/sml.js"),
	sqf: () => require("highlight.js/lib/languages/sqf.js"),
	sql_more: () => require("highlight.js/lib/languages/sql_more.js"),
	sql: () => require("highlight.js/lib/languages/sql.js"),
	stan: () => require("highlight.js/lib/languages/stan.js"),
	stata: () => require("highlight.js/lib/languages/stata.js"),
	step21: () => require("highlight.js/lib/languages/step21.js"),
	stylus: () => require("highlight.js/lib/languages/stylus.js"),
	subunit: () => require("highlight.js/lib/languages/subunit.js"),
	swift: () => require("highlight.js/lib/languages/swift.js"),
	taggerscript: () => require("highlight.js/lib/languages/taggerscript.js"),
	yaml: () => require("highlight.js/lib/languages/yaml.js"),
	tap: () => require("highlight.js/lib/languages/tap.js"),
	tcl: () => require("highlight.js/lib/languages/tcl.js"),
	thrift: () => require("highlight.js/lib/languages/thrift.js"),
	tp: () => require("highlight.js/lib/languages/tp.js"),
	twig: () => require("highlight.js/lib/languages/twig.js"),
	typescript: () => require("highlight.js/lib/languages/typescript.js"),
	vala: () => require("highlight.js/lib/languages/vala.js"),
	vbnet: () => require("highlight.js/lib/languages/vbnet.js"),
	vbscript: () => require("highlight.js/lib/languages/vbscript.js"),
	"vbscript-html": () => require("highlight.js/lib/languages/vbscript-html.js"),
	verilog: () => require("highlight.js/lib/languages/verilog.js"),
	vhdl: () => require("highlight.js/lib/languages/vhdl.js"),
	vim: () => require("highlight.js/lib/languages/vim.js"),
	x86asm: () => require("highlight.js/lib/languages/x86asm.js"),
	xl: () => require("highlight.js/lib/languages/xl.js"),
	xquery: () => require("highlight.js/lib/languages/xquery.js"),
	zephir: () => require("highlight.js/lib/languages/zephir.js"),
};

// Alias -> canonical language id for the same catalog. Later registrations
// win, matching highlight.js's alias registry.
const languageAliases: Record<string, string> = {
	ado: "stata",
	adoc: "asciidoc",
	ahk: "autohotkey",
	apacheconf: "apache",
	arm: "armasm",
	as: "actionscript",
	asc: "angelscript",
	atom: "xml",
	bat: "dos",
	bf: "brainfuck",
	bind: "dns",
	"c#": "csharp",
	"c++": "cpp",
	capnp: "capnproto",
	cc: "cpp",
	cjs: "javascript",
	clj: "clojure",
	cls: "cos",
	"cmake.in": "cmake",
	cmd: "dos",
	coffee: "coffeescript",
	console: "shell",
	cr: "crystal",
	craftcms: "twig",
	crm: "crmsh",
	cs: "csharp",
	cson: "coffeescript",
	cxx: "cpp",
	dcl: "clean",
	dfm: "delphi",
	do: "stata",
	docker: "dockerfile",
	dpr: "delphi",
	dst: "dust",
	erl: "erlang",
	f90: "fortran",
	f95: "fortran",
	feature: "gherkin",
	freepascal: "delphi",
	fs: "fsharp",
	gemspec: "ruby",
	gms: "gams",
	golang: "go",
	graph: "roboconf",
	gss: "gauss",
	gyp: "python",
	h: "c",
	"h++": "cpp",
	hbs: "htmlbars",
	hh: "cpp",
	hpp: "cpp",
	hs: "haskell",
	html: "xml",
	"html.handlebars": "htmlbars",
	"html.hbs": "htmlbars",
	https: "http",
	hx: "haxe",
	hxx: "cpp",
	hylang: "hy",
	i7: "inform7",
	iced: "coffeescript",
	icl: "clean",
	ino: "arduino",
	instances: "roboconf",
	ipython: "python",
	irb: "ruby",
	jinja: "django",
	js: "javascript",
	jsp: "java",
	jsx: "javascript",
	k: "q",
	kdb: "q",
	kt: "kotlin",
	kts: "kotlin",
	lassoscript: "lasso",
	lazarus: "delphi",
	lfm: "delphi",
	lpr: "delphi",
	ls: "livescript",
	m: "mercury",
	mak: "makefile",
	make: "makefile",
	md: "markdown",
	mikrotik: "routeros",
	mips: "mipsasm",
	mjs: "javascript",
	mk: "makefile",
	mkd: "markdown",
	mkdown: "markdown",
	ml: "sml",
	mm: "objectivec",
	mma: "mathematica",
	moo: "mercury",
	moon: "moonscript",
	mysql: "sql_more",
	nc: "gcode",
	nginxconf: "nginx",
	nixos: "nix",
	"obj-c": "objectivec",
	"obj-c++": "objectivec",
	objc: "objectivec",
	"objective-c++": "objectivec",
	oracle: "sql_more",
	osascript: "applescript",
	p21: "step21",
	pas: "delphi",
	pascal: "delphi",
	patch: "diff",
	pb: "purebasic",
	pbi: "purebasic",
	pcmk: "crmsh",
	"pf.conf": "pf",
	php3: "php",
	php4: "php",
	php5: "php",
	php6: "php",
	php7: "php",
	php8: "php",
	pl: "perl",
	plist: "xml",
	pm: "perl",
	podspec: "ruby",
	postgres: "pgsql",
	postgresql: "pgsql",
	pp: "puppet",
	ps: "powershell",
	ps1: "powershell",
	py: "python",
	pycon: "python-repl",
	qt: "qml",
	rb: "ruby",
	re: "reasonml",
	rs: "rust",
	rss: "xml",
	scad: "openscad",
	sci: "scilab",
	sh: "bash",
	st: "smalltalk",
	stanfuncs: "stan",
	step: "step21",
	stp: "step21",
	styl: "stylus",
	sv: "verilog",
	svg: "xml",
	svh: "verilog",
	tao: "xl",
	tex: "latex",
	text: "plaintext",
	thor: "ruby",
	tk: "tcl",
	toml: "ini",
	ts: "typescript",
	tsx: "typescript",
	txt: "plaintext",
	v: "verilog",
	vb: "vbnet",
	vbs: "vbscript",
	"wildfly-cli": "jboss-cli",
	wl: "mathematica",
	wsf: "xml",
	"x++": "axapta",
	xhtml: "xml",
	xjb: "xml",
	xls: "excel",
	xlsx: "excel",
	xpath: "xquery",
	xq: "xquery",
	xsd: "xml",
	xsl: "xml",
	yml: "yaml",
	zep: "zephir",
	zone: "dns",
	zsh: "bash",
};

// Canonical ids win over aliases, exactly like highlight.js's getLanguage
// (`languages[name] || languages[aliases[name]]`).
const languageNameToCanonical = new Map<string, string>();
for (const [alias, canonical] of Object.entries(languageAliases)) {
	languageNameToCanonical.set(alias, canonical);
}
for (const canonical of Object.keys(languageLoaders)) {
	languageNameToCanonical.set(canonical, canonical);
}

// Registers the grammar for `name` on first use and reports whether the name
// is renderable. Every highlight consumer goes through here, so a render
// never falls back to plain output while a grammar is merely not loaded yet,
// and the full catalog is never evaluated.
function ensureLanguageRegistered(name: string): boolean {
	if (hljs.getLanguage(name) !== undefined) {
		return true;
	}
	const canonical = languageNameToCanonical.get(name.toLowerCase());
	if (canonical === undefined) {
		return false;
	}
	const definition = languageLoaders[canonical]()(hljs);
	hljs.registerLanguage(canonical, () => definition);
	// registerLanguage claims the grammar's declared aliases; re-point each to
	// its catalog winner so lazy registration order cannot change resolution
	// (disputed aliases like h, cc, hbs, ml must always resolve like upstream).
	const aliasesByWinner = new Map<string, string[]>();
	for (const alias of definition.aliases ?? []) {
		const key = alias.toLowerCase();
		const winner = languageNameToCanonical.get(key) ?? canonical;
		const keys = aliasesByWinner.get(winner) ?? [];
		keys.push(key);
		aliasesByWinner.set(winner, keys);
	}
	for (const [winner, keys] of aliasesByWinner) {
		hljs.registerAliases(keys, { languageName: winner });
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
		// highlightAuto guesses across the registered languages; ensure the full
		// catalog so its guess matches the settled upstream behavior. No product
		// path calls highlight without a language.
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
