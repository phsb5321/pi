import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Context, contentText, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeConversation } from "../../../src/core/compaction/index.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

const PRIVATE = "SYNTHETIC-CONTEXT-ONLY-PRIVATE-2371";
const PUBLIC = "SYNTHETIC-RETAINED-PUBLIC-2371";

function filterPrivateMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => message.role !== "user" || !contentText(message.content).includes(PRIVATE));
}

describe("2371 extension context versus standalone summary boundary (source 0.84.3)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllGlobals();
	});

	it.each([false, true])("manual summary-hook protection=%s, with default fallback as control", async (protect) => {
		const network = vi.fn(() => {
			throw new Error("This synthetic check must not fetch");
		});
		vi.stubGlobal("fetch", network);
		let contextCalls = 0;
		let summaryHookCalls = 0;
		let ordinaryRequest: Context | undefined;
		let summaryRequest: Context | undefined;
		let summarySignal: AbortSignal | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 } },
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						contextCalls++;
						return { messages: filterPrivateMessages(event.messages) };
					});
					pi.on("session_before_compact", async (event, ctx) => {
						summaryHookCalls++;
						expect(event.reason).toBe("manual");
						expect(JSON.stringify(event.preparation.messagesToSummarize)).toContain(PRIVATE);
						if (!protect) return; // Explicitly decline: exercise the real default AgentSession path.
						if (!ctx.model) throw new Error("Synthetic model missing");
						const messages = filterPrivateMessages([
							...event.preparation.messagesToSummarize,
							...event.preparation.turnPrefixMessages,
						]);
						const response = await ctx.modelRegistry.complete(
							ctx.model,
							{
								messages: [
									{ role: "user", content: serializeConversation(convertToLlm(messages)), timestamp: 1 },
								],
							},
							{ signal: event.signal, maxTokens: 128, cacheRetention: "none" },
						);
						return {
							compaction: {
								summary: contentText(response.content),
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								usage: response.usage,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		expect(process.env.PI_OFFLINE).toBe("1");
		const publicId = harness.sessionManager.appendMessage({ role: "user", content: PUBLIC, timestamp: 1 });
		const privateId = harness.sessionManager.appendMessage({ role: "user", content: PRIVATE, timestamp: 2 });
		const originalInputs = structuredClone([
			harness.sessionManager.getEntry(publicId),
			harness.sessionManager.getEntry(privateId),
		]);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			(context) => {
				ordinaryRequest = { systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) };
				return fauxAssistantMessage("ordinary reply");
			},
			(context, options) => {
				summaryRequest = { systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) };
				summarySignal = options?.signal;
				return fauxAssistantMessage("synthetic summary");
			},
		]);

		await harness.session.prompt("ordinary prompt");
		expect(ordinaryRequest).toBeDefined();
		expect(JSON.stringify(ordinaryRequest)).toContain(PUBLIC);
		expect(JSON.stringify(ordinaryRequest)).not.toContain(PRIVATE);
		expect(contextCalls).toBe(1);
		expect([harness.sessionManager.getEntry(publicId), harness.sessionManager.getEntry(privateId)]).toEqual(
			originalInputs,
		);

		// A final user entry prevents a split turn: exactly one summary request is expected.
		const tailId = harness.sessionManager.appendMessage({ role: "user", content: "kept tail", timestamp: 3 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const originalEntries = structuredClone(harness.sessionManager.getEntries());
		const result = await harness.session.compact();

		expect(summaryHookCalls).toBe(1);
		expect(contextCalls).toBe(1); // Standalone summaries do not invoke the ordinary context event.
		expect(summaryRequest).toBeDefined();
		expect(JSON.stringify(summaryRequest)).toContain(PUBLIC);
		if (protect) {
			expect(JSON.stringify(summaryRequest)).not.toContain(PRIVATE);
		} else {
			// Falsifies "ordinary context filtering also protects default summaries".
			expect(JSON.stringify(summaryRequest)).toContain(PRIVATE);
		}
		expect(summarySignal).toBeInstanceOf(AbortSignal);
		expect(summarySignal?.aborted).toBe(false);
		expect(result.summary).toBe("synthetic summary");
		expect(result.firstKeptEntryId).toBe(tailId);
		const finalEntries = harness.sessionManager.getEntries();
		expect(finalEntries).toHaveLength(originalEntries.length + 1);
		expect(finalEntries.slice(0, originalEntries.length)).toEqual(originalEntries);
		expect(finalEntries.at(-1)).toMatchObject({
			type: "compaction",
			parentId: tailId,
			firstKeptEntryId: tailId,
			fromHook: protect,
		});
		expect(harness.sessionManager.getLeafId()).toBe(finalEntries.at(-1)?.id);
		expect(harness.sessionManager.buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: "kept tail",
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(network).not.toHaveBeenCalled();
	});

	it("abortCompaction cancels a summary hook without persisting or changing the active branch", async () => {
		let enteredHook: () => void = () => {};
		const hookStarted = new Promise<void>((resolve) => {
			enteredHook = resolve;
		});
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						signal = event.signal;
						return new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							enteredHook();
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: PRIVATE, timestamp: 1 });
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "kept tail", timestamp: 2 });
		const originals = structuredClone(harness.sessionManager.getEntries());
		const cancelled = expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		await hookStarted;
		harness.session.abortCompaction();
		await cancelled;
		expect(signal?.aborted).toBe(true);
		expect(harness.sessionManager.getEntries()).toEqual(originals);
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
			result: undefined,
		});
		expect(harness.faux.state.callCount).toBe(0);
	});
});
