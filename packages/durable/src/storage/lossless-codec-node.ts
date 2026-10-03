import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { LosslessCodec } from "./compressed-content-store.ts";

/** Brotli codec for settled conversation content (Node runtime layer). */
export const nodeLosslessCodec: LosslessCodec = {
	// Compression runs on the mutation line; copy only the output bytes so each
	// settled entry does not retain zlib's much larger output slab.
	compress: (text) =>
		Uint8Array.from(
			brotliCompressSync(Buffer.from(text, "utf8"), { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }),
		),
	decompress: (bytes) => brotliDecompressSync(Buffer.from(bytes)).toString("utf8"),
};
