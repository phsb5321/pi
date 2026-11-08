import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, FetchFunction, GatewayPreEgressTrust, Model } from "@earendil-works/pi-ai";
import { GatewayPreEgressTrustError } from "@earendil-works/pi-ai/utils/gateway-pre-egress";
import { createLocalGatewayPreEgressTrust, readGatewayAcceptance } from "./local-gateway-trust.ts";

interface MaintenanceWindow {
	schemaVersion: 1;
	kind: "gateway-initial-maintenance";
	id: string;
	origin: string;
	startedAt: number;
	expiresAt: number;
	phase: "holding" | "released" | "aborted";
}

function windowBinding(window: MaintenanceWindow): string {
	return JSON.stringify([window.id, window.origin, window.startedAt, window.expiresAt]);
}

async function readWindow(path: string, origin: string, signal: AbortSignal): Promise<MaintenanceWindow | undefined> {
	let text: string;
	try {
		text = await readGatewayAcceptance(path, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid gateway maintenance window");
	const window = value as Record<string, unknown>;
	const now = Date.now();
	if (
		Object.keys(window).sort().join(",") !== "expiresAt,id,kind,origin,phase,schemaVersion,startedAt" ||
		window.schemaVersion !== 1 ||
		window.kind !== "gateway-initial-maintenance" ||
		typeof window.id !== "string" ||
		!/^[a-f0-9]{32}$/.test(window.id) ||
		window.origin !== origin ||
		!Number.isSafeInteger(window.startedAt) ||
		!Number.isSafeInteger(window.expiresAt) ||
		Number(window.startedAt) < 0 ||
		Number(window.startedAt) > now ||
		Number(window.expiresAt) <= now ||
		Number(window.expiresAt) - Number(window.startedAt) > 360_000 ||
		(window.phase !== "holding" && window.phase !== "released")
	)
		throw new Error("Invalid, expired or aborted gateway maintenance window");
	return {
		schemaVersion: 1,
		kind: "gateway-initial-maintenance",
		id: window.id,
		origin,
		startedAt: Number(window.startedAt),
		expiresAt: Number(window.expiresAt),
		phase: window.phase,
	};
}

/**
 * Host-owned INITIAL deferral, not a response retry or extension event handler.
 * The native adapter supplies its existing combined cancellation/deadline signal.
 * The window can withhold a request; only fresh loaded-generation verification can release it.
 * `stateDir` is an isolated-test seam, never an environment or extension discovery mechanism.
 */
export function createLocalGatewayMaintenanceFetch(
	model: Model<Api>,
	fetch: FetchFunction | undefined,
	trust: GatewayPreEgressTrust | undefined,
	stateDir = join(homedir(), ".local/state/throttler-gateway"),
): FetchFunction | undefined {
	if (!createLocalGatewayPreEgressTrust(model) || !trust) return fetch;
	const send = fetch ?? globalThis.fetch;
	const origin = new URL(model.baseUrl).origin;
	const windowPath = join(stateDir, "maintenance.json");
	const requests = join(stateDir, "receiving");
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== origin || url.pathname !== "/v1/messages" || init?.method?.toUpperCase() !== "POST")
			return send(input, init);
		// A URL object is mutable across awaits; Request.url is immutable and retains Request semantics.
		const destination = input instanceof Request ? input : url.href;
		const signal = init.signal;
		if (!signal || typeof init.body !== "string")
			throw new GatewayPreEgressTrustError("Gateway request lacks native signal or serialized body");
		let leasePath: string | undefined;
		let dispatching = false;
		let response: Response | undefined;
		let failure: { error: unknown } | undefined;
		try {
			signal.throwIfAborted();
			// Capture once. No payload reconstruction, callback replay, timeout renewal or selection mutation.
			const request = { ...init, headers: new Headers(init.headers), signal };
			await mkdir(requests, { recursive: true, mode: 0o700 });
			const directory = await lstat(requests);
			if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700)
				throw new Error("Unsupported gateway receiving directory");
			const leaseName = join(requests, `${process.pid}-${randomBytes(16).toString("hex")}.json`);
			const lease = await open(
				leaseName,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			leasePath = leaseName;
			try {
				await lease.writeFile(JSON.stringify({ schemaVersion: 1, kind: "gateway-receiving", pid: process.pid }));
			} finally {
				await lease.close();
			}
			signal.throwIfAborted();
			let window = await readWindow(windowPath, origin, signal);
			if (window) {
				const binding = windowBinding(window);
				const waitingPath = leasePath.replace(/\.json$/, `.${window.id}.waiting`);
				await rename(leasePath, waitingPath);
				leasePath = waitingPath;
				while (window.phase === "holding") {
					await delay(50, undefined, { signal });
					window = await readWindow(windowPath, origin, signal);
					if (!window || windowBinding(window) !== binding) throw new Error("Gateway maintenance custody changed");
				}
				// A window/503/SSE marker is NEVER receiving-generation authorization.
				if (trust.origin !== origin || !(await trust.verify(signal)))
					throw new Error("Gateway restored receiver is unverified");
				const released = await readWindow(windowPath, origin, signal);
				if (!released || released.phase !== "released" || windowBinding(released) !== binding)
					throw new Error("Gateway maintenance release changed");
			}
			signal.throwIfAborted();
			// A pre-fence lease stays through headers: p1 must settle it BEFORE closing admission.
			dispatching = true;
			response = await send(destination, request);
		} catch (error) {
			// Guard/refusal failures must not become retryable SDK connection failures.
			failure = {
				error: dispatching
					? error
					: new GatewayPreEgressTrustError("Local gateway maintenance failed closed", { cause: error }),
			};
		}
		if (leasePath) {
			try {
				await unlink(leasePath);
			} catch (error) {
				// Never replay a dispatched request merely because its local cleanup failed.
				throw new GatewayPreEgressTrustError("Gateway receiving lease cleanup failed closed", { cause: error });
			}
		}
		if (failure) throw failure.error;
		if (!response) throw new GatewayPreEgressTrustError("Gateway request has no response");
		return response;
	};
}
