import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { get } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Api, GatewayPreEgressTrust, Model } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "../utils/abort.ts";

const execFileAsync = promisify(execFile);
const ORIGINS = new Set(["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765"]);
const LIMIT = 16_384;
const HASH = /^[a-f0-9]{64}$/;
const PROPERTIES = [
	"ActiveState",
	"SubState",
	"MainPID",
	"InvocationID",
	"ExecMainStartTimestampMonotonic",
	"ExecStart",
	"NeedDaemonReload",
];

/** Test seam for the fixed, read-only host observations; not a config/command discovery API. */
export interface LocalGatewayHost {
	readAcceptance(signal: AbortSignal): Promise<string>;
	readService(signal: AbortSignal): Promise<Record<string, string>>;
	challenge(origin: string, nonce: string, signal: AbortSignal): Promise<unknown>;
	readModule(path: string, signal: AbortSignal): Promise<Uint8Array>;
}

interface AcceptedChain {
	schemaVersion: 1;
	origin: string;
	sourceRev: string;
	build: string;
	pid: number;
	invocationId: string;
	startedMonotonic: string;
	configSha256: string;
	modules: Record<string, string>;
	acceptedAt: number;
	expiresAt: number;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acceptedChain(value: unknown, origin: string, now: number): value is AcceptedChain {
	if (!object(value) || !object(value.modules)) return false;
	const modules = Object.entries(value.modules);
	return (
		value.schemaVersion === 1 &&
		value.origin === origin &&
		typeof value.sourceRev === "string" &&
		/^[a-f0-9]{40}$/.test(value.sourceRev) &&
		typeof value.build === "string" &&
		/^\/nix\/store\/[a-z0-9]{32}-throttler-gateway-[a-zA-Z0-9.+_-]+\/lib\/python3\.\d+\/site-packages\/anthropic_throttle_proxy$/.test(
			value.build,
		) &&
		Number.isSafeInteger(value.pid) &&
		Number(value.pid) > 0 &&
		typeof value.invocationId === "string" &&
		/^[a-f0-9]{32}$/.test(value.invocationId) &&
		typeof value.startedMonotonic === "string" &&
		/^[1-9]\d*$/.test(value.startedMonotonic) &&
		typeof value.configSha256 === "string" &&
		HASH.test(value.configSha256) &&
		modules.length === 3 &&
		Object.hasOwn(value.modules, "proxy.py") &&
		Object.hasOwn(value.modules, "forwarding.py") &&
		Object.hasOwn(value.modules, "capability.py") &&
		modules.every(([name, hash]) => /^[a-z_]+\.py$/.test(name) && typeof hash === "string" && HASH.test(hash)) &&
		Number.isSafeInteger(value.acceptedAt) &&
		Number.isSafeInteger(value.expiresAt) &&
		Number(value.acceptedAt) <= now &&
		now < Number(value.expiresAt) &&
		Number(value.expiresAt) - Number(value.acceptedAt) <= 3_600_000
	);
}

/** Read deployment authorization without accepting a symlink, special file or foreign/writable policy. */
export async function readGatewayAcceptance(path: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > LIMIT)
			throw new Error("Unsupported gateway acceptance file");
		const buffer = Buffer.alloc(LIMIT + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		signal.throwIfAborted();
		if (bytesRead > LIMIT) throw new Error("Oversized gateway acceptance");
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await file.close();
	}
}

const host: LocalGatewayHost = {
	// p1's explicit qualification authorization is NEVER sufficient runtime evidence.
	readAcceptance: (signal) =>
		readGatewayAcceptance(join(homedir(), ".local/state/throttler-gateway/accepted-chain.json"), signal),
	async readService(signal) {
		// Fixed executable/unit/properties only. Do not read Environment (it may contain secrets).
		const { stdout } = await execFileAsync(
			"/run/current-system/sw/bin/systemctl",
			[
				"--user",
				"show",
				"throttler-gateway.service",
				"--no-pager",
				...PROPERTIES.map((name) => `--property=${name}`),
			],
			{ signal, timeout: 1000, maxBuffer: LIMIT, encoding: "utf8", cwd: "/" },
		);
		return Object.fromEntries(
			stdout
				.trim()
				.split("\n")
				.map((line) => {
					const index = line.indexOf("=");
					if (index < 1) throw new Error("Invalid service observation");
					return [line.slice(0, index), line.slice(index + 1)];
				}),
		);
	},
	challenge(origin, nonce, signal) {
		return new Promise((resolve, reject) => {
			// node:http does not discover HTTP_PROXY, follow redirects or forward authorization.
			const request = get(
				`${origin}/__throttle/pre-egress-capability?nonce=${nonce}`,
				{ signal, agent: false, headers: { accept: "application/json", "cache-control": "no-store" } },
				(response) => {
					if (
						response.statusCode !== 200 ||
						response.headers["content-type"]?.split(";")[0] !== "application/json"
					) {
						response.destroy();
						reject(new Error("Unsupported gateway capability"));
						return;
					}
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("error", reject);
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > LIMIT) {
							response.destroy();
							reject(new Error("Oversized gateway capability"));
						} else chunks.push(chunk);
					});
					response.on("end", () => {
						try {
							resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			request.on("error", reject);
		});
	},
	async readModule(path, signal) {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Unsupported gateway module");
			return await readFile(file, { signal });
		} finally {
			await file.close();
		}
	},
};

/**
 * Default-off production issuer for p1-qualified DIRECT Linux deployments only.
 * A descriptor selects accepted bytes; fresh process/config/module observations prove they are live.
 * An actually configured central chain is unsupported, never followed or endorsed from a header.
 */
export function createLocalGatewayPreEgressTrust(
	model: Model<Api>,
	observations: LocalGatewayHost = host,
): GatewayPreEgressTrust | undefined {
	let base: URL;
	try {
		base = new URL(model.baseUrl);
	} catch {
		return undefined;
	}
	if (
		process.platform !== "linux" ||
		model.provider !== "claude-lane" ||
		model.api !== "anthropic-messages" ||
		!model.id.startsWith("claude-") ||
		!ORIGINS.has(base.origin) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		(base.pathname !== "/" && base.pathname !== "/v1")
	)
		return undefined;
	const origin = base.origin;
	let binding: string | undefined;
	let revoked = false;
	return {
		origin,
		async verify(callerSignal) {
			if (revoked) return false;
			let verified = false;
			const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(1500)]);
			try {
				return await raceWithAbortSignal(
					(async () => {
						signal.throwIfAborted();
						const text = await observations.readAcceptance(signal);
						if (text.length > LIMIT || (binding !== undefined && binding !== text)) return false;
						const accepted: unknown = JSON.parse(text);
						if (!acceptedChain(accepted, origin, Date.now())) return false;
						const root = accepted.build.split("/").slice(0, 4).join("/");
						const before = await observations.readService(signal);
						if (
							before.ActiveState !== "active" ||
							before.SubState !== "running" ||
							before.NeedDaemonReload !== "no" ||
							before.MainPID !== String(accepted.pid) ||
							before.InvocationID !== accepted.invocationId ||
							before.ExecMainStartTimestampMonotonic !== accepted.startedMonotonic ||
							!before.ExecStart?.startsWith(
								`{ path=${root}/bin/throttler-gateway ; argv[]=${root}/bin/throttler-gateway ;`,
							)
						)
							return false;
						const matchesCapability = async () => {
							const nonce = randomBytes(32).toString("hex");
							const capability = await observations.challenge(origin, nonce, signal);
							return (
								object(capability) &&
								capability.schemaVersion === 1 &&
								capability.kind === "gateway-pre-egress-capability" &&
								capability.nonce === nonce &&
								capability.pid === accepted.pid &&
								capability.invocationId === accepted.invocationId &&
								capability.build === accepted.build &&
								capability.configSha256 === accepted.configSha256 &&
								capability.centralUrl === "" &&
								object(capability.modules) &&
								Object.keys(capability.modules).length === Object.keys(accepted.modules).length &&
								Object.entries(accepted.modules).every(
									([name, hash]) => (capability.modules as Record<string, unknown>)[name] === hash,
								)
							);
						};
						// Prove the installed capability module BEFORE requesting its reserved route.
						// Old producers catch-all forward unknown paths; never probe those as a fallback.
						for (const [name, hash] of Object.entries(accepted.modules)) {
							const bytes = await observations.readModule(`${accepted.build}/${name}`, signal);
							if (bytes.length > 2_000_000 || createHash("sha256").update(bytes).digest("hex") !== hash)
								return false;
						}
						if (!(await matchesCapability()) || !(await matchesCapability())) return false;
						const after = await observations.readService(signal);
						if (
							PROPERTIES.some((name) => before[name] !== after[name]) ||
							(await observations.readAcceptance(signal)) !== text ||
							!acceptedChain(accepted, origin, Date.now())
						)
							return false;
						signal.throwIfAborted();
						binding = text;
						verified = true;
						return true;
					})(),
					signal,
				);
			} catch {
				return false;
			} finally {
				// Once issued, any uncertainty permanently revokes this logical request's capability.
				// A subsequent request needs a new issuer and fresh p1 deployment acceptance.
				if (binding !== undefined && !verified) revoked = true;
			}
		},
	};
}
