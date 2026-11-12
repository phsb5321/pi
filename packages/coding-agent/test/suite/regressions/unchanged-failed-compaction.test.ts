import type { AgentContext } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type CompactionInternals = {
	_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
	_emitAgentSettled: () => Promise<void>;
	_compactBeforeNextAssistantResponse: (context: AgentContext) => Promise<AgentContext>;
	_getSummarizationRequestAuth: (
		model: ReturnType<Harness["getModel"]>,
		signal?: AbortSignal,
	) => Promise<{
		model: ReturnType<Harness["getModel"]>;
		thinkingLevel: Harness["session"]["thinkingLevel"];
	}>;
};

describe("failed compaction input admission", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup(failure: "error" | "aborted" = "error") {
		let attempts = 0;
		let fail = true;
		let cancelNext = false;
		let summaryCalls = 0;
		let settledRetry: (() => Promise<boolean>) | undefined;
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						attempts++;
						if (cancelNext) {
							cancelNext = false;
							return { cancel: true };
						}
					});
					pi.on("agent_settled", async () => {
						await settledRetry?.();
					});
				},
			],
		});
		harnesses.push(harness);
		const appendTurn = (text: string) => {
			harness.sessionManager.appendMessage({ role: "user", content: text.repeat(100), timestamp: 1 });
			const model = harness.getModel();
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage(text.repeat(100)),
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		};
		appendTurn("first");
		appendTurn("second");
		const internals = harness.session as unknown as CompactionInternals;
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockResolvedValue(undefined);
		const auth = vi.spyOn(internals, "_getSummarizationRequestAuth");
		harness.session.agent.streamFunction = (model) => {
			summaryCalls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (fail && failure === "aborted") harness.session.abortCompaction();
				const message = {
					...fauxAssistantMessage(fail ? "" : "successful summary", {
						stopReason: fail ? failure : "stop",
						errorMessage: fail ? "This operation was aborted" : undefined,
					}),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				if (fail) stream.push({ type: "error", reason: failure, error: message });
				else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		settledRetry = () => internals._runAutoCompaction("threshold", false);
		return {
			harness,
			internals,
			appendTurn,
			attempts: () => attempts,
			summaryCalls: () => summaryCalls,
			auth,
			recover: () => {
				fail = false;
			},
			cancelOnce: () => {
				cancelNext = true;
			},
		};
	}

	it.each(["error", "aborted"] as const)(
		"does not resummarize unchanged %s input when the native settled hook runs",
		async (failure) => {
			const state = await setup(failure);
			const entries = state.harness.sessionManager.getEntries();
			const model = state.harness.session.model;
			const thinking = state.harness.session.thinkingLevel;
			await state.internals._runAutoCompaction("threshold", false);
			await state.internals._emitAgentSettled();
			state.harness.sessionManager.appendCustomEntry("metadata-only", {});
			await state.internals._emitAgentSettled();
			expect(state.attempts()).toBe(1);
			expect(state.harness.sessionManager.getEntries().slice(0, -1)).toEqual(entries);
			expect(state.harness.session.model).toBe(model);
			expect(state.harness.session.thinkingLevel).toBe(thinking);
			expect(state.harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it("allows explicit manual retry and retains healthy compaction after new context", async () => {
		const state = await setup();
		await state.internals._runAutoCompaction("threshold", false);
		state.recover();
		await expect(state.harness.session.compact()).resolves.toMatchObject({
			summary: expect.stringContaining("successful summary"),
		});
		expect(state.attempts()).toBe(2);
		state.appendTurn("third");
		await state.internals._runAutoCompaction("threshold", false);
		expect(state.attempts()).toBe(3);
	});

	it("fences native automatic retries after a failed extension/manual compact", async () => {
		const state = await setup();
		await expect(state.harness.session.compact()).rejects.toThrow("This operation was aborted");
		await state.internals._emitAgentSettled();
		expect(state.attempts()).toBe(1);
		state.recover();
		state.appendTurn("new input");
		await state.internals._runAutoCompaction("threshold", false);
		expect(state.attempts()).toBe(2);
	});

	it("does not mistake a failed custom-instruction attempt for default automatic input", async () => {
		const state = await setup();
		await expect(state.harness.session.compact("custom summary instructions")).rejects.toThrow();
		state.recover();
		await state.internals._runAutoCompaction("threshold", false);
		expect(state.attempts()).toBe(2);
	});

	it.each(["extension cancellation", "authentication"] as const)(
		"allows unchanged input after %s recovers before dispatch",
		async (source) => {
			const state = await setup();
			state.recover();
			if (source === "extension cancellation") state.cancelOnce();
			else state.auth.mockRejectedValueOnce(new Error("Authentication unavailable"));
			await state.internals._runAutoCompaction("threshold", false);
			expect(state.summaryCalls()).toBe(0);
			await state.internals._runAutoCompaction("threshold", false);
			expect(state.attempts()).toBe(2);
			expect(state.summaryCalls()).toBeGreaterThan(0);
		},
	);

	it("surfaces failed compaction before another over-threshold assistant request", async () => {
		const state = await setup();
		state.harness.settingsManager.applyOverrides({
			compaction: { reserveTokens: state.harness.getModel().contextWindow },
		});
		const context: AgentContext = {
			tools: [],
			messages: state.harness.session.agent.state.messages,
		};
		await expect(state.internals._compactBeforeNextAssistantResponse(context)).rejects.toThrow("Use /compact");
		await expect(state.internals._compactBeforeNextAssistantResponse(context)).rejects.toThrow("Use /compact");
		expect(state.summaryCalls()).toBe(1);
		expect(state.harness.faux.state.callCount).toBe(0);
	});
});
