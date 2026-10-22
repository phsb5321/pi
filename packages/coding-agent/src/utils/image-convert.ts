import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		// Conversion failed
		return null;
	}
}

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}
	return encodePng(photon, bytes);
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * Load photon and return a synchronous PNG transcoder for pi-tui's Kitty image rendering.
 * Returns undefined if photon cannot be loaded.
 */
export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	const photon = await loadPhoton();
	if (!photon) return undefined;
	return (base64Data) => {
		const pngBytes = encodePng(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

let pngTranscoderLoad: Promise<boolean> | undefined;
let pngTranscoderRegistered = false;
let pngTranscoderArmed = false;
let pngTranscoderUnavailable = false;
const pngRepaints = new Set<{ active: boolean; ready: () => void }>();

function initializePngTranscoder(): Promise<boolean> {
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		if (!transcoder) {
			pngTranscoderUnavailable = true;
			for (const repaint of pngRepaints) repaint.active = false;
			pngRepaints.clear();
			return false;
		}
		setImageTranscoder(transcoder);
		pngTranscoderRegistered = true;
		for (const repaint of pngRepaints) {
			void Promise.resolve().then(() => {
				if (!repaint.active) return;
				repaint.active = false;
				repaint.ready();
			});
		}
		pngRepaints.clear();
		return true;
	});
	return pngTranscoderLoad;
}

/** Arm cold Kitty conversion without loading Photon; the caller owns the repaint disposer. */
export function armPngTranscoder(onRegistered: () => void): () => void {
	if (pngTranscoderRegistered || pngTranscoderUnavailable || getCapabilities().images !== "kitty") {
		return () => undefined;
	}
	if (!pngTranscoderArmed && !pngTranscoderLoad) {
		setImageTranscoder(() => {
			void initializePngTranscoder();
			return null;
		});
		pngTranscoderArmed = true;
	}
	const repaint = { active: true, ready: onRegistered };
	pngRepaints.add(repaint);
	return () => {
		repaint.active = false;
		pngRepaints.delete(repaint);
	};
}

/**
 * On Kitty-protocol terminals, register photon as pi-tui's image transcoder so non-PNG images render.
 * Loads photon once. `onRegistered` runs after registration so callers can re-render images that
 * showed text fallbacks; it is not called if the transcoder was already registered or cannot load.
 */
export function ensurePngTranscoder(onRegistered: () => void): void {
	if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
	void initializePngTranscoder().then((registered) => {
		if (registered) onRegistered();
	});
}
