import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Images from "../../tui/src/components/image.ts";
import type * as Tui from "../../tui/src/index.ts";
import type * as Converter from "../src/utils/image-convert.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const state = vi.hoisted(() => ({
	images: "kitty" as "kitty" | "iterm2" | null,
	load: vi.fn(),
	install: vi.fn(),
	free: vi.fn(),
	raw: vi.fn(),
	onInstall: undefined as (() => void) | undefined,
	Image: undefined as typeof Images.Image | undefined,
	resetImage: undefined as (() => void) | undefined,
}));

vi.mock("../src/utils/photon.ts", () => ({ loadPhoton: state.load }));
vi.mock("@earendil-works/pi-tui", async () => {
	// Pin the current source Image and its registration singleton, not an installed dist copy.
	const actual = await vi.importActual<typeof Tui>("../../tui/src/index.ts");
	state.Image = actual.Image;
	state.resetImage = () => actual.setImageTranscoder(undefined);
	actual.setCapabilityOverrides({ images: state.images, trueColor: true, hyperlinks: false });
	return {
		...actual,
		getCapabilities: () => {
			actual.setCapabilityOverrides({ images: state.images, trueColor: true, hyperlinks: false });
			return actual.getCapabilities();
		},
		setImageTranscoder: (transcoder: Images.ImageTranscoder | undefined) => {
			actual.setImageTranscoder(transcoder);
			state.install(transcoder);
			state.onInstall?.();
		},
	};
});

type Conversion = typeof Converter & { armPngTranscoder?: (callback: () => void) => () => void };

/** Pins the mocked Photon load as an unresolved promise; the test settles it through the returned resolver. */
function pendingPhotonLoad(): () => ((value: ReturnType<typeof photon>) => void) | undefined {
	let resolve: ((value: ReturnType<typeof photon>) => void) | undefined;
	state.load.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	return () => resolve;
}

/** Arms the UI and demands one non-PNG image render, which is what starts a real Photon load. */
async function armedUiWithDemandedImage(): Promise<{
	conversion: Conversion;
	images: Pick<typeof Images, "Image">;
	ui: Probe;
}> {
	const loaded = await modules();
	const ui = probe(loaded.conversion);
	ui.ensurePngTranscoder();
	extensionImage(loaded.images).render(40);
	return { conversion: loaded.conversion, images: loaded.images, ui };
}

/** Loads the conversion module pair and arms the PNG transcoder once, the way interactive startup does. */
async function armedUi(
	images: ImageInstance[] = [],
): Promise<{ conversion: Conversion; images: Pick<typeof Images, "Image">; ui: Probe }> {
	const loaded = await modules();
	const ui = probe(loaded.conversion, images);
	ui.ensurePngTranscoder();
	return { conversion: loaded.conversion, images: loaded.images, ui };
}
type ImageInstance = InstanceType<typeof Images.Image>;
interface Probe {
	ensurePngTranscoder(): void;
	stopInteractiveTui(output: "none"): void;
	ui: {
		invalidate: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
	};
	renderer: { mode: "regular" };
}

// Execute the REAL owned method bodies, without constructing sessions/providers or the full CLI.
// The old helper calls the real eager ensure function: RED is loader-count1, not a missing arm API.
function probe(conversion: Conversion, images: ImageInstance[] = []): Probe {
	const source = readFileSync(new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url), "utf8");
	// ponytail: extract only these tab-indented owned methods; formatting drift fails closed.
	const methods = source.match(
		/^\tprivate (?:ensurePngTranscoder|disposePngTranscoder|stopInteractiveTui)\([^\n]*\)[^\n]* \{[\s\S]*?^\t\}/gm,
	);
	if (!methods?.some((item) => item.includes("private ensurePngTranscoder")))
		throw new Error("Missing original owned helper");
	const compiled = stripTypeScriptTypes(`class PngProbe {\n${methods.join("\n")}\n}\nexports.PngProbe = PngProbe;`);
	const exports: { PngProbe?: new () => Probe } = {};
	runInNewContext(compiled, {
		exports,
		ensurePngTranscoder: conversion.ensurePngTranscoder,
		armPngTranscoder: conversion.armPngTranscoder ?? conversion.ensurePngTranscoder,
		getCapabilities: () => ({ images: state.images }),
	});
	if (!exports.PngProbe) throw new Error("Real method control did not compile");
	return Object.assign(new exports.PngProbe(), {
		ui: {
			invalidate: vi.fn(() => {
				for (const image of images) image.invalidate();
			}),
			requestRender: vi.fn(),
			stop: vi.fn(),
		},
		renderer: { mode: "regular" as const },
	});
}

function photon(badBytes?: string) {
	const pixels = new Uint8Array(Array.from({ length: 24 }, (_, index) => index + 1));
	class PhotonImage {
		private readonly bytes: Uint8Array;
		private readonly width: number;
		private readonly height: number;
		constructor(bytes?: Uint8Array, width = 2, height = 3) {
			this.bytes = bytes ?? pixels;
			this.width = width;
			this.height = height;
			if (bytes) state.raw([...bytes], width, height);
		}
		static new_from_byteslice(bytes: Uint8Array) {
			if (badBytes && Buffer.from(bytes).toString() === badBytes) throw new Error("decode failed");
			return new PhotonImage();
		}
		get_bytes() {
			return new Uint8Array(Buffer.from(PNG, "base64"));
		}
		get_raw_pixels() {
			return this.bytes;
		}
		get_width() {
			return this.width;
		}
		get_height() {
			return this.height;
		}
		free() {
			state.free();
		}
	}
	return { PhotonImage };
}

async function modules() {
	const conversion = await vi.importActual<Conversion>("../src/utils/image-convert.ts");
	if (!state.Image || !state.resetImage) throw new Error("Current-source Image was not bound to registration");
	// Vitest keeps mock-factory exports across resetModules; clear the real source singleton per case.
	state.resetImage();
	return { conversion, images: { Image: state.Image } };
}

async function settled() {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

function extensionImage(images: Pick<typeof Images, "Image">, data = "anBlZw==", mime = "image/jpeg") {
	return new images.Image(data, mime, { fallbackColor: (text) => text }, {}, { widthPx: 1, heightPx: 1 });
}

beforeEach(() => {
	vi.resetModules();
	state.images = "kitty";
	state.load.mockReset().mockResolvedValue(photon());
	state.install.mockClear();
	state.free.mockClear();
	state.raw.mockClear();
	state.onInstall = undefined;
});

describe("normal CLI cold PNG arming and owned repaint lifecycle", () => {
	it("real original text-only startup must make zero Photon loads", async () => {
		const { ui } = await armedUi();
		expect(state.load).toHaveBeenCalledTimes(0);
		ui.stopInteractiveTui("none");
	});

	it("repeated runtime-settings arming stays cold and installs only once", async () => {
		const { ui } = await armedUi();
		for (let index = 0; index < 100; index++) ui.ensurePngTranscoder();
		expect(state.load).toHaveBeenCalledTimes(0);
		expect(state.install).toHaveBeenCalledTimes(1);
		ui.stopInteractiveTui("none");
	});

	it("non-Kitty is cold and capability changes can arm later", async () => {
		state.images = "iterm2";
		const { ui } = await armedUi();
		expect(state.load).toHaveBeenCalledTimes(0);
		expect(state.install).toHaveBeenCalledTimes(0);
		state.images = "kitty";
		ui.ensurePngTranscoder();
		expect(state.load).toHaveBeenCalledTimes(0);
		expect(state.install).toHaveBeenCalledTimes(1);
		ui.stopInteractiveTui("none");
	});

	it("PNG conversion and extension Image remain byte-preserving and cold", async () => {
		const { conversion, images, ui } = await armedUi();
		expect(await conversion.convertToPng(PNG, "image/png")).toEqual({ data: PNG, mimeType: "image/png" });
		expect(extensionImage(images, PNG, "image/png").render(40).join("\n")).toContain("\x1b_G");
		expect(state.load).toHaveBeenCalledTimes(0);
		ui.stopInteractiveTui("none");
	});

	it("first extension non-PNG demand repaints the same-width fallback with a real Image", async () => {
		const { conversion, images } = await modules();
		const image = extensionImage(images);
		const ui = probe(conversion, [image]);
		ui.ensurePngTranscoder();
		expect(state.load).toHaveBeenCalledTimes(0);
		expect(image.render(40).join("\n")).not.toContain("\x1b_G");
		expect(state.load).toHaveBeenCalledTimes(1);
		await settled();
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(1);
		expect(ui.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(image.render(40).join("\n")).toContain("\x1b_G");
		expect(state.free).toHaveBeenCalledTimes(1);
		ui.stopInteractiveTui("none");
	});

	it("concurrent demands and legacy direct-image registration share one load", async () => {
		const { conversion, images } = await modules();
		const one = extensionImage(images, "b25l");
		const two = extensionImage(images, "dHdv");
		const ui = probe(conversion, [one, two]);
		ui.ensurePngTranscoder();
		one.render(40);
		two.render(40);
		const direct = vi.fn();
		conversion.ensurePngTranscoder(direct);
		expect(state.load).toHaveBeenCalledTimes(1);
		await settled();
		expect(direct).toHaveBeenCalledTimes(1);
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(1);
		expect(one.render(40).join("\n")).toContain("\x1b_G");
		expect(two.render(40).join("\n")).toContain("\x1b_G");
		ui.stopInteractiveTui("none");
	});

	it("legacy registration can initiate loading and still notify the armed UI", async () => {
		const { conversion } = await modules();
		const ui = probe(conversion);
		ui.ensurePngTranscoder();
		const direct = vi.fn();
		conversion.ensurePngTranscoder(direct);
		await settled();
		expect(state.load).toHaveBeenCalledTimes(1);
		expect(direct).toHaveBeenCalledTimes(1);
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(1);
		ui.stopInteractiveTui("none");
	});

	it("legacy callback multiplicity and warm no-notification semantics stay unchanged", async () => {
		const { conversion } = await modules();
		const ready = vi.fn();
		conversion.ensurePngTranscoder(ready);
		conversion.ensurePngTranscoder(ready);
		await settled();
		expect(ready).toHaveBeenCalledTimes(2);
		conversion.ensurePngTranscoder(ready);
		await settled();
		expect(ready).toHaveBeenCalledTimes(2);
		expect(state.load).toHaveBeenCalledTimes(1);
	});

	it("stop before pending completion never repaints the disposed UI", async () => {
		pendingPhotonLoad();
		const { ui } = await armedUiWithDemandedImage();
		ui.stopInteractiveTui("none");
		await settled();
		expect(ui.ui.stop).toHaveBeenCalledTimes(1);
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(0);
		expect(ui.ui.requestRender).toHaveBeenCalledTimes(0);
	});

	it("disposal during actual registration suppresses the queued repaint", async () => {
		const { conversion, images } = await modules();
		const ui = probe(conversion);
		ui.ensurePngTranscoder();
		state.onInstall = () => ui.stopInteractiveTui("none");
		extensionImage(images).render(40);
		await settled();
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(0);
		expect(ui.ui.requestRender).toHaveBeenCalledTimes(0);
	});

	it("old disposed subscription cannot suppress a rearmed renderer", async () => {
		const pendingResolve = pendingPhotonLoad();
		const { ui } = await armedUiWithDemandedImage();
		ui.stopInteractiveTui("none");
		ui.ensurePngTranscoder();
		pendingResolve()?.(photon());
		await settled();
		expect(state.load).toHaveBeenCalledTimes(1);
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(1);
		ui.stopInteractiveTui("none");
	});

	it("unavailable backend keeps fallback without rearming loads or success callbacks", async () => {
		state.load.mockResolvedValue(null);
		const { conversion, images } = await modules();
		const ui = probe(conversion);
		ui.ensurePngTranscoder();
		const image = extensionImage(images);
		image.render(40);
		await settled();
		for (let index = 0; index < 10; index++) {
			ui.ensurePngTranscoder();
			image.invalidate();
			image.render(40);
		}
		expect(state.load).toHaveBeenCalledTimes(1);
		expect(ui.ui.invalidate).toHaveBeenCalledTimes(0);
		expect(image.render(40).join("\n")).not.toContain("\x1b_G");
		ui.stopInteractiveTui("none");
	});

	it("bad data keeps fallback while good subsequent images still convert", async () => {
		state.load.mockResolvedValue(photon("bad"));
		const { conversion, images } = await modules();
		const bad = extensionImage(images, Buffer.from("bad").toString("base64"));
		const ui = probe(conversion, [bad]);
		ui.ensurePngTranscoder();
		bad.render(40);
		await settled();
		expect(bad.render(40).join("\n")).not.toContain("\x1b_G");
		expect(extensionImage(images).render(40).join("\n")).toContain("\x1b_G");
		expect(state.load).toHaveBeenCalledTimes(1);
		ui.stopInteractiveTui("none");
	});

	it("direct conversion retains EXIF6 rotation and both temporary-image frees", async () => {
		const { conversion } = await modules();
		const exif6 = new Uint8Array([
			255, 216, 255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0,
			6, 0, 0, 0, 0, 0, 0, 0, 255, 217,
		]);
		expect(await conversion.convertImageBytesToPng(exif6)).toEqual(new Uint8Array(Buffer.from(PNG, "base64")));
		expect(state.raw).toHaveBeenCalledWith(
			[17, 18, 19, 20, 9, 10, 11, 12, 1, 2, 3, 4, 21, 22, 23, 24, 13, 14, 15, 16, 5, 6, 7, 8],
			3,
			2,
		);
		expect(state.free).toHaveBeenCalledTimes(2);
	});
});
