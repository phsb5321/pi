import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../../ai/src/api/anthropic-messages.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import * as localTrust from "../src/core/local-gateway-trust.ts";
import {
	createLocalGatewayPreEgressTrust,
	type LocalGatewayHost,
	readGatewayAcceptance,
} from "../src/core/local-gateway-trust.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-fixture",
	name: "Fixture only",
	api: "anthropic-messages",
	provider: "claude-lane",
	baseUrl: "http://127.0.0.1:8765",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const build =
	"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-throttler-gateway-0.1.0/lib/python3.14/site-packages/anthropic_throttle_proxy";
const moduleBytes = new TextEncoder().encode("owned immutable fixture bytes");
const hash = createHash("sha256").update(moduleBytes).digest("hex");
const context = normalizeContext({ messages: [{ role: "user", content: "Fixture only", timestamp: 1 }] });

function fixture() {
	const accepted = {
		schemaVersion: 1,
		origin: model.baseUrl,
		sourceRev: "b".repeat(40),
		build,
		pid: 123,
		invocationId: "c".repeat(32),
		startedMonotonic: "123456",
		configSha256: "d".repeat(64),
		modules: { "proxy.py": hash, "forwarding.py": hash, "capability.py": hash },
		acceptedAt: Date.now() - 1000,
		expiresAt: Date.now() + 60_000,
	};
	const service = {
		ActiveState: "active",
		SubState: "running",
		MainPID: "123",
		InvocationID: accepted.invocationId,
		ExecMainStartTimestampMonotonic: accepted.startedMonotonic,
		NeedDaemonReload: "no",
		ExecStart: `{ path=${build.split("/").slice(0, 4).join("/")}/bin/throttler-gateway ; argv[]=${build.split("/").slice(0, 4).join("/")}/bin/throttler-gateway ; ignore_errors=no ; }`,
	};
	const capability = {
		schemaVersion: 1,
		kind: "gateway-pre-egress-capability",
		pid: accepted.pid,
		invocationId: accepted.invocationId,
		build,
		configSha256: accepted.configSha256,
		centralUrl: "",
		modules: { ...accepted.modules },
		// Neither value is a trust prerequisite. These intentionally describe genuine closed admission.
		admissionClosed: true,
		allow: false,
	};
	const host = {
		readAcceptance: vi.fn(async (_signal: AbortSignal) => JSON.stringify(accepted)),
		readService: vi.fn(async (_signal: AbortSignal) => ({ ...service })),
		challenge: vi.fn(
			async (_origin: string, nonce: string, _signal: AbortSignal): Promise<unknown> => ({ ...capability, nonce }),
		),
		readModule: vi.fn(async (_path: string, _signal: AbortSignal) => moduleBytes),
	} satisfies LocalGatewayHost;
	const trust = createLocalGatewayPreEgressTrust(model, host)!;
	return { accepted, service, capability, host, trust };
}
const signal = () => new AbortController().signal;
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("production local host issuer", () => {
	it.each(["regular", "symlink", "public mode", "directory", "oversize", "cancelled"])(
		"reads only bounded owner-only regular acceptance: %s",
		async (kind) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-gateway-acceptance-"));
			const file = join(dir, "accepted.json");
			const controller = new AbortController();
			try {
				writeFileSync(file, kind === "oversize" ? "x".repeat(16_385) : "fixture", { mode: 0o600 });
				if (kind === "symlink") symlinkSync(file, join(dir, "link.json"));
				if (kind === "public mode") chmodSync(file, 0o644);
				if (kind === "cancelled") controller.abort();
				const result = readGatewayAcceptance(
					kind === "directory" ? dir : kind === "symlink" ? join(dir, "link.json") : file,
					controller.signal,
				);
				if (kind === "regular") expect(await result).toBe("fixture");
				else await expect(result).rejects.toThrow();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("joins fresh generation, immutable bytes and p1 acceptance during closed admission", async () => {
		const f = fixture();
		expect(await f.trust.verify(signal())).toBe(true);
		expect(await f.trust.verify(signal())).toBe(true);
		expect(f.host.challenge).toHaveBeenCalledTimes(4);
		const nonces = f.host.challenge.mock.calls.map(([origin, nonce]) => {
			expect(origin).toBe(model.baseUrl);
			expect(nonce).toMatch(/^[a-f0-9]{64}$/);
			return nonce;
		});
		expect(new Set(nonces).size).toBe(4);
		expect(f.host.readService).toHaveBeenCalledTimes(4);
		expect(f.host.readModule.mock.calls.map(([path]) => path)).toEqual([
			`${build}/proxy.py`,
			`${build}/forwarding.py`,
			`${build}/capability.py`,
			`${build}/proxy.py`,
			`${build}/forwarding.py`,
			`${build}/capability.py`,
		]);
	});

	it.each([
		["provider", { provider: "anthropic" }],
		["API", { api: "openai-completions" }],
		["model", { id: "other-model" }],
		["foreign origin", { baseUrl: "http://foreign.invalid" }],
		["port", { baseUrl: "http://127.0.0.1:8766" }],
		["userinfo", { baseUrl: "http://secret@127.0.0.1:8765" }],
		["path", { baseUrl: "http://127.0.0.1:8765/other" }],
		["query", { baseUrl: "http://127.0.0.1:8765/?other" }],
	] as const)("never discovers a host issuer for wrong %s", (_name, override) => {
		const f = fixture();
		expect(createLocalGatewayPreEgressTrust({ ...model, ...override }, f.host)).toBeUndefined();
		expect(f.host.readAcceptance).not.toHaveBeenCalled();
	});

	it.each([
		"missing",
		"malformed",
		"expired",
		"future",
		"unbounded",
		"foreign origin",
		"mutable path",
		"module traversal",
		"old21 unsafe path",
	])("fails closed for %s acceptance, before any capability request", async (kind) => {
		const f = fixture();
		if (kind === "missing") f.host.readAcceptance.mockRejectedValue(new Error("ENOENT"));
		if (kind === "malformed") f.host.readAcceptance.mockResolvedValue("{}");
		if (kind === "expired") f.accepted.expiresAt = Date.now() - 1;
		if (kind === "future") f.accepted.acceptedAt = Date.now() + 1000;
		if (kind === "unbounded") f.accepted.expiresAt = Date.now() + 3_600_001;
		if (kind === "foreign origin") f.accepted.origin = "http://localhost:8765";
		if (kind === "mutable path") f.accepted.build = "/tmp/candidate";
		if (kind === "module traversal") Object.assign(f.accepted.modules, { "../secret.py": hash });
		if (kind === "old21 unsafe path")
			f.host.readAcceptance.mockResolvedValue(
				JSON.stringify({
					...f.accepted,
					modules: { "proxy.py": hash, "forwarding.py": hash },
				}),
			);
		expect(await f.trust.verify(signal())).toBe(false);
		expect(f.host.challenge).not.toHaveBeenCalled();
	});

	it.each(["inactive", "old path", "PID", "invocation", "start", "reload"])(
		"rejects %s service identity before HTTP",
		async (kind) => {
			const f = fixture();
			if (kind === "inactive") f.service.ActiveState = "inactive";
			if (kind === "old path") f.service.ExecStart = "/nix/store/old/bin/throttler-gateway";
			if (kind === "PID") f.service.MainPID = "999";
			if (kind === "invocation") f.service.InvocationID = "e".repeat(32);
			if (kind === "start") f.service.ExecMainStartTimestampMonotonic = "999";
			if (kind === "reload") f.service.NeedDaemonReload = "yes";
			expect(await f.trust.verify(signal())).toBe(false);
			expect(f.host.challenge).not.toHaveBeenCalled();
		},
	);

	it.each([
		"old22 unsupported",
		"unknown schema",
		"nonce replay",
		"PID",
		"invocation",
		"module",
		"config",
		"unknown central",
	])("rejects %s capability regardless of marker/HTTP200/accepted candidate", async (kind) => {
		const f = fixture();
		if (kind === "old22 unsupported") f.host.challenge.mockResolvedValue({ build, marker: "1" });
		if (kind === "unknown schema") f.capability.schemaVersion = 2;
		if (kind === "nonce replay") f.host.challenge.mockResolvedValue({ ...f.capability, nonce: "e".repeat(64) });
		if (kind === "PID") f.capability.pid++;
		if (kind === "invocation") f.capability.invocationId = "e".repeat(32);
		if (kind === "module") f.capability.modules["forwarding.py"] = "e".repeat(64);
		if (kind === "config") f.capability.configSha256 = "e".repeat(64);
		if (kind === "unknown central") f.capability.centralUrl = "http://unverified.invalid";
		expect(await f.trust.verify(signal())).toBe(false);
		expect(f.host.readModule).toHaveBeenCalledTimes(3);
	});

	it.each(["file bytes", "restart during read", "hot config during read", "acceptance replaced"])(
		"rejects %s within one verification",
		async (kind) => {
			const f = fixture();
			if (kind === "file bytes") f.host.readModule.mockResolvedValue(new Uint8Array([0]));
			if (kind === "restart during read")
				f.host.readService
					.mockResolvedValueOnce({ ...f.service })
					.mockResolvedValue({ ...f.service, MainPID: "999" });
			if (kind === "hot config during read")
				f.host.challenge.mockImplementationOnce(async (_origin, nonce) => {
					const first = { ...f.capability, nonce };
					f.capability.configSha256 = "e".repeat(64);
					return first;
				});
			if (kind === "acceptance replaced")
				f.host.readAcceptance.mockResolvedValueOnce(JSON.stringify(f.accepted)).mockResolvedValue("{}");
			expect(await f.trust.verify(signal())).toBe(false);
		},
	);

	it("never probes an old catch-all when the capability module is absent or drifted", async () => {
		const f = fixture();
		f.host.readModule.mockImplementation(async (path) => {
			if (path.endsWith("/capability.py")) throw new Error("ENOENT: old producer");
			return moduleBytes;
		});
		expect(await f.trust.verify(signal())).toBe(false);
		expect(f.host.challenge).not.toHaveBeenCalled();
	});

	it("latches revocation across restart even if a new acceptance is subsequently published", async () => {
		const f = fixture();
		expect(await f.trust.verify(signal())).toBe(true);
		f.service.MainPID = "999";
		expect(await f.trust.verify(signal())).toBe(false);
		f.service.MainPID = "123";
		expect(await f.trust.verify(signal())).toBe(false);
		expect(f.host.challenge).toHaveBeenCalledTimes(2);
	});

	it("does not renew acceptance expiry or cache a positive result", async () => {
		vi.useFakeTimers();
		const f = fixture();
		expect(await f.trust.verify(signal())).toBe(true);
		await vi.advanceTimersByTimeAsync(60_001);
		expect(await f.trust.verify(signal())).toBe(false);
	});

	it("cancels a stalled issuer and propagates cancellation to its observations", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.host.challenge.mockImplementation((_origin, _nonce, observed) => {
			queueMicrotask(() => controller.abort());
			return new Promise((_resolve, reject) =>
				observed.addEventListener("abort", () => reject(observed.reason), { once: true }),
			);
		});
		expect(await f.trust.verify(controller.signal)).toBe(false);
		expect(f.host.challenge.mock.calls[0][2].aborted).toBe(true);
		expect(f.host.readModule).toHaveBeenCalledTimes(3);
	});

	it("bounds an uncooperative observation without requiring caller cancellation", async () => {
		const f = fixture();
		f.host.challenge.mockImplementation(() => new Promise(() => {}));
		const started = performance.now();
		expect(await f.trust.verify(signal())).toBe(false);
		expect(performance.now() - started).toBeLessThan(2200);
	});
});

function refusal() {
	const response = new Response("local policy: admission is quiesced; not accepting new work\n", {
		status: 503,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"x-anthropic-throttle-proxy": "1",
			"x-throttle-admission-closed": "1",
			"retry-after": "1",
		},
	});
	Object.defineProperty(response, "url", { value: `${model.baseUrl}/v1/messages?beta=true` });
	return response;
}
function success() {
	return new Response(
		[
			`event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","model":"${model.id}","usage":{"input_tokens":1,"output_tokens":0}}}\n\n`,
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Reopened"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("host issuer through the unchanged native patient-wait adapter", () => {
	it("ordinary AgentSession bootstrap reaches one native result without changing selection/history/tools", async () => {
		const f = fixture();
		vi.spyOn(localTrust, "createLocalGatewayPreEgressTrust").mockReturnValue(f.trust);
		const temp = mkdtempSync(join(tmpdir(), "pi-host-issuer-session-"));
		const agentDir = join(temp, "agent");
		mkdirSync(agentDir);
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } } });
		const loader = new DefaultResourceLoader({ cwd: temp, agentDir, settingsManager });
		await loader.reload();
		const credentials = AuthStorage.create(join(agentDir, "auth.json"));
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fixture" }));
		const registry = await createModelRegistry(credentials, join(agentDir, "models.json"));
		const fetch = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(success());
		registry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (requestModel, requestContext, options) =>
				stream(requestModel as Model<"anthropic-messages">, requestContext, {
					...options,
					apiKey: "fixture",
					fetch,
				}),
		});
		const { session } = await createAgentSession({
			cwd: temp,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime: getModelRuntime(registry),
			sessionManager: SessionManager.inMemory(temp),
			settingsManager,
			resourceLoader: loader,
		});
		try {
			const toolsBefore = session.getActiveToolNames();
			const promptBefore = session.systemPrompt;
			const events: string[] = [];
			session.subscribe((event) => events.push(event.type));
			vi.useFakeTimers();
			const prompt = session.prompt("Fixture only");
			await vi.advanceTimersByTimeAsync(1200);
			await prompt;
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(new Set(fetch.mock.calls.map(([, init]) => init.body)).size).toBe(1);
			expect(session.model).toMatchObject({ provider: model.provider, id: model.id, baseUrl: model.baseUrl });
			expect(session.thinkingLevel).toBe("off");
			expect(session.systemPrompt).toBe(promptBefore);
			expect(session.getActiveToolNames()).toEqual(toolsBefore);
			expect(session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
			expect(session.getLastAssistantText()).toBe("Reopened");
			expect(events.filter((type) => type === "agent_settled")).toHaveLength(1);
			expect(events).not.toContain("tool_execution_start");
		} finally {
			session.dispose();
			registry.unregisterProvider(model.provider);
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("waits on owned closed admission then returns exactly one result with unchanged payload/model/tools", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const fetch = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(success());
		const onPayload = vi.fn();
		const result = stream(model, context, {
			apiKey: "fixture",
			fetch,
			maxRetries: 0,
			gatewayPreEgressTrust: f.trust,
			onPayload,
		}).result();
		await vi.advanceTimersByTimeAsync(1001);
		expect(await result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Reopened" }] });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(new Set(fetch.mock.calls.map(([, init]) => init.body)).size).toBe(1);
		expect(onPayload).toHaveBeenCalledOnce();
		expect(f.host.challenge).toHaveBeenCalledTimes(4);
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: model.id, stream: true });
	});

	it("does not resend a stamped old/unknown-chain refusal", async () => {
		const f = fixture();
		f.capability.centralUrl = "http://old21.invalid";
		const fetch = vi.fn(async () => refusal());
		expect(
			(
				await stream(model, context, {
					apiKey: "fixture",
					fetch,
					maxRetries: 0,
					gatewayPreEgressTrust: f.trust,
				}).result()
			).stopReason,
		).toBe("error");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each(["cancel", "deadline", "restart"])("preserves %s without context/tool replay", async (kind) => {
		vi.useFakeTimers();
		const f = fixture();
		const controller = new AbortController();
		const fetch = vi.fn(async () => refusal());
		const result = stream(model, context, {
			apiKey: "fixture",
			fetch,
			maxRetries: 0,
			signal: controller.signal,
			timeoutMs: kind === "deadline" ? 500 : undefined,
			gatewayPreEgressTrust: f.trust,
		}).result();
		await vi.advanceTimersByTimeAsync(100);
		if (kind === "cancel") controller.abort();
		if (kind === "restart") f.service.MainPID = "999";
		await vi.advanceTimersByTimeAsync(1001);
		expect(await result).toMatchObject({
			stopReason: kind === "cancel" ? "aborted" : "error",
			content: [],
			usage: { totalTokens: 0 },
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
