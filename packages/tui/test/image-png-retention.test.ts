import assert from "node:assert";
import { describe, it } from "node:test";
import { Image, setImageTranscoder } from "../src/components/image.ts";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";

// Retention pin for the converted PNG of a non-PNG kitty image. The PNG lives in the instance
// (`pngData`) and in the module-level transcode cache. After windowed eviction, neither may keep it:
// the next paint must transcode again. A retained PNG shows up as a transcoder call that never happens.
const N = 5;
const theme = { fallbackColor: (s: string) => s };
const paint = (image: Image) =>
	(image as unknown as { prepareRenderedLinesForPaint(): boolean }).prepareRenderedLinesForPaint();

describe("Image drops its converted PNG after eviction", () => {
	it("re-transcodes on the first paint after a drop", () => {
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		let calls = 0;
		setImageTranscoder((base64) => {
			calls += 1;
			return `iVBORw0KGgo${base64.slice(11)}`;
		});
		try {
			const images = Array.from(
				{ length: N },
				(_, i) => new Image(`/9j/${i}${"B".repeat(1000)}`, "image/jpeg", theme, { maxWidthCells: 60 }),
			);
			for (const image of images) image.render(80);
			assert.equal(calls, N, "first render transcodes each image once");

			for (const image of images) (image as unknown as { dropRenderedLines(): void }).dropRenderedLines();
			for (const image of images) image.render(80); // layout measurement: stubs, no transcode
			assert.equal(calls, N, "measurement after a drop must not transcode");

			for (const image of images) {
				assert.equal(paint(image), true);
				image.render(80);
			}
			assert.equal(calls, 2 * N, "paint after a drop must transcode again (PNG was released)");
		} finally {
			setImageTranscoder(undefined);
			resetCapabilitiesCache();
		}
	});
});
