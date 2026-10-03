import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.ts";

export interface OutputTailOptions {
	maxLines?: number;
	maxBytes?: number;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Bounded rolling tail of normalized streaming text (bounded tail retention, W3).
 *
 * Retains the raw UTF-16 suffix of the stream — the last `maxBytes + 4` code
 * units, never re-truncated — and derives the display tail with the same
 * `truncateTail` call the reference runs over the full stream. The dropped
 * prefix is always beyond the byte budget, so an incomplete first line cannot
 * fit the walk; a trailing open high surrogate (chunk boundary mid-emoji) is
 * kept naturally in raw storage until its pair half arrives. `truncateTail` is
 * applied once per read over the retained raw, never recursively over
 * truncated state (it is not associative over suffixes).
 *
 * Reference-oracle invariants (tests compare against `truncateTail(full)` and
 * `Buffer.byteLength(full)` of the full concatenation at every append):
 * - `tailText === truncateTail(full, caps).content`;
 * - `truncated === truncateTail(full, caps).truncated`;
 * - `output` is an exact suffix of the normalized stream;
 * - `droppedBytes === byteLength(full) - byteLength(output)`.
 *
 * Retention ceiling (honest): at most `maxBytes + 4` UTF-16 units, i.e. at
 * most `3 * (maxBytes + 4)` UTF-8 bytes (CJK 3 bytes/unit, surrogate pairs 4
 * bytes per 2 units) plus the string header. `totalBytes` counts a surrogate
 * pair split across appends as its completed 4 bytes (not 3 + 3).
 *
 * ponytail: per-append cost is O(incoming chunk + retained units); the display
 * re-derives from raw, so there is no incremental truncation state to keep
 * coherent. `tailText`/`truncated` recompute per call (one `truncateTail`
 * each); memoize externally only if profiling shows it (upgrade path).
 */
export class BoundedOutputTail {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private raw = "";
	private totalBytes = 0;

	constructor(options: OutputTailOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		for (const value of [this.maxLines, this.maxBytes]) {
			if (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER - 4) {
				throw new RangeError("Output tail limits must be positive safe integers with room for lookbehind");
			}
		}
	}

	append(clean: string): void {
		if (clean.length === 0) return;
		const splitPair =
			this.raw.length > 0 &&
			isHighSurrogate(this.raw.charCodeAt(this.raw.length - 1)) &&
			isLowSurrogate(clean.charCodeAt(0));
		this.totalBytes += Buffer.byteLength(clean, "utf-8") - (splitPair ? 2 : 0);
		const suffix = (this.raw + clean).slice(-(this.maxBytes + 4));
		// V8 slices can retain the complete parent chunk. UTF-16 copying detaches
		// that backing without replacing a split surrogate at the chunk boundary.
		this.raw = Buffer.from(suffix, "utf16le").toString("utf16le");
	}

	/** `truncateTail(full, caps).content`, re-derived from the retained raw. */
	get tailText(): string {
		return truncateTail(this.raw, { maxLines: this.maxLines, maxBytes: this.maxBytes }).content;
	}

	/** Retained raw suffix of the normalized stream. */
	get output(): string {
		return this.raw;
	}

	/** `byteLength(full) - byteLength(output)`. */
	get droppedBytes(): number {
		return this.totalBytes - Buffer.byteLength(this.raw, "utf-8");
	}

	/** `truncateTail(full, caps).truncated`. */
	get truncated(): boolean {
		return truncateTail(this.raw, { maxLines: this.maxLines, maxBytes: this.maxBytes }).truncated;
	}
}
