import { afterEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

const model = {
	...getModel("anthropic", "claude-haiku-4-5"),
	provider: "claude-lane",
	baseUrl: "http://127.0.0.1:8765",
};
const context = normalizeContext({ messages: [{ role: "user", content: "Synthetic only", timestamp: 1 }] });
// This issuer trusts ONLY the synthetic fixture, not any deployed gateway or ordinary marker.
const fixtureTrust = { origin: model.baseUrl, verify: () => true };
const body = "local policy: admission is quiesced; not accepting new work\n";
const headers = {
	"content-type": "text/plain; charset=utf-8",
	"content-length": String(body.length),
	"x-anthropic-throttle-proxy": "1",
	"x-throttle-admission-closed": "1",
	"retry-after": "5",
};
function refusal(change: Record<string, string> = {}, status = 503, text = body) {
	const response = new Response(text, { status, headers: { ...headers, ...change } });
	Object.defineProperty(response, "url", { value: `${model.baseUrl}/v1/messages?beta=true`, configurable: true });
	return response;
}
function success() {
	// Synthetic wire fixture, delivered only after the maintenance refusals reopen.
	return new Response(
		`event: message_start
data: {"type":"message_start","message":{"id":"synthetic","model":"${model.id}","usage":{"input_tokens":1,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Reopened"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}

event: message_stop
data: {"type":"message_stop"}

`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}
afterEach(() => vi.useRealTimers());
describe("native pre-egress patient wait", () => {
	it.each(["absent", "old producer", "unknown central", "unpatched central", "wrong origin", "verifier error"])(
		"fails closed with %s capability even when every wire stamp matches",
		async (state) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const fetch = vi.fn(async () => refusal());
			const observer = vi.fn();
			let settled = false;
			const gatewayPreEgressTrust =
				state === "absent"
					? undefined
					: {
							origin: state === "wrong origin" ? "http://127.0.0.1:8766" : model.baseUrl,
							verify: () => {
								if (state === "verifier error") throw new Error("Cannot verify chain");
								return state === "wrong origin";
							},
						};
			const result = stream(model, context, {
				apiKey: "synthetic",
				fetch,
				signal: controller.signal,
				maxRetries: 0,
				onResponse: observer,
				gatewayPreEgressTrust,
			})
				.result()
				.then((value) => {
					settled = true;
					return value;
				});
			await vi.advanceTimersByTimeAsync(100);
			const settledWithoutCancellation = settled;
			controller.abort();
			await result;
			expect(settledWithoutCancellation).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(observer).not.toHaveBeenCalled();
		},
	);
	it("does not resend when verified chain capability is revoked during patient sleep", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async () => refusal());
		const verify = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
		const observer = vi.fn();
		const result = stream(model, context, {
			apiKey: "synthetic",
			fetch,
			maxRetries: 3,
			onResponse: observer,
			gatewayPreEgressTrust: { origin: model.baseUrl, verify },
		}).result();
		await vi.advanceTimersByTimeAsync(5_001);
		expect(await result).toMatchObject({
			stopReason: "error",
			errorMessage: "Local gateway pre-egress trust revoked",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ preEgressWait: { state: "ended" } });
	});
	it("keeps capability verification cancellable through the simple-options boundary", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetch = vi.fn(async () => refusal());
		const verify = vi.fn(() => new Promise<boolean>(() => {}));
		const result = streamSimple(model, context, {
			apiKey: "synthetic",
			fetch,
			signal: controller.signal,
			gatewayPreEgressTrust: { origin: model.baseUrl, verify },
		}).result();
		await vi.advanceTimersByTimeAsync(100);
		expect(verify).toHaveBeenCalledOnce();
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("preserves the finite provider retry budget when no trust issuer exists", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async () => refusal());
		const observer = vi.fn();
		const result = stream(model, context, {
			apiKey: "synthetic",
			fetch,
			maxRetries: 1,
			onResponse: observer,
		}).result();
		await vi.advanceTimersByTimeAsync(5_001);
		expect((await result).stopReason).toBe("error");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(observer).not.toHaveBeenCalled();
	});
	it("stays in one native call beyond retry budget then produces one real result", async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(refusal()))
			.mockImplementationOnce(() => Promise.resolve(refusal()))
			.mockImplementationOnce(() => Promise.resolve(success()));
		const observer = vi.fn();
		const onPayload = vi.fn();
		let settled = false;
		const result = stream(model, context, {
			apiKey: "synthetic",
			fetch,
			maxRetries: 0,
			onResponse: observer,
			gatewayPreEgressTrust: fixtureTrust,
			onPayload,
		})
			.result()
			.then((value) => {
				settled = true;
				return value;
			});
		await vi.advanceTimersByTimeAsync(6_300);
		expect(settled).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3_700);
		expect(await result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Reopened" }] });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(new Set(fetch.mock.calls.map(([, init]) => init.body)).size).toBe(1);
		expect(observer.mock.calls[0][0]).toMatchObject({
			status: 503,
			preEgressWait: { state: "waiting", reason: "maintenance", nextCheckMs: 5_000 },
		});
		expect(observer.mock.calls.at(-2)?.[0]).toMatchObject({ status: 503, preEgressWait: { state: "ended" } });
	});
	it.each(["cancel", "deadline", "inherited deadline"])("preserves %s across repeated refusals", async (kind) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetch = vi.fn(async () => refusal());
		const observer = vi.fn();
		const result = stream(model, context, {
			apiKey: "synthetic",
			fetch,
			signal: controller.signal,
			timeoutMs: kind === "deadline" ? 6_300 : undefined,
			maxRetries: 3,
			onResponse: observer,
			gatewayPreEgressTrust: fixtureTrust,
		}).result();
		if (kind === "inherited deadline") setTimeout(() => controller.abort(new Error("Parent deadline")), 6_300);
		await vi.advanceTimersByTimeAsync(6_000);
		if (kind === "cancel") controller.abort();
		await vi.advanceTimersByTimeAsync(400);
		expect(await result).toMatchObject({
			stopReason: kind === "deadline" ? "error" : "aborted",
			content: [],
			usage: { totalTokens: 0 },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ status: 503, preEgressWait: { state: "ended" } });
	});
	it.each([
		["unmarked", { "x-anthropic-throttle-proxy": "" }, 503, body],
		["wrong stamp", { "x-anthropic-throttle-proxy": "0" }, 503, body],
		["no admission", { "x-throttle-admission-closed": "" }, 503, body],
		["malformed delay", { "retry-after": "5junk" }, 503, body],
		["unbounded delay", { "retry-after": "99999999" }, 503, body],
		["contradictory retry", { "x-should-retry": "false" }, 503, body],
		["auth", {}, 401, body],
		["entitlement", {}, 403, body],
		["hard limit", {}, 429, body],
		["redirect", { location: "http://foreign.invalid" }, 307, body],
		["wrong body", {}, 503, "unknown outcome"],
	] as const)("does not patient-retry %s", async (_label, change, status, text) => {
		const fetch = vi.fn(async () => refusal(change, status, text));
		const observer = vi.fn();
		const result = await stream(model, context, {
			apiKey: "synthetic",
			fetch,
			maxRetries: 0,
			onResponse: observer,
			gatewayPreEgressTrust: fixtureTrust,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(observer).not.toHaveBeenCalled();
	});
	it.each([
		"https://foreign.invalid",
		"http://127.0.0.1:8766",
		"http://user:secret@127.0.0.1:8765",
		"http://127.0.0.1:8765/other",
	])("rejects configured origin/path %s", async (baseUrl) => {
		const fetch = vi.fn(async () => refusal());
		expect(
			(
				await stream({ ...model, baseUrl }, context, {
					apiKey: "synthetic",
					fetch,
					gatewayPreEgressTrust: fixtureTrust,
				}).result()
			).stopReason,
		).toBe("error");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(["redirected", "foreign response"])("rejects %s provenance", async (kind) => {
		const fetch = vi.fn(async () => {
			const response = refusal();
			Object.defineProperty(response, kind === "redirected" ? "redirected" : "url", {
				value: kind === "redirected" ? true : "http://foreign.invalid/v1/messages",
				configurable: true,
			});
			return response;
		});
		expect(
			(await stream(model, context, { apiKey: "synthetic", fetch, gatewayPreEgressTrust: fixtureTrust }).result())
				.stopReason,
		).toBe("error");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
