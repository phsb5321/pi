import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

/**
 * Pins the extension-API contracts that a "re-route the task when the model refuses" extension
 * depends on (see ~/.pi/agent/extensions/enforce-model-authority.ts):
 *
 *  1. an async `message_end` handler may replace a finalized assistant message; the replacement
 *     is the object agent state, listeners and session persistence all see, and replacing only
 *     `content` keeps role and usage accounting intact. A replacement with a different role is
 *     rejected with an extension error.
 *  2. `pi.setModel()` called from inside `message_end` is applied immediately: the very next
 *     provider request uses the new model, it is not queued behind the current turn.
 *  3. `turn_end` returning `{ continue: true }` yields exactly one additional provider request
 *     -- but only when the boundary leaves runnable context (a queued message or a boundary
 *     entry). A bare `{ continue: true }` after an assistant message with nothing pending is
 *     refused with an extension error and produces no request, so an extension that suppresses
 *     a refusal must also queue the continuation it wants.
 *
 * Each case below fails if its contract regresses.
 */
describe("extension contracts: message_end replace, setModel timing, turn_end continue", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const twoModels = [
		{ id: "faux-1", name: "One" },
		{ id: "faux-2", name: "Two" },
	];

	it("1: an async message_end replacement is honoured and stays the single accounting record", async () => {
		const original = fauxAssistantMessage("original");
		const seen: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "assistant") return;
						await new Promise((resolve) => setTimeout(resolve, 5));
						return { message: { ...event.message, content: [{ type: "text", text: "replaced" }] } };
					});
					pi.on("turn_end", (event) => {
						seen.push(getMessageText(event.message));
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([original]);

		await harness.session.prompt("hi");

		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		const assistant = assistants[0];
		if (assistant?.role !== "assistant") throw new Error("expected assistant message");

		// the replacement (not the original) is the live message
		expect(getMessageText(assistant)).toBe("replaced");
		expect(getAssistantTexts(harness)).toEqual(["replaced"]);

		// role and usage accounting survive a content-only replacement
		expect(assistant.stopReason).toBe(original.stopReason);
		expect(assistant.api.startsWith("faux")).toBe(true);
		expect(assistant.provider).toBe(original.provider);
		expect(assistant.model).toBe(original.model);
		expect(assistant.usage.input).toBeGreaterThanOrEqual(0);
		expect(assistant.usage.output).toBeGreaterThanOrEqual(0);
		expect(assistant.usage.totalTokens).toBeGreaterThan(0);

		// public listeners see the replacement
		const listener = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		expect(getMessageText(listener?.message)).toBe("replaced");
		expect(seen).toEqual(["replaced"]);

		// persistence stores the same object, exactly once: no duplicate or divergent transcript entry
		const persisted = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(persisted).toHaveLength(1);
		const persistedEntry = persisted[0];
		if (persistedEntry?.type !== "message") throw new Error("expected message entry");
		expect(persistedEntry.message).toBe(assistant);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("1b: a replacement with a different role is rejected and the original is kept", async () => {
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "assistant") return;
						return { message: { role: "user", content: "x", timestamp: 1 } } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		harness.setResponses([fauxAssistantMessage("original")]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toEqual(["original"]);
		expect(errors.join("\n")).toContain("same role");
	});

	it("2: setModel inside message_end applies to the very next provider request", async () => {
		const servedBy: string[] = [];
		const requests: string[] = [];
		let routed = false;
		const harness = await createHarness({
			models: twoModels,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event, ctx) => {
						if (event.message.role !== "assistant" || routed) return;
						routed = true;
						const next = ctx.modelRegistry.find("faux", "faux-2");
						if (!next) throw new Error("faux-2 missing");
						await pi.setModel(next);
						// the continuation a refusal-suppressing extension needs, see contract 3
						pi.sendUserMessage("continue the task", { deliverAs: "followUp" });
						return { message: { ...event.message, content: [{ type: "text", text: "[suppressed]" }] } };
					});
					pi.on("turn_end", () => (routed ? { continue: true } : undefined));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(_context, _options, _state, model) => {
				servedBy.push(model.id);
				return fauxAssistantMessage("refusal");
			},
			(context, _options, _state, model) => {
				servedBy.push(model.id);
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("resumed");
			},
		]);

		await harness.session.prompt("hi");

		expect(servedBy).toEqual(["faux-1", "faux-2"]);
		expect(harness.session.model?.id).toBe("faux-2");
		// the new lane inherits the suppressed reply and the queued continuation, not the refusal
		expect(requests[0]).toContain("[suppressed]");
		expect(requests[0]).not.toContain("refusal");
		expect(requests[0]).toContain("continue the task");
	});

	it("3a: a bare turn_end {continue:true} is refused and makes no request", async () => {
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => ({ continue: true }));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);

		await harness.session.prompt("hi");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(errors.join("\n")).toContain("requested continuation without runnable model context");
	});

	it("3b: turn_end {continue:true} with a queued continuation makes exactly one extra request", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (event.turnIndex > 0) return;
						pi.sendUserMessage("resume", { deliverAs: "followUp" });
						return { continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);

		await harness.session.prompt("hi");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).toEqual(["a", "b"]);
	});

	it("3d: mirroring enforce-model-authority: replace + setModel + continue with nothing queued parks the turn", async () => {
		const errors: string[] = [];
		let suppression: boolean | undefined;
		const harness = await createHarness({
			models: twoModels,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event, ctx) => {
						if (event.message.role !== "assistant") return;
						const next = ctx.modelRegistry.find("faux", "faux-2");
						if (next) await pi.setModel(next);
						suppression = true;
						return { message: { ...event.message, content: [{ type: "text", text: "[suppressed]" }] } };
					});
					pi.on("turn_end", () => {
						if (!suppression) return;
						suppression = undefined;
						return { continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		harness.setResponses([fauxAssistantMessage("I won't do that"), fauxAssistantMessage("resumed")]);

		await harness.session.prompt("hi");

		// the lane switch itself lands, and the refusal never reaches the transcript...
		expect(harness.session.model?.id).toBe("faux-2");
		expect(getAssistantTexts(harness)).toEqual(["[suppressed]"]);
		// ...but the continuation is refused, so the task parks until something queues a message
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(errors.join("\n")).toContain("requested continuation without runnable model context");
	});

	it("3c: pi adds no request of its own; the handler bound is the only limit", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (event.turnIndex >= 3) return;
						pi.sendUserMessage(`resume ${event.turnIndex}`, { deliverAs: "followUp" });
						return { continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`r${index}`)));

		await harness.session.prompt("hi");

		// one request per continue: 1 initial + 3 bounded continuations, then the handler stops
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.getPendingResponseCount()).toBe(4);
	});
});
