import { describe, expect, it, vi } from "vitest";
import { defineDoc } from "../src/documents.ts";
import { createSession, SessionImpl } from "../src/session/session.ts";
import { nodeLosslessCodec } from "../src/storage/lossless-codec-node.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import type { ConversationId, Session } from "../src/types.ts";
import { context } from "./session-support.ts";

const NoteDoc = defineDoc<{ text: string }>({
	kind: "test.w1note",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

async function createNote(session: Session, text: string): Promise<ConversationId> {
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	await session.commit(async (tx) => {
		(await tx.doc(NoteDoc, conversation.id)).text = text;
	}, context);
	return conversation.id;
}

describe("W1 compressed conversation state", () => {
	it("settles documents into compressed backing and materializes them value-equal", async () => {
		const codec = {
			compress: vi.fn(nodeLosslessCodec.compress),
			decompress: vi.fn(nodeLosslessCodec.decompress),
		};
		const session = createSession(new MemoryStorage(), codec);
		const ids: ConversationId[] = [];
		for (let i = 0; i < 140; i++) ids.push(await createNote(session, `note ${i} `.repeat(50)));
		// A later commit settles older documents past the working window.
		await createNote(session, "trigger");
		expect(codec.compress).toHaveBeenCalled();
		expect(await session.snapshot(NoteDoc, ids[0]!, context)).toEqual({ text: `note 0 `.repeat(50) });
		expect(codec.decompress).toHaveBeenCalled();
		expect(await session.snapshot(NoteDoc, ids[35]!, context)).toEqual({ text: `note 35 `.repeat(50) });
		expect(await session.snapshot(NoteDoc, ids[69]!, context)).toEqual({ text: `note 69 `.repeat(50) });
	});

	it("does not resurrect a retired document from settled backing", async () => {
		const session = new SessionImpl(new MemoryStorage(), nodeLosslessCodec);
		const rootId = await createNote(session, "original");
		for (let i = 0; i < 140; i++) await createNote(session, `filler ${i}`);
		await session.commit((tx) => tx.retireDoc(NoteDoc, rootId), context);
		expect(await session.snapshot(NoteDoc, rootId, context)).toBeUndefined();
		await session.commit(async (tx) => {
			(await tx.doc(NoteDoc, rootId)).text = "replacement";
		}, context);
		expect(await session.snapshot(NoteDoc, rootId, context)).toEqual({ text: "replacement" });
	});

	it("keeps watched documents live until the last observer detaches", async () => {
		const compressed: string[] = [];
		const codec = {
			compress: (text: string) => {
				compressed.push(text);
				return nodeLosslessCodec.compress(text);
			},
			decompress: nodeLosslessCodec.decompress,
		};
		const session = new SessionImpl(new MemoryStorage(), codec);
		const id = await createNote(session, "watched-marker");
		const first = (await session.watchDoc(NoteDoc, id, context))!;
		const second = (await session.watchDoc(NoteDoc, id, context))!;
		for (let i = 0; i < 140; i++) await createNote(session, `filler ${i}`);
		expect(compressed.some((text) => text.includes("watched-marker"))).toBe(false);
		await first.stop();
		await createNote(session, "still watched");
		expect(compressed.some((text) => text.includes("watched-marker"))).toBe(false);
		await second.stop();
		for (let i = 0; i < 3; i++) await createNote(session, `after detach ${i}`);
		expect(compressed.some((text) => text.includes("watched-marker"))).toBe(true);
		expect(await session.snapshot(NoteDoc, id, context)).toEqual({ text: "watched-marker" });
	});

	it("escapes no backing references on document promotion (identity probe)", async () => {
		const session = new SessionImpl(new MemoryStorage(), nodeLosslessCodec);
		const rootId = await createNote(session, "original");
		for (let i = 0; i < 70; i++) await createNote(session, `filler ${i}`);
		// The root's document has settled; materialize it and mutate the returned object.
		const value = await session.snapshot(NoteDoc, rootId, context);
		expect(value).toEqual({ text: "original" });
		(value as { text: string }).text = "HACKED";
		// Unload forces a fresh read of persisted state rather than the caller's object.
		await session.unloadDocuments();
		expect(await session.snapshot(NoteDoc, rootId, context)).toEqual({ text: "original" });
	});

	it("keeps everything plain without a codec (portable default)", async () => {
		const session = new SessionImpl(new MemoryStorage());
		const id = await createNote(session, "plain ".repeat(50));
		await createNote(session, "trigger");
		expect(await session.snapshot(NoteDoc, id, context)).toEqual({ text: "plain ".repeat(50) });
	});
});
