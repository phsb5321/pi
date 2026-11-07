import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getModel, normalizeContext } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent } from "../../src/core/extensions/types.ts";
import gatewayQueueExtension from "../../src/extensions/gateway-queue/index.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const ping = {
	type: "ping",
	throttler_queue: {
		version: 1,
		source: "throttler-gateway",
		state: "waiting",
		reason: "weekly_pacing",
		elapsed_ms: 10_000,
		next_check_ms: 15_000,
	},
};
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(
	origin = "http://127.0.0.1:8765",
	provider = "claude-lane",
	mode: "tui" | "rpc" | "print" = "tui",
) {
	const harness = await createHarness({ provider, extensionFactories: [gatewayQueueExtension] });
	harnesses.push(harness);
	harness.session.agent.state.model = { ...harness.getModel(), baseUrl: origin };
	const setStatus = vi.fn();
	await harness.session.bindExtensions({ mode, uiContext: createTestUiContext({ setStatus }) });
	const runner = harness.session.extensionRunner;
	return {
		harness,
		runner,
		setStatus,
		request: async (status = 200, marker: string | undefined = "1") => {
			await runner.emitBeforeProviderRequest({});
			await runner.emit({
				type: "after_provider_response",
				status,
				headers: marker === undefined ? {} : { "x-anthropic-throttle-proxy": marker },
			});
		},
		emit: (data: unknown, identity: Partial<Pick<ProviderStreamEvent, "provider" | "api" | "model">> = {}) =>
			runner.emit({
				type: "provider_stream_event",
				provider,
				api: "anthropic-messages",
				model: harness.getModel().id,
				data,
				...identity,
			}),
	};
}

describe("built-in gateway queue status", () => {
	it.each(["tui", "rpc"] as const)(
		"bridges actual native pre-egress wait and cancellation to %s status",
		async (mode) => {
			vi.useFakeTimers();
			const { harness, runner, setStatus } = await setup(undefined, undefined, mode);
			const model = {
				...getModel("anthropic", "claude-haiku-4-5"),
				provider: "claude-lane",
				baseUrl: "http://127.0.0.1:8765",
			};
			harness.session.agent.state.model = model;
			const controller = new AbortController();
			const fetch = vi.fn(async () => {
				const response = new Response("local policy: admission is quiesced; not accepting new work\n", {
					status: 503,
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"x-anthropic-throttle-proxy": "1",
						"x-throttle-admission-closed": "1",
						"retry-after": "5",
					},
				});
				Object.defineProperty(response, "url", { value: `${model.baseUrl}/v1/messages?beta=true` });
				return response;
			});
			const messages = [...harness.session.messages];
			try {
				const result = streamAnthropic(
					model,
					normalizeContext({ messages: [{ role: "user", content: "Synthetic", timestamp: 1 }] }),
					{
						apiKey: "synthetic",
						fetch,
						signal: controller.signal,
						maxRetries: 0,
						gatewayPreEgressTrust: { origin: model.baseUrl, verify: () => true }, // Isolated fixture only.
						onResponse: (response) => runner.emit({ type: "after_provider_response", ...response }),
					},
				).result();
				await vi.advanceTimersByTimeAsync(6_300);
				expect(setStatus).toHaveBeenLastCalledWith(
					"gateway-queue",
					"Waiting: maintenance (pre-egress) | waited 5s | next check in 5s",
				);
				controller.abort();
				expect((await result).stopReason).toBe("aborted");
				expect(setStatus).toHaveBeenLastCalledWith("gateway-queue", undefined);
				expect(fetch).toHaveBeenCalledTimes(2);
				expect(harness.session.messages).toEqual(messages);
				expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
			} finally {
				controller.abort();
				vi.useRealTimers();
			}
		},
	);
	it("is enabled as a normal built-in CLI extension", () => {
		expect(builtInExtensions).toContainEqual({
			name: "gateway-queue",
			factory: gatewayQueueExtension,
			builtin: true,
		});
	});

	it.each(["tui", "rpc"] as const)("shows advisory queue status in %s without starting another turn", async (mode) => {
		const { harness, setStatus, request, emit } = await setup(undefined, undefined, mode);
		const messages = [...harness.session.messages];
		await request();
		await emit(ping);
		expect(setStatus).toHaveBeenLastCalledWith(
			"gateway-queue",
			"Queued: weekly pacing | waited 10s | next check in 15s",
		);
		expect(harness.session.messages).toEqual(messages);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("agent_start")).toEqual([]);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it.each(["queue", "weekly_pacing", "retry_after"])(
		"renders only the fixed %s label and coalesces duplicate pings",
		async (reason) => {
			const { setStatus, request, emit } = await setup();
			await request();
			await emit({ ...ping, throttler_queue: { ...ping.throttler_queue, reason } });
			await emit({ ...ping, throttler_queue: { ...ping.throttler_queue, reason } });
			expect(setStatus).toHaveBeenCalledTimes(1);
			expect(setStatus.mock.calls[0][1]).toContain(reason.replaceAll("_", " "));
			expect(setStatus.mock.calls[0][1]).not.toContain("ETA");
		},
	);

	it.each([
		["remote origin", "https://example.org:8765", "claude-lane"],
		["wrong port", "http://127.0.0.1:8766", "claude-lane"],
		["wrong scheme", "https://127.0.0.1:8765", "claude-lane"],
		["credentials in origin", "http://user:password@127.0.0.1:8765", "claude-lane"],
		["different provider", "http://127.0.0.1:8765", "untrusted"],
	])("ignores %s", async (_name, origin, provider) => {
		const { setStatus, request, emit } = await setup(origin, provider);
		await request();
		await emit(ping);
		expect(setStatus).not.toHaveBeenCalled();
	});

	it.each([
		[503, "1"],
		[200, "0"],
		[200, ""],
		[200, undefined],
	] as const)("rejects HTTP %s with marker %s", async (status, marker) => {
		const { setStatus, runner, emit } = await setup();
		await runner.emit({
			type: "after_provider_response",
			status,
			headers: marker === undefined ? {} : { "x-anthropic-throttle-proxy": marker },
		});
		await emit(ping);
		expect(setStatus).not.toHaveBeenCalled();
	});

	it.each([
		null,
		[],
		{},
		{ type: "ping" },
		{ ...ping, type: "message_delta" },
		...[
			{ version: 2 },
			{ source: "other" },
			{ state: "done" },
			{ reason: "\u001b[2J" },
			{ elapsed_ms: -1 },
			{ elapsed_ms: "10000" },
			{ elapsed_ms: Number.NaN },
			{ elapsed_ms: Number.POSITIVE_INFINITY },
			{ next_check_ms: -1 },
			{ next_check_ms: "15000" },
			{ next_check_ms: Number.MAX_VALUE },
			{ next_check_ms: null },
		].map((change) => ({ ...ping, throttler_queue: { ...ping.throttler_queue, ...change } })),
	])("ignores malformed or unsupported metadata %#", async (data) => {
		const { setStatus, request, emit } = await setup();
		await request();
		await emit(data);
		expect(setStatus).not.toHaveBeenCalled();
	});

	it.each([{ provider: "other" }, { api: "openai-completions" }, { model: "other" }] as const)(
		"rejects a different stream identity %#",
		async (identity) => {
			const { setStatus, request, emit } = await setup();
			await request();
			await emit(ping, identity);
			expect(setStatus).not.toHaveBeenCalled();
		},
	);

	it.each(["message_start", "content_block_start", "message_stop", "error"])(
		"clears on native %s and ignores late queue pings",
		async (type) => {
			const { setStatus, request, emit } = await setup();
			await request();
			await emit(ping);
			await emit({ type });
			expect(setStatus).toHaveBeenLastCalledWith("gateway-queue", undefined);
			await emit(ping);
			expect(setStatus).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["turn_start", "agent_settled", "session_shutdown"] as const)(
		"clears on %s, including cancelled work",
		async (type) => {
			const { setStatus, runner, request, emit } = await setup();
			await request();
			await emit(ping);
			if (type === "turn_start") await runner.emit({ type, turnIndex: 1, timestamp: 1 });
			else if (type === "session_shutdown") await runner.emit({ type, reason: "quit" });
			else await runner.emit({ type, aborted: true });
			expect(setStatus).toHaveBeenLastCalledWith("gateway-queue", undefined);
			await emit(ping);
			expect(setStatus).toHaveBeenCalledTimes(2);
		},
	);

	it("resets provenance on the next request rather than trusting the previous response", async () => {
		const { setStatus, runner, request, emit } = await setup();
		await request();
		await emit(ping);
		await runner.emitBeforeProviderRequest({});
		await emit(ping);
		expect(setStatus).toHaveBeenLastCalledWith("gateway-queue", undefined);
		expect(setStatus).toHaveBeenCalledTimes(2);
	});

	it("does not render terminal UI in print mode", async () => {
		const { setStatus, request, emit } = await setup(undefined, undefined, "print");
		await request();
		await emit(ping);
		expect(setStatus).not.toHaveBeenCalled();
	});
});
