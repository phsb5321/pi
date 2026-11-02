import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

// Streaming a message appends to one growing string. The component re-lexes only the last block and reuses the
// layout of every finished block, so every prefix must render exactly like a fresh parse of that prefix.
const CORPUS: Array<{ name: string; text: string; width: number }> = [
	{
		name: "paragraph growth",
		text: "one two three **four** five `six` seven eight nine ten eleven twelve\n",
		width: 24,
	},
	{ name: "setext arrives late", text: "title line\n---\n\nbody after\n", width: 30 },
	{ name: "list grows", text: "- alpha\n- beta with `code`\n  - nested gamma\n- delta\n", width: 26 },
	{
		name: "ordered list grows",
		text: "1. first\n2. second\n3. third with **bold**\n4. fourth\n",
		width: 28,
	},
	{
		name: "fence closes late",
		text: "before\n\n```ts\nconst a = 1;\nfunction f() {\n  return a;\n}\n```\n\nafter\n",
		width: 30,
	},
	{ name: "partial fence tail", text: "text\n\n```\ncode line\n``", width: 30 },
	{ name: "list partial fence", text: "- item\n\n  ```\n  code\n  ``", width: 30 },
	{ name: "quote grows", text: "> first line\n> second **bold** line\n>\n> - item\n", width: 26 },
	{ name: "table grows", text: "| a | b |\n| - | - |\n| 1 | x |\n| 2 | y |\n", width: 30 },
	{ name: "latex block grows", text: "inline $x^2$ then\n\n$$\n\\frac{a}{b}\n$$\n\nend $y^2$\n", width: 28 },
	{
		name: "reference definition arrives late",
		text: "see [x][id] and [y][id]\n\n[id]: https://ref.example/x\n",
		width: 44,
	},
	{ name: "html and escapes", text: "<b>raw</b> and \\*literal\\* and &amp;\n\n<span>more</span>\n", width: 30 },
	{ name: "hard break grows", text: "line one  \nline two\n\npara three\n", width: 20 },
	{ name: "wide wrap", text: `${"word ".repeat(40)}\n\n${"déjà 漢字 ".repeat(12)}\n`, width: 22 },
];

describe("Markdown incremental streaming", () => {
	for (const doc of CORPUS) {
		it(`renders every prefix of "${doc.name}" like a fresh parse`, () => {
			const streaming = new Markdown("", 1, 0, defaultMarkdownTheme);
			let previous: string[] = [];
			for (let length = 1; length <= doc.text.length; length++) {
				const source = doc.text.slice(0, length);
				streaming.setText(source);
				const incremental = streaming.render(doc.width);
				const fresh = new Markdown(source, 1, 0, defaultMarkdownTheme).render(doc.width);
				assert.deepStrictEqual(
					incremental,
					fresh,
					`prefix ${length} of "${doc.name}" differs: ${JSON.stringify(source.slice(-24))}`,
				);
				previous = incremental;
			}
			assert.ok(previous.length > 0);
		});
	}

	it("keeps the finished prefix when a block is appended after a blank line", () => {
		const streaming = new Markdown("first block\n", 0, 0, defaultMarkdownTheme);
		const first = streaming.render(40);
		streaming.setText("first block\n\nsecond block\n");
		const second = streaming.render(40);
		assert.deepStrictEqual(second.slice(0, first.length), first, "the first block must keep its rendered lines");
		assert.deepStrictEqual(
			second,
			new Markdown("first block\n\nsecond block\n", 0, 0, defaultMarkdownTheme).render(40),
		);
	});

	it("re-resolves an earlier link when its reference definition arrives later", () => {
		const streaming = new Markdown("[x][id]\n", 0, 0, defaultMarkdownTheme);
		const before = streaming.render(60).join("\n");
		assert.ok(!before.includes("ref.example"), "no href before the definition exists");
		streaming.setText("[x][id]\n\n[id]: https://ref.example/x\n");
		const after = streaming.render(60).join("\n");
		assert.deepStrictEqual(
			after,
			new Markdown("[x][id]\n\n[id]: https://ref.example/x\n", 0, 0, defaultMarkdownTheme).render(60).join("\n"),
		);
	});

	it("re-renders across a width change", () => {
		const streaming = new Markdown("", 1, 0, defaultMarkdownTheme);
		streaming.setText(`${"word ".repeat(30)}\n`);
		const wide = streaming.render(40);
		const narrow = streaming.render(20);
		assert.deepStrictEqual(narrow, new Markdown(`${"word ".repeat(30)}\n`, 1, 0, defaultMarkdownTheme).render(20));
		assert.ok(narrow.length > wide.length);
		assert.deepStrictEqual(streaming.render(40), wide, "returning to the old width keeps the old layout");
	});
});

// Deterministic fragment fuzz: block types and their boundaries are where an incremental lexer can go wrong, so
// assemble documents out of the fragments and compare every prefix against a fresh parse.
const FRAGMENTS = [
	"# heading\n\n",
	"setext\n---\n\n",
	"plain paragraph text that is long enough to wrap at the test width\n\n",
	"- bullet a\n- bullet b\n  - nested\n\n",
	"1. one\n2. two\n\n",
	"> quote line\n>\n> second\n\n",
	"```ts\nconst a = 1;\n```\n\n",
	"```\nunclosed\n",
	"| a | b |\n| - | - |\n| 1 | 2 |\n\n",
	"$inline$ and $$block$$\n\n",
	"$$\n\\frac{1}{2}\n$$\n\n",
	"[link][ref]\n\n[ref]: https://example.com/x\n\n",
	"<div>html</div>\n\n",
	"\n\n",
	"  \n",
	"- \n",
	"> \n",
	"text with \\*escape\\* and `code`\n\n",
];

function pseudoRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

describe("Markdown incremental streaming fuzz", () => {
	it("matches a fresh parse at every prefix of assembled documents", () => {
		const random = pseudoRandom(20261031);
		for (let doc = 0; doc < 8; doc++) {
			let text = "";
			const parts = 3 + Math.floor(random() * 3);
			for (let part = 0; part < parts; part++) {
				text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
			}
			const width = 18 + Math.floor(random() * 20);
			const streaming = new Markdown("", 1, 0, defaultMarkdownTheme);
			for (let length = 1; length <= text.length; length++) {
				const source = text.slice(0, length);
				streaming.setText(source);
				assert.deepStrictEqual(
					streaming.render(width),
					new Markdown(source, 1, 0, defaultMarkdownTheme).render(width),
					`doc ${doc} prefix ${length}: ${JSON.stringify(source.slice(-20))}`,
				);
			}
		}
	});
});
