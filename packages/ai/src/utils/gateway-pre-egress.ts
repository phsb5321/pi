import type { FetchFunction, GatewayPreEgressTrust, Model, ProviderResponse } from "../types.ts";
import { raceWithAbortSignal } from "./abort.ts";
import { abortableSleep } from "./provider-retry.ts";

/** Kept distinct through SDK wrapping so revocation never spends/restarts provider retries. */
export class GatewayPreEgressTrustError extends Error {}

const ORIGINS = new Set(["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765"]);
const REFUSAL = new TextEncoder().encode("local policy: admission is quiesced; not accepting new work\n");

/** Exact bounded body match; never consume an unclassified original error response. */
async function matchesRefusal(response: Response, signal?: AbortSignal | null): Promise<boolean> {
	const reader = response.clone().body?.getReader();
	if (!reader) return false;
	let offset = 0;
	try {
		for (;;) {
			const read = reader.read();
			const { value, done } = signal ? await raceWithAbortSignal(read, signal) : await read;
			if (done) return offset === REFUSAL.length;
			for (const byte of value) {
				if (offset >= REFUSAL.length || byte !== REFUSAL[offset++]) return false;
			}
		}
	} finally {
		// A tee's cancel waits for the other branch: do not await it before returning that original.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/**
 * Wait inside ONE SDK fetch, retaining its original timeout/abort signal and serialized payload.
 * REQUIRES gateway PR21 anti-spoof stripping on EVERY configured relay tier.
 * Old producers (including d47/#20) cannot safely endorse this stamp: do not deploy with them.
 */
export function gatewayPreEgressFetch(
	model: Model<"anthropic-messages">,
	fetch: FetchFunction,
	onResponse?: (response: ProviderResponse) => void | Promise<void>,
	maxRetryDelayMs = 60_000,
	trust?: GatewayPreEgressTrust,
): FetchFunction {
	const notify = async (response: ProviderResponse) => {
		try {
			await onResponse?.(response);
		} catch {
			/* Advisory failures must never replay a transport result. */
		}
	};
	let base: URL;
	try {
		base = new URL(model.baseUrl);
	} catch {
		return fetch;
	}
	if (
		!trust ||
		trust.origin !== base.origin ||
		typeof trust.verify !== "function" ||
		model.provider !== "claude-lane" ||
		model.api !== "anthropic-messages" ||
		!model.id.startsWith("claude-") ||
		!ORIGINS.has(base.origin) ||
		base.username ||
		base.password ||
		(base.pathname !== "/" && base.pathname !== "/v1") ||
		base.search ||
		base.hash
	)
		return fetch;

	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (
			url.origin !== base.origin ||
			url.pathname !== "/v1/messages" ||
			url.search !== "?beta=true" ||
			url.username ||
			url.password ||
			url.hash ||
			init?.method?.toUpperCase() !== "POST" ||
			typeof init.body !== "string"
		)
			return fetch(input, init);
		try {
			const payload = JSON.parse(init.body);
			if (payload.model !== model.id || payload.stream !== true) return fetch(input, init);
		} catch {
			return fetch(input, init);
		}
		const signal = init.signal ?? new AbortController().signal;
		const verified = async () => {
			try {
				if (trust.origin !== base.origin) return false;
				return (await raceWithAbortSignal(Promise.resolve(trust.verify(signal)), signal)) === true;
			} catch {
				signal.throwIfAborted();
				return false;
			}
		};
		const started = performance.now();
		let waiting: ProviderResponse | undefined;
		try {
			for (;;) {
				signal.throwIfAborted();
				if (waiting && !(await verified()))
					throw new GatewayPreEgressTrustError("Local gateway pre-egress trust revoked");
				const response = await fetch(input, { ...init, redirect: "manual" });
				const retryAfter = response.headers.get("retry-after") ?? "";
				if (
					response.status !== 503 ||
					response.redirected ||
					response.url !== url.href ||
					response.headers.get("x-anthropic-throttle-proxy") !== "1" ||
					response.headers.get("x-throttle-admission-closed") !== "1" ||
					response.headers.get("content-type") !== "text/plain; charset=utf-8" ||
					response.headers.get("x-should-retry") === "false" ||
					response.headers.has("retry-after-ms") ||
					!/^[1-9]\d{0,4}$/.test(retryAfter) ||
					Number(retryAfter) > 86400 ||
					(maxRetryDelayMs > 0 && Number(retryAfter) * 1000 > maxRetryDelayMs) ||
					!(await verified()) ||
					!(await matchesRefusal(response, signal))
				)
					return response;
				await response.body?.cancel();
				waiting = {
					status: response.status,
					headers: Object.fromEntries(response.headers),
					preEgressWait: {
						state: "waiting",
						reason: "maintenance",
						elapsedMs: performance.now() - started,
						nextCheckMs: Number(retryAfter) * 1000,
					},
				};
				await notify(waiting);
				await abortableSleep(Number(retryAfter) * 1000, init.signal ?? undefined);
			}
		} finally {
			if (waiting)
				await notify({
					...waiting,
					preEgressWait: {
						state: "ended",
						reason: "maintenance",
						elapsedMs: performance.now() - started,
						nextCheckMs: 0,
					},
				});
		}
	};
}
