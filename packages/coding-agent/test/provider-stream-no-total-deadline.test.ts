import http from "node:http";
import type { AddressInfo } from "node:net";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { completeSimple, normalizeContext, streamSimple } from "@earendil-works/pi-ai/compat";
import * as undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

// Fleet incident 13-14/11/2026: replies aborted ("This operation was aborted") at the 300 s
// timeoutMs even though bytes kept arriving. timeoutMs is an IDLE budget (the http dispatcher enforces
// it between bytes); it must never cap the total length of a stream that keeps progressing.
// Loopback only. The timer is scaled down: IDLE_MS stands for 300 s, a stream spanning 2.5x of it for a long reply.
const IDLE_MS = 600;
const PING_EVERY_MS = 50;
const PINGS = 30; // 1.5 s of continuous bytes, 2.5x IDLE_MS

type Mode = "progress" | "silent";
let mode: Mode = "progress";
let seen: { headers: http.IncomingHttpHeaders; body: { model?: string } }[] = [];
const timers = new Set<NodeJS.Timeout>();
let server: http.Server;
let baseUrl = "";
const originalDispatcher = undici.getGlobalDispatcher();

const sse = (res: http.ServerResponse, event: { type: string; [key: string]: unknown }) =>
	res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

beforeAll(async () => {
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key];
	configureHttpDispatcher(IDLE_MS);
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, {
				type: "message_start",
				message: { id: "mock", model: "claude-mock", role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
			});
			if (mode === "silent") return;
			sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			let ticks = 0;
			const timer = setInterval(() => {
				if (++ticks < PINGS) return sse(res, { type: "ping" });
				clearInterval(timer);
				timers.delete(timer);
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mock-complete" } });
				sse(res, { type: "content_block_stop", index: 0 });
				sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
				sse(res, { type: "message_stop" });
				res.end();
			}, PING_EVERY_MS);
			timers.add(timer);
			res.on("close", () => {
				clearInterval(timer);
				timers.delete(timer);
			});
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
	mode = "progress";
	seen = [];
});

afterAll(async () => {
	for (const timer of timers) clearInterval(timer);
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	await undici.getGlobalDispatcher().close();
	undici.setGlobalDispatcher(originalDispatcher);
});

const model = () => ({
	id: "claude-mock",
	name: "Mock",
	api: "anthropic-messages" as const,
	provider: "claude-lane",
	baseUrl,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 16,
});
const context = () => normalizeContext({ messages: [{ role: "user", content: "offline mock", timestamp: 1 }] });
// The fleet gateway path arms the extra whole-request timer (#31) only with a pre-egress trust; run both.
const trusts = [
	["with gateway pre-egress trust", { origin: "http://unrelated.invalid", verify: () => true }],
	["without gateway pre-egress trust", undefined],
] as const;

describe.each(trusts)("provider stream deadline (%s)", (_label, trust) => {
	const base = () => ({
		apiKey: "test-key",
		timeoutMs: IDLE_MS,
		maxRetries: 0,
		headers: { "x-seat-id": "seat-1" },
		...(trust ? { gatewayPreEgressTrust: trust } : {}),
	});

	it("stream() survives a reply that keeps sending bytes past timeoutMs", async () => {
		const started = performance.now();
		const result = await anthropicStream(model(), context(), base()).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(performance.now() - started).toBeGreaterThan(IDLE_MS * 2);
	});

	it("streamSimple() survives it", async () => {
		const result = await streamSimple(model(), context(), base()).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
	});

	it("completeSimple() (compaction path) survives it", async () => {
		const result = await completeSimple(model(), context(), base());
		expect(result.stopReason, result.errorMessage).toBe("stop");
	});

	it("still aborts a stream that goes silent after the response starts", async () => {
		mode = "silent";
		const started = performance.now();
		const result = await anthropicStream(model(), context(), base()).result();
		const elapsed = performance.now() - started;
		expect(result.stopReason).toBe("error");
		// undici's idle timers are coarse (and the suite shares a loaded CPU): assert a real, bounded stop.
		expect(elapsed).toBeGreaterThanOrEqual(IDLE_MS * 0.8);
		expect(elapsed).toBeLessThan(20_000);
	});

	it("caller cancellation still stops a progressing stream", async () => {
		const caller = new AbortController();
		const cancel = setTimeout(() => caller.abort(), 150);
		try {
			const result = await anthropicStream(model(), context(), { ...base(), signal: caller.signal }).result();
			expect(result.stopReason).toBe("aborted");
		} finally {
			clearTimeout(cancel);
		}
	});

	it("sends the same auth, model and seat headers as before", async () => {
		await anthropicStream(model(), context(), base()).result();
		expect(seen).toHaveLength(1);
		expect(seen[0]!.headers["x-api-key"]).toBe("test-key");
		expect(seen[0]!.headers["x-seat-id"]).toBe("seat-1");
		expect(seen[0]!.body.model).toBe("claude-mock");
	});
});
