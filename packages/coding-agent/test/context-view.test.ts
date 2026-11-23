/**
 * Copy-on-write `context` view: handlers see the same result as the old
 * structuredClone path, a handler write never reaches the session state, and
 * one call's mutation does not leak into the next call.
 */
import { describe, expect, it } from "vitest";
import { createContextView } from "../src/core/extensions/context-view.ts";

type Msg = { role: string; timestamp?: number; content: Array<{ type: string; text?: string }> };

const history = (): Msg[] => [
	{ role: "user", timestamp: 1, content: [{ type: "text", text: "hi" }] },
	{
		role: "assistant",
		timestamp: 2,
		content: [
			{ type: "thinking", text: "hmm" },
			{ type: "text", text: "hello" },
		],
	},
	{ role: "toolResult", timestamp: 3, content: [{ type: "text", text: "x".repeat(50) }] },
	{ role: "user", timestamp: 4, content: [{ type: "text", text: "next" }] },
];

type Handler = (messages: Msg[]) => Msg[] | undefined;

/** The pre-change path: one structuredClone, then each handler edits that clone in place or returns a new list. */
const reference = (input: Msg[], handlers: Handler[]): Msg[] => {
	let current = structuredClone(input);
	for (const h of handlers) {
		const r = h(current);
		if (r) current = r;
	}
	return current;
};

/** The new path, same sequencing as ExtensionRunner.emitContext. */
const viaView = (input: Msg[], handlers: Handler[]): Msg[] => {
	let current: Msg[] = input;
	for (const h of handlers) {
		const view = createContextView(current);
		const r = h(view.messages as Msg[]);
		current = view.materialize(r ?? view.messages) as Msg[];
	}
	return current === input ? input.slice() : current;
};

const trimThinking: Handler = (messages) =>
	messages.map((m, i) =>
		i < 3 && m.role === "assistant" ? { ...m, content: m.content.filter((b) => b.type !== "thinking") } : m,
	);

const truncateTools: Handler = (messages) =>
	messages.map((m) => {
		if (m.role !== "toolResult") return m;
		return { ...m, content: m.content.map((b) => ({ ...b, text: (b.text ?? "").slice(0, 10) })) };
	});

const inPlaceEdit: Handler = (messages) => {
	messages[0].content[0].text = "edited in place";
	messages.push({ role: "user", content: [{ type: "text", text: "added" }] });
	return undefined;
};

const dropFirst: Handler = (messages) => messages.slice(1);

describe("createContextView", () => {
	it("gives the same result as the structuredClone path for each handler shape", () => {
		const cases: Handler[][] = [
			[],
			[trimThinking],
			[truncateTools],
			[inPlaceEdit],
			[dropFirst],
			[trimThinking, truncateTools, dropFirst],
			[inPlaceEdit, trimThinking, inPlaceEdit],
		];
		for (const handlers of cases) {
			expect(viaView(history(), handlers)).toEqual(reference(history(), handlers));
		}
	});

	it("never writes to the input (session state) even when a handler mutates in place", () => {
		const input = history();
		const before = structuredClone(input);
		viaView(input, [inPlaceEdit, truncateTools]);
		expect(input).toEqual(before);
	});

	it("shares untouched messages and copies only the path a handler wrote", () => {
		const input = history();
		const out = viaView(input, [trimThinking]);
		// Message 0 and 3 were not written: same objects as the session state.
		expect(out[0]).toBe(input[0]);
		expect(out[3]).toBe(input[3]);
		// Message 1 was rebuilt by the handler: a new object, input untouched.
		expect(out[1]).not.toBe(input[1]);
		expect(input[1].content.some((b) => b.type === "thinking")).toBe(true);
	});

	it("does not leak a handler's in-place mutation into the next call", () => {
		const input = history();
		const first = viaView(input, [inPlaceEdit]);
		expect(first[0].content[0].text).toBe("edited in place");
		expect(first.length).toBe(5);

		const second = viaView(input, [dropFirst]);
		expect(second).toEqual(reference(history(), [dropFirst]));
		expect(second).toEqual(history().slice(1));
	});

	it("leaves non-plain values (Date, Uint8Array) unwrapped and shared", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const input = [{ role: "user", content: [{ type: "image", data: bytes }] }] as unknown as Msg[];
		const out = viaView(input, [(m) => m]);
		expect((out[0].content[0] as unknown as { data: Uint8Array }).data).toBe(bytes);
	});
});
