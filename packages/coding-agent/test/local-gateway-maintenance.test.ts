import { chmod, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FetchFunction, GatewayPreEgressTrust, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../../ai/src/api/anthropic-messages.ts";
import { createLocalGatewayMaintenanceFetch } from "../src/core/local-gateway-maintenance.ts";

const model: Model<"anthropic-messages"> = {
	...getModel("anthropic", "claude-sonnet-4-5"),
	id: "claude-transition-fixture",
	name: "Synthetic INITIAL only",
	provider: "claude-lane",
	baseUrl: "http://127.0.0.1:8765",
	reasoning: false,
};
const context = normalizeContext({ messages: [{ role: "user", content: "INITIAL_SAME_REQUEST", timestamp: 1 }] });
const owned: string[] = [];
afterEach(async () => {
	await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function setup(phase: "holding" | "released" | "absent" = "holding") {
	const dir = await mkdtemp(join(tmpdir(), "pi-initial-maintenance-"));
	owned.push(dir);
	const path = join(dir, "maintenance.json");
	const window = {
		schemaVersion: 1,
		kind: "gateway-initial-maintenance",
		id: "a".repeat(32),
		origin: model.baseUrl,
		startedAt: Date.now(),
		expiresAt: Date.now() + 30_000,
		phase: phase === "absent" ? "holding" : phase,
	};
	const publish = async (changes: Record<string, unknown> = {}) => {
		await writeFile(`${path}.new`, JSON.stringify({ ...window, ...changes }), { mode: 0o600 });
		await rename(`${path}.new`, path);
	};
	if (phase !== "absent") await publish();
	// Component-only issuer. This does NOT qualify a deployed generation or manufacture production custody.
	const verify = vi.fn(async (_signal: AbortSignal) => true);
	const trust: GatewayPreEgressTrust = { origin: model.baseUrl, verify };
	const fetch = vi.fn<FetchFunction>(async () => success());
	const receiving = () => readdir(join(dir, "receiving"));
	const wrapped = createLocalGatewayMaintenanceFetch(model, fetch, trust, dir)!;
	const native = (options: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number } = {}) => {
		const onPayload = vi.fn();
		const result = stream(model, context, {
			apiKey: "synthetic-no-provider",
			fetch: wrapped,
			gatewayPreEgressTrust: trust,
			timeoutMs: 10_000,
			maxRetries: 2,
			onPayload,
			...options,
		}).result();
		return { result, onPayload };
	};
	const waitForHeld = () =>
		vi.waitFor(async () => expect((await receiving()).some((name) => name.endsWith(".waiting"))).toBe(true), {
			timeout: 2000,
		});
	return { dir, path, window, publish, trust, verify, fetch, wrapped, native, receiving, waitForHeld };
}

function success() {
	return new Response(
		`event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"${model.id}","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"SAME_REQUEST_CONTINUED"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("host-owned INITIAL maintenance fence", () => {
	it("keeps the real native operation pending, then dispatches its one serialized payload once", async () => {
		const f = await setup();
		const { result, onPayload } = f.native();
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await f.waitForHeld();
		expect(settled).toBe(false);
		expect(f.fetch).not.toHaveBeenCalled();
		expect(f.verify).not.toHaveBeenCalled();
		expect(onPayload).toHaveBeenCalledTimes(1);
		const lease = (await f.receiving())[0];
		expect(JSON.parse(await readFile(join(f.dir, "receiving", lease), "utf8"))).toEqual({
			schemaVersion: 1,
			kind: "gateway-receiving",
			pid: process.pid,
		});
		await f.publish({ phase: "released" });
		expect((await result).stopReason).toBe("stop");
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(f.verify).toHaveBeenCalledTimes(1);
		const [input, request] = f.fetch.mock.calls[0];
		expect(String(input)).toBe(`${model.baseUrl}/v1/messages?beta=true`);
		expect(JSON.parse(String(request?.body))).toMatchObject({ model: model.id, stream: true });
		expect(String(request?.body)).toContain("INITIAL_SAME_REQUEST");
		expect(request?.signal?.aborted).toBe(false);
		expect(await f.receiving()).toEqual([]);
	});

	it.each(["string", "mutable origin", "mutable path", "mutable origin and path", "Request"])(
		"captures the original destination, body and headers, not mutable caller state (%s)",
		async (kind) => {
			const f = await setup();
			const controller = new AbortController();
			const destination = `${model.baseUrl}/v1/messages?beta=true`;
			const input = kind.startsWith("mutable")
				? new URL(destination)
				: kind === "Request"
					? new Request(destination, { credentials: "omit", cache: "no-store" })
					: destination;
			const request = {
				method: "POST",
				body: "ORIGINAL_SERIALIZED",
				headers: { "x-original": "one" },
				signal: controller.signal,
			};
			const pending = f.wrapped(input, request);
			await f.waitForHeld();
			if (input instanceof URL) {
				if (kind.includes("origin")) input.href = "https://example.invalid/v1/messages?beta=true";
				if (kind.includes("path")) input.pathname = "/v1/not-messages";
			}
			request.body = "MUTATED";
			request.headers["x-original"] = "two";
			await f.publish({ phase: "released" });
			await pending;
			expect(f.fetch).toHaveBeenCalledTimes(1);
			const [sent, captured] = f.fetch.mock.calls[0];
			expect(sent instanceof Request ? sent.url : String(sent)).toBe(destination);
			if (input instanceof Request) expect(sent).toBe(input);
			expect(captured?.body).toBe("ORIGINAL_SERIALIZED");
			expect(new Headers(captured?.headers).get("x-original")).toBe("one");
			expect(captured?.signal).toBe(controller.signal);
			expect(await f.receiving()).toEqual([]);
		},
	);

	it.each(["caller cancellation", "original effective deadline"])(
		"preserves %s with zero dispatch or provider retries, even after release",
		async (kind) => {
			const f = await setup();
			const controller = new AbortController();
			const { result, onPayload } = f.native(
				kind === "caller cancellation" ? { signal: controller.signal } : { timeoutMs: 150 },
			);
			if (kind === "caller cancellation") {
				await f.waitForHeld();
				controller.abort();
			}
			const answer = await result;
			expect(answer.stopReason).not.toBe("stop");
			if (kind === "caller cancellation") expect(answer.stopReason).toBe("aborted");
			await f.publish({ phase: "released" });
			await delay(80);
			expect(f.fetch).not.toHaveBeenCalled();
			expect(f.verify).not.toHaveBeenCalled();
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(await f.receiving()).toEqual([]);
		},
	);

	it.each(["removed", "replaced", "expired", "aborted", "unverified", "changed during verification"])(
		"fails the same native operation closed for %s, without SDK retry",
		async (kind) => {
			const f = await setup();
			const { result, onPayload } = f.native({ maxRetries: 3 });
			await f.waitForHeld();
			if (kind === "removed") await unlink(f.path);
			else if (kind === "replaced") await f.publish({ id: "b".repeat(32) });
			else if (kind === "expired") await f.publish({ expiresAt: Date.now() - 1 });
			else if (kind === "aborted") await f.publish({ phase: "aborted" });
			else {
				f.verify.mockImplementation(async () => {
					if (kind === "changed during verification") await f.publish({ phase: "holding" });
					return kind !== "unverified";
				});
				await f.publish({ phase: "released" });
			}
			expect((await result).stopReason).toBe("error");
			expect(f.fetch).not.toHaveBeenCalled();
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(f.verify.mock.calls.length).toBeLessThanOrEqual(1);
			expect(await f.receiving()).toEqual([]);
		},
	);

	it.each(["symlink", "public permissions", "oversize", "extra field", "renewed deadline"])(
		"refuses %s custody",
		async (kind) => {
			const f = await setup();
			if (kind === "symlink") {
				await rename(f.path, `${f.path}.target`);
				await symlink(`${f.path}.target`, f.path);
			} else if (kind === "public permissions") await chmod(f.path, 0o644);
			else if (kind === "oversize") await writeFile(f.path, "x".repeat(16_385));
			else if (kind === "extra field") await f.publish({ authorizeProvider: true });
			else await f.publish({ expiresAt: f.window.startedAt + 360_001 });
			expect((await f.native().result).stopReason).toBe("error");
			expect(f.fetch).not.toHaveBeenCalled();
			expect(f.verify).not.toHaveBeenCalled();
			expect(await f.receiving()).toEqual([]);
		},
	);

	it("registers before checking the fence and retains pre-fence leases through response headers", async () => {
		const f = await setup("absent");
		let respond!: (response: Response) => void;
		f.fetch.mockImplementation(
			async () =>
				new Promise<Response>((resolve) => {
					respond = resolve;
				}),
		);
		const pending = f.wrapped(`${model.baseUrl}/v1/messages`, {
			method: "POST",
			body: "PRE_FENCE",
			signal: new AbortController().signal,
		});
		await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
		await f.publish(); // Publisher MUST publish before listing leases; closing now is forbidden.
		expect((await f.receiving()).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		respond(success());
		await pending;
		expect(await f.receiving()).toEqual([]);
	});

	it("does not trust or reinterpret an arbitrary 503 when no owner window exists", async () => {
		const f = await setup("absent");
		f.fetch.mockImplementation(async () => new Response("untrusted refusal", { status: 503 }));
		expect((await f.native({ maxRetries: 0 }).result).stopReason).toBe("error");
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(f.verify).not.toHaveBeenCalled();
		expect(await f.receiving()).toEqual([]);
	});

	it("does not replay a dispatched request if receiving-lease cleanup fails", async () => {
		const f = await setup("absent");
		f.fetch.mockImplementation(async () => {
			const lease = (await f.receiving())[0];
			await rename(join(f.dir, "receiving", lease), join(f.dir, "receiving", `${lease}.orphan`));
			return success();
		});
		const { result, onPayload } = f.native({ maxRetries: 3 });
		expect((await result).stopReason).toBe("error");
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(f.verify).not.toHaveBeenCalled();
	});

	it("leaves non-local, non-Anthropic and human-selected GPT routes untouched", async () => {
		const f = await setup();
		for (const override of [
			{ provider: "openai-codex" },
			{ baseUrl: "https://elsewhere.invalid" },
			{ id: "other" },
		]) {
			expect(createLocalGatewayMaintenanceFetch({ ...model, ...override }, f.fetch, f.trust, f.dir)).toBe(f.fetch);
		}
		expect(createLocalGatewayMaintenanceFetch(model, f.fetch, undefined, f.dir)).toBe(f.fetch);
		expect(
			createLocalGatewayMaintenanceFetch({ ...model, provider: "openai-codex" }, undefined, f.trust, f.dir),
		).toBeUndefined();
	});
});
