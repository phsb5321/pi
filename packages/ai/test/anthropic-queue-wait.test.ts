import { createServer } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

const model = { ...getModel("anthropic", "claude-haiku-4-5"), provider: "claude-lane" };
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const encoder = new TextEncoder();

function heldResponse() {
	let body!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn();
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				body = controller;
			},
			cancel,
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
	const create = vi.fn(() => ({ asResponse: async () => response }));
	const client = { beta: { messages: { create } } } as unknown as Anthropic;
	return {
		client,
		create,
		cancel,
		comment: () => body.enqueue(encoder.encode(": keepalive\n\n")),
		raw: (frame: string) => body.enqueue(encoder.encode(frame)),
		emit: (event: string, data: unknown) =>
			body.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => body.close(),
	};
}

function messageStart(held: ReturnType<typeof heldResponse>) {
	held.emit("message_start", {
		type: "message_start",
		message: { id: "msg_queue", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
	});
}

function finish(held: ReturnType<typeof heldResponse>, stopReason = "end_turn") {
	held.emit("message_delta", {
		type: "message_delta",
		delta: { stop_reason: stopReason },
		usage: { output_tokens: 5 },
	});
	held.emit("message_stop", { type: "message_stop" });
	held.close();
}

afterEach(() => vi.useRealTimers());

describe("native Anthropic gateway waits", () => {
	it("keeps one turn pending beyond the old gateway ceiling, then returns real text", async () => {
		vi.useFakeTimers();
		const held = heldResponse();
		let settled = false;
		const result = streamAnthropic(model, context, { client: held.client })
			.result()
			.then((message) => {
				settled = true;
				return message;
			});
		held.comment();
		await vi.advanceTimersByTimeAsync(1_800_000);
		held.comment();
		await vi.advanceTimersByTimeAsync(1_800_001);
		expect(settled).toBe(false);
		expect(held.create).toHaveBeenCalledTimes(1);
		messageStart(held);
		held.emit("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "Hello" },
		});
		held.emit("content_block_stop", { type: "content_block_stop", index: 0 });
		finish(held);
		expect(await result).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "Hello" }],
			usage: { input: 12, output: 5 },
		});
	});

	it("exposes pings to the existing observer without producing model content or usage", async () => {
		vi.useFakeTimers();
		const held = heldResponse();
		const observer = vi.fn();
		const stream = streamAnthropic(model, context, { client: held.client, onProviderStreamEvent: observer });
		const ping = {
			type: "ping",
			throttler_queue: {
				version: 1,
				source: "throttler-gateway",
				state: "waiting",
				reason: "weekly_pacing",
				elapsed_ms: 30_000,
				next_check_ms: 5_000,
			},
		};
		held.emit("ping", ping);
		await vi.advanceTimersByTimeAsync(0);
		try {
			expect(observer).toHaveBeenCalledExactlyOnceWith(ping, model);
		} finally {
			held.close();
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a stop reason");
		expect(result.content).toEqual([]);
		expect(result.usage.totalTokens).toBe(0);
		expect(held.create).toHaveBeenCalledTimes(1);
	});

	it.each(["cancel", "inherited deadline"])(
		"cleans up a silent hold on %s without starting generation",
		async (mode) => {
			vi.useFakeTimers();
			const held = heldResponse();
			const controller = new AbortController();
			let settled = false;
			const result = streamAnthropic(model, context, {
				client: held.client,
				signal: controller.signal,
				maxRetries: 4,
			})
				.result()
				.then((message) => {
					settled = true;
					return message;
				});
			held.comment();
			await vi.advanceTimersByTimeAsync(0);
			if (mode === "cancel") controller.abort();
			else setTimeout(() => controller.abort(new Error("Inherited deadline exceeded")), 10);
			await vi.advanceTimersByTimeAsync(10);
			try {
				expect(settled).toBe(true);
				expect(held.cancel).toHaveBeenCalledTimes(1);
			} finally {
				// Release the pre-fix reader too, so a failing control leaves no pending stream.
				if (!settled) held.close();
			}
			expect(await result).toMatchObject({ stopReason: "aborted", content: [], usage: { totalTokens: 0 } });
			expect(held.create).toHaveBeenCalledTimes(1);
		},
	);

	it("disconnects a real loopback SSE hold when cancelled through the native SDK", async () => {
		const ready = Promise.withResolvers<void>();
		const disconnected = Promise.withResolvers<void>();
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(": keepalive\n\n");
			response.on("close", () => disconnected.resolve());
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const controller = new AbortController();
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected loopback TCP server");
			const result = streamAnthropic({ ...model, baseUrl: `http://127.0.0.1:${address.port}` }, context, {
				apiKey: "synthetic-loopback-key",
				signal: controller.signal,
				onResponse: () => ready.resolve(),
			}).result();
			await ready.promise;
			controller.abort();
			expect(await result).toMatchObject({ stopReason: "aborted", content: [], usage: { totalTokens: 0 } });
			await disconnected.promise;
			expect(requests).toBe(1);
		} finally {
			controller.abort();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("preserves a real tool call after a hold without making a second request", async () => {
		const held = heldResponse();
		const result = streamAnthropic(model, context, { client: held.client }).result();
		held.comment();
		messageStart(held);
		held.emit("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_queue", name: "read", input: {} },
		});
		held.emit("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' },
		});
		held.emit("content_block_stop", { type: "content_block_stop", index: 0 });
		finish(held, "tool_use");
		expect(await result).toMatchObject({
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "tool_queue", name: "read", arguments: { path: "fixture.txt" } }],
		});
		expect(held.create).toHaveBeenCalledTimes(1);
	});

	it("ignores malformed and misleading ping payloads instead of normalizing them", async () => {
		const held = heldResponse();
		const observer = vi.fn();
		const result = streamAnthropic(model, context, { client: held.client, onProviderStreamEvent: observer }).result();
		held.raw("event: ping\ndata: not-json\n\n");
		held.raw("event: proxy.stats\ndata: not-json\n\n");
		held.emit("ping", "not a structured event");
		held.emit("ping", { type: "message_delta", delta: { stop_reason: "end_turn" } });
		messageStart(held);
		finish(held);
		expect(await result).toMatchObject({ stopReason: "stop", content: [], usage: { input: 12, output: 5 } });
		expect(observer.mock.calls.map(([event]) => event.type)).toEqual([
			"message_start",
			"message_delta",
			"message_stop",
		]);
	});

	it.each(["authentication_error", "rate_limit_error", "throttle_timeout", "unknown_error"])(
		"does not retry SSE %s by text matching",
		async (type) => {
			const held = heldResponse();
			const result = streamAnthropic(model, context, { client: held.client, maxRetries: 4 }).result();
			const error = { type: "error", error: { type, message: "queue wait exceeded; retry-after 1800" } };
			held.emit("error", error);
			held.close();
			expect(await result).toMatchObject({ stopReason: "error", errorMessage: JSON.stringify(error), content: [] });
			expect(held.create).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves partial output on a terminal SSE error without replaying it", async () => {
		const held = heldResponse();
		const result = streamAnthropic(model, context, { client: held.client, maxRetries: 4 }).result();
		messageStart(held);
		held.emit("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "Partial" },
		});
		held.emit("error", { type: "error", error: { type: "overloaded_error", message: "try later" } });
		held.close();
		expect(await result).toMatchObject({
			stopReason: "error",
			content: [{ type: "text", text: "Partial" }],
			usage: { input: 12 },
		});
		expect(held.create).toHaveBeenCalledTimes(1);
	});
});
