import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextEvent, ContextWithSystemEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("context dispatch fast path", () => {
	it.each([false, true])(
		"does not copy history without context handlers (unrelated extension: %s)",
		async (unrelated) => {
			const harness = await createHarness({
				extensionFactories: unrelated
					? [
							(pi) => {
								pi.on("agent_start", () => {});
							},
						]
					: [],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const messages: AgentMessage[] = [{ role: "user", content: "original", timestamp: 0 }];
			const clone = vi.spyOn(globalThis, "structuredClone");

			expect(await harness.session.extensionRunner.emitContext(messages)).toBe(messages);
			expect(clone).not.toHaveBeenCalled();
		},
	);

	it.each(["context", "context_with_system"] as const)(
		"isolates nested mutations by %s handlers",
		async (eventType) => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						const handler = (event: ContextEvent | ContextWithSystemEvent) => {
							const message = event.messages[0];
							if (
								message.role === "user" &&
								Array.isArray(message.content) &&
								message.content[0]?.type === "text"
							) {
								message.content[0].text = "request-local";
							}
						};
						if (eventType === "context") pi.on("context", handler);
						else pi.on("context_with_system", handler);
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const messages: AgentMessage[] = [
				{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 0 },
			];
			const result = await harness.session.extensionRunner.emitContext(messages);

			expect(result).not.toBe(messages);
			expect(result[0]).not.toBe(messages[0]);
			expect(result[0]).toMatchObject({ content: [{ type: "text", text: "request-local" }] });
			expect(messages[0]).toMatchObject({ content: [{ type: "text", text: "original" }] });
		},
	);
});
