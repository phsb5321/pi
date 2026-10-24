/**
 * Windowed compressed content store (W1): the working tail of the conversation stays plain in
 * heap, settled entries move to compressed buffers (Node Buffers allocate off the V8 heap), and
 * binary blobs stay raw (the blob class does not compress). Values are value-equal across the
 * round trip: `get` returns exactly what `set` stored. Lossless only.
 */
export type ContentKind = "text" | "blob";

/** Byte-lossless codec for settled text (provided by the runtime layer; the root stays portable). */
export interface LosslessCodec {
	compress(text: string): Uint8Array;
	decompress(bytes: Uint8Array): string;
}

export interface ContentStoreOptions {
	/** Entries kept plain; the working set. Default 64. */
	windowSize?: number;
	/** Lossless codec for settled text; without one every entry stays plain. */
	codec?: LosslessCodec;
}

interface Entry {
	kind: ContentKind;
	plain?: string | Uint8Array;
	compressed?: Uint8Array;
}

export class CompressedContentStore {
	private readonly entries = new Map<string, Entry>();
	private readonly windowIds: string[] = [];
	private readonly windowSize: number;
	private readonly codec: LosslessCodec | undefined;

	constructor(options: ContentStoreOptions = {}) {
		this.windowSize = Math.max(1, options.windowSize ?? 64);
		this.codec = options.codec;
	}

	set(id: string, value: string | Uint8Array, kind: ContentKind = "text"): void {
		const prior = this.entries.get(id);
		if (prior) this.forget(id);
		this.entries.set(
			id,
			kind === "blob" ? { kind, plain: Uint8Array.from(value as Uint8Array) } : { kind, plain: value },
		);
		if (kind === "text") {
			this.windowIds.push(id);
			this.settle();
		}
	}

	get(id: string): string | Uint8Array | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		if (entry.plain !== undefined) {
			if (entry.kind === "text") {
				this.promote(id);
				return entry.plain;
			}
			return Uint8Array.from(entry.plain as Uint8Array);
		}
		const text = (this.codec as LosslessCodec).decompress(entry.compressed as Uint8Array);
		entry.plain = text;
		entry.compressed = undefined;
		this.promote(id);
		return text;
	}

	delete(id: string): void {
		this.forget(id);
		this.entries.delete(id);
	}

	clear(): void {
		this.entries.clear();
		this.windowIds.length = 0;
	}

	/** Retained bytes (compressed entries count their backing buffer; blobs their raw bytes). */
	stats(): { entries: number; plainText: number; compressedEntries: number; retainedBytes: number } {
		const encoder = new TextEncoder();
		let plainText = 0;
		let compressedEntries = 0;
		let retainedBytes = 0;
		const compressedBuffers = new Set<ArrayBufferLike>();
		for (const entry of this.entries.values()) {
			if (entry.compressed) {
				compressedEntries += 1;
				if (!compressedBuffers.has(entry.compressed.buffer)) {
					compressedBuffers.add(entry.compressed.buffer);
					retainedBytes += entry.compressed.buffer.byteLength;
				}
			} else if (typeof entry.plain === "string") {
				plainText += 1;
				retainedBytes += encoder.encode(entry.plain).byteLength;
			} else if (entry.plain) {
				retainedBytes += entry.plain.byteLength;
			}
		}
		return { entries: this.entries.size, plainText, compressedEntries, retainedBytes };
	}

	private promote(id: string): void {
		const entry = this.entries.get(id);
		if (!entry || entry.kind !== "text" || entry.plain === undefined) return;
		this.forget(id);
		this.windowIds.push(id);
		this.settle();
	}

	private settle(): void {
		while (this.windowIds.length > this.windowSize) {
			const id = this.windowIds.shift() as string;
			const entry = this.entries.get(id);
			if (!entry || entry.plain === undefined) continue;
			if (typeof entry.plain === "string" && this.codec) {
				entry.compressed = this.codec.compress(entry.plain);
				entry.plain = undefined;
			}
		}
	}

	private forget(id: string): void {
		const index = this.windowIds.indexOf(id);
		if (index !== -1) this.windowIds.splice(index, 1);
	}
}
