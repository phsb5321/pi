import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

const STATUS_KEY = "gateway-queue";
// ponytail: the shipped Claude lane is loopback :8765; add an explicit origin setting for remote gateways.
const GATEWAY_ORIGINS = new Set(["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Passive queue display only: never submits, retries, changes a deadline, or writes model context. */
export default function gatewayQueueExtension(pi: ExtensionAPI): void {
	let modelId: string | undefined;
	let displayed: string | undefined;
	let elapsedMs = 0;

	const clear = (_event: unknown, ctx: ExtensionContext) => {
		modelId = undefined;
		elapsedMs = 0;
		if (displayed !== undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			displayed = undefined;
		}
	};

	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("model_select", clear);
	pi.on("turn_start", clear);
	pi.on("turn_end", clear);
	pi.on("message_end", clear);
	pi.on("agent_end", clear);
	pi.on("agent_settled", clear);
	pi.on("before_provider_request", clear);
	pi.on("after_provider_response", (event, ctx) => {
		clear(event, ctx);
		const model = ctx.model;
		if (
			(ctx.mode !== "tui" && ctx.mode !== "rpc") ||
			!ctx.hasUI ||
			model?.provider !== "claude-lane" ||
			event.status !== 200
		)
			return;
		if (
			!Object.entries(event.headers).some(
				([key, value]) => key.toLowerCase() === "x-anthropic-throttle-proxy" && value === "1",
			)
		)
			return;
		try {
			const url = new URL(model.baseUrl);
			if (!url.username && !url.password && GATEWAY_ORIGINS.has(url.origin)) modelId = model.id;
		} catch {
			// Invalid configured origins never attest to gateway status.
			return;
		}
	});
	pi.on("provider_stream_event", (event, ctx) => {
		if (
			modelId === undefined ||
			event.provider !== "claude-lane" ||
			event.api !== "anthropic-messages" ||
			event.model !== modelId
		)
			return;
		const data = event.data;
		if (!isObject(data)) return;
		if (data.type !== "ping") {
			clear(event, ctx);
			return;
		}
		const status = data.throttler_queue;
		if (
			!isObject(status) ||
			status.version !== 1 ||
			status.source !== "throttler-gateway" ||
			status.state !== "waiting"
		)
			return;
		const reason = status.reason;
		const elapsed = status.elapsed_ms;
		const nextCheck = status.next_check_ms;
		if (reason !== "queue" && reason !== "weekly_pacing" && reason !== "retry_after") return;
		if (
			typeof elapsed !== "number" ||
			!Number.isFinite(elapsed) ||
			elapsed < elapsedMs ||
			elapsed > Number.MAX_SAFE_INTEGER
		)
			return;
		if (
			typeof nextCheck !== "number" ||
			!Number.isFinite(nextCheck) ||
			nextCheck < 0 ||
			nextCheck > Number.MAX_SAFE_INTEGER
		)
			return;
		elapsedMs = elapsed;
		const message = `Queued: ${reason.replaceAll("_", " ")} | waited ${Math.floor(elapsed / 1000)}s | next check in ${Math.ceil(nextCheck / 1000)}s`;
		if (displayed !== message) {
			ctx.ui.setStatus(STATUS_KEY, message);
			displayed = message;
		}
	});
}
