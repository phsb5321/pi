import assert from "node:assert";
import { describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";

// Retention pin for windowed eviction: layout frees a component's rendered lines through
// dropRenderedLines(). A Box that is not dropped keeps copies of every child line in its own
// cache, so the evicted lines stay on the heap. Heap delta is measured after gc().
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const N = 30;
const CHARS = 200_000;

function heapAfterGc(): number {
	gc();
	return process.memoryUsage().heapUsed;
}

describe("Box drops its cached lines when its subtree is evicted", () => {
	it("frees the child line copies held by Box after dropRenderedLines", async () => {
		const boxes: Box[] = [];
		const texts: Text[] = [];
		for (let i = 0; i < N; i++) {
			const text = new Text(`${i} ${"word ".repeat(CHARS / 5)}`, 0, 0);
			const box = new Box(0, 0);
			box.addChild(text);
			box.render(80);
			boxes.push(box);
			texts.push(text);
		}
		await new Promise((resolve) => setImmediate(resolve));
		const before = heapAfterGc();

		// What layout's eviction does to an out-of-window subtree.
		for (const box of boxes) {
			(box as unknown as { dropRenderedLines?: () => void }).dropRenderedLines?.();
			for (const text of texts) text.dropRenderedLines();
		}
		await new Promise((resolve) => setImmediate(resolve));
		const after = heapAfterGc();
		const freed = before - after;
		process.stderr.write(`MEASURE box-drop freed=${freed} bytes (N=${N}, ~${CHARS / 1000} KB text each)\n`);

		// Half of the ~6 MB of child text should be collectable once Box stops holding copies.
		assert.ok(freed > (N * CHARS) / 2, `expected >= half of retained text freed, got ${freed} bytes`);
		assert.equal(boxes.length, N);
	});

	it("re-renders identically after a drop", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		const box = new Box(1, 0);
		box.addChild(text);
		const before = box.render(12);
		(box as unknown as { dropRenderedLines?: () => void }).dropRenderedLines?.();
		text.dropRenderedLines();
		assert.deepEqual(box.render(12).length, before.length);
	});
});
