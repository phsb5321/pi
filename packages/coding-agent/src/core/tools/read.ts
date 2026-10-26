import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

/** Files above this size are scanned in chunks instead of being decoded and split whole. */
const WINDOW_READ_MIN_BYTES = 1024 * 1024;
const WINDOW_CHUNK_BYTES = 1024 * 1024;

interface TextWindow {
	/** Lines in the file, as `content.split("\n").length` counts them. */
	totalFileLines: number;
	/** Decoded prefix of the selected region, long enough for truncateHead to decide (maxBytes + 1 bytes). */
	prefix: string;
	/** Byte length of the whole selected region. */
	regionBytes: number;
	/** Lines in the selected region, as truncateHead counts them. */
	regionLines: number;
	/** Byte length of the first selected line. */
	firstLineBytes: number;
}

/**
 * Read only the part of a large text file the read tool returns. One pass over fixed-size chunks finds
 * the newline offsets that bound the selected region; only the first maxBytes + 1 bytes of the region
 * are decoded. A 77 MB log costs one 1 MB buffer instead of buffer + string + line array + joined copy.
 * ponytail: regionBytes is the raw byte count; it differs from Buffer.byteLength(decoded) only for
 * invalid UTF-8, where replacement characters would have inflated it.
 */
async function readTextWindow(
	path: string,
	startLine: number,
	limit: number | undefined,
): Promise<TextWindow | undefined> {
	const handle = await fsOpen(path, "r");
	try {
		const size = (await handle.stat()).size;
		if (size < WINDOW_READ_MIN_BYTES) return undefined;
		// Newline numbers (1-based) whose positions bound the region: it starts after newline `startLine`,
		// its first line ends at newline `startLine + 1`, and with a limit it ends at newline `startLine + limit`.
		const endNewline = limit === undefined ? Number.POSITIVE_INFINITY : startLine + limit;
		let start = startLine === 0 ? 0 : -1;
		let firstLineEnd = -1;
		let end = -1;
		let newlines = 0;
		let regionNewlines = 0;
		const buffer = Buffer.allocUnsafe(WINDOW_CHUNK_BYTES);
		for (let position = 0; position < size; ) {
			const { bytesRead } = await handle.read(buffer, 0, WINDOW_CHUNK_BYTES, position);
			if (bytesRead === 0) break;
			const chunk = bytesRead === WINDOW_CHUNK_BYTES ? buffer : buffer.subarray(0, bytesRead);
			for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
				newlines++;
				const at = position + i;
				if (start !== -1 && end === -1) regionNewlines++;
				if (newlines === startLine) start = at + 1;
				if (newlines === startLine + 1) firstLineEnd = at;
				if (newlines === endNewline) end = at;
			}
			position += bytesRead;
		}
		const totalFileLines = newlines + 1;
		if (start === -1) start = size;
		if (end === -1) end = size;
		else regionNewlines--; // the newline that ends the region is not part of it
		if (firstLineEnd === -1 || firstLineEnd > end) firstLineEnd = end;
		const regionBytes = Math.max(0, end - start);
		const prefixBytes = Math.min(regionBytes, DEFAULT_MAX_BYTES + 1);
		const prefixBuffer = Buffer.allocUnsafe(prefixBytes);
		if (prefixBytes > 0) await handle.read(prefixBuffer, 0, prefixBytes, start);
		let endsWithNewline = false;
		if (regionBytes > 0) {
			const last = Buffer.allocUnsafe(1);
			await handle.read(last, 0, 1, end - 1);
			endsWithNewline = last[0] === 10;
		}
		return {
			totalFileLines,
			prefix: prefixBuffer.toString("utf-8"),
			regionBytes,
			regionLines: regionBytes === 0 ? 0 : regionNewlines + 1 - (endsWithNewline ? 1 : 0),
			firstLineBytes: Math.max(0, firstLineEnd - start),
		};
	} finally {
		await handle.close();
	}
}

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Large local files: scan in chunks and decode only the returned window.
								const window =
									ops.readFile === defaultReadOperations.readFile && (limit === undefined || limit > 0)
										? await readTextWindow(absolutePath, startLine, limit)
										: undefined;
								let totalFileLines: number;
								let truncation: TruncationResult;
								let firstLineBytes: () => number;
								let userLimitedLines: number | undefined;
								if (window) {
									totalFileLines = window.totalFileLines;
									truncation = {
										...truncateHead(window.prefix),
										totalLines: window.regionLines,
										totalBytes: window.regionBytes,
									};
									firstLineBytes = () => window.firstLineBytes;
								} else {
									const allLines = (await ops.readFile(absolutePath)).toString("utf-8").split("\n");
									totalFileLines = allLines.length;
									// A user limit is honored first; otherwise truncateHead decides.
									const endLine =
										limit === undefined ? totalFileLines : Math.min(startLine + limit, totalFileLines);
									truncation = truncateHead(allLines.slice(startLine, endLine).join("\n"));
									firstLineBytes = () => Buffer.byteLength(allLines[startLine], "utf-8");
								}
								if (startLine >= totalFileLines) {
									throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
								}
								if (limit !== undefined)
									userLimitedLines = Math.min(startLine + limit, totalFileLines) - startLine;
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(firstLineBytes());
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = totalFileLines - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
