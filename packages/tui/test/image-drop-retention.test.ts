import assert from "node:assert";
import { describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { Image } from "../src/components/image.ts";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";

// Retention pin for windowed eviction: an Image caches its kitty escape sequence, which embeds the
// whole base64 payload. Layout frees rendered lines through dropRenderedLines(); an Image that does
// not implement it keeps that copy on the heap after the image scrolls out of the window.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const N = 20;
const PAYLOAD = 300_000;
const theme = { fallbackColor: (s: string) => s };

function fakePng(): string {
	// PNG signature + filler. Dimensions fall back to 800x600; the payload size is what matters here.
	return `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ${"A".repeat(PAYLOAD)}`;
}

describe("Image drops its cached kitty sequence when its subtree is evicted", () => {
	it("frees the rendered sequence after dropRenderedLines", async () => {
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		try {
			const images: Image[] = [];
			for (let i = 0; i < N; i++) {
				const image = new Image(fakePng(), "image/png", theme, { maxWidthCells: 60 });
				const lines = image.render(80);
				assert.ok(lines.join("").length > PAYLOAD / 2, "render must embed the payload");
				images.push(image);
			}
			await new Promise((resolve) => setImmediate(resolve));
			gc();
			const before = process.memoryUsage().heapUsed;

			for (const image of images) (image as unknown as { dropRenderedLines?: () => void }).dropRenderedLines?.();
			await new Promise((resolve) => setImmediate(resolve));
			gc();
			const freed = before - process.memoryUsage().heapUsed;
			process.stderr.write(`MEASURE image-drop freed=${freed} bytes (N=${N}, ~${PAYLOAD / 1000} KB payload each)\n`);
			assert.ok(freed > (N * PAYLOAD) / 2, `expected >= half of rendered payloads freed, got ${freed} bytes`);
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("Image after eviction", () => {
	it("answers measurement with stub rows of the same height and re-renders only for paint", () => {
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		try {
			const image = new Image(fakePng(), "image/png", theme, { maxWidthCells: 60 });
			const rows = image.render(80).length;
			(image as unknown as { dropRenderedLines(): void }).dropRenderedLines();
			const stubs = image.render(80);
			assert.equal(stubs.length, rows, "stub height must match the rendered rows");
			assert.ok(stubs.join("").length < 16, "measurement must not re-embed the payload");
			assert.equal(
				(image as unknown as { prepareRenderedLinesForPaint(): boolean }).prepareRenderedLinesForPaint(),
				true,
			);
			assert.ok(image.render(80).join("").length > PAYLOAD / 2, "paint re-renders the real sequence");
		} finally {
			resetCapabilitiesCache();
		}
	});
});
