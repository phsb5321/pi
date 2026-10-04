/**
 * THIN-RESIDENCY ACCEPTANCE (pD, PORT-PI-THIN-EVIDENCE-1504) — native
 * observation + deterministic faux provider through the actual SDK.
 *
 * Corrections vs 1425:
 * - FALSE POSITIVE (stream) FIXED: stream/deltas are asserted from DELIVERED
 *   `view.subscribe` events before the turn settles — never from captured
 *   history text.
 * - FALSE POSITIVE (tool) FIXED: the tool surface asserts a NATIVE executed
 *   toolResult entry (EntryRecord-shaped: role/toolName/content) plus its
 *   originating assistant toolCall — never bare text.
 * - Independent fail-closed surfaces: model-accepted-in-native-state, input
 *   content (native user entry), active signal/outcome, tool result, delivered
 *   deltas, release/rehydrate history, finite PTY close/re-attach. Missing
 *   evidence marks PENDING; never ALL PASS.
 * - HOME override replaced by the native PI_CODING_AGENT_DIR (config
 *   getAgentDir) with explicit synthetic auth/model files (no real config
 *   read/written, no network/provider/account additions).
 *
 * Native seams (no runtime/source edits): `openDurable` (real SDK engine),
 * `dispatchDurableMember` (the committed 693 member contract),
 * `withRetainedHistory` + `composeSharedHost` (park/rehydrate + shared host),
 * `view.subscribe`/`view.current().conversation`/`controller` (observation),
 * `services.models.registerProvider` (provider injection), and the existing
 * faux provider pattern (registerFauxProvider / fauxAssistantMessage /
 * fauxText / fauxToolCall). Client/TUI custody stays with this slice.
 *
 * Run: node --experimental-strip-types \
 *   packages/coding-agent/src/experimental/durable/thin-residency-acceptance.ts
 * Exit: 0 = ALL PASS · 4 = PENDING (surfaces listed) · 3 = FAIL (internal).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { composeSharedHost, dispatchDurableMember, durableEngineShell } from "./shared-host-dispatch.ts";
import { ResidencyClient, toThinClient } from "./thin-residency-binding.ts";
import { createThinPresentation } from "./thin-presentation.ts";
import { openDurable, type OpenDurableResult } from "./runtime.ts";
import { withRetainedHistory, type HydrateSession, type InProcessSessionIdentity, type SessionMetadata } from "@earendil-works/pi-server";

type SurfaceState = "pass" | `pending:${string}`;
const surfaces = new Map<string, SurfaceState>();
const mark = (name: string, state: SurfaceState, note = ""): void => {
	surfaces.set(name, state);
	process.stdout.write(`[surface] ${name}=${state}${note ? ` (${note})` : ""}\n`);
};
const hard = (name: string, condition: boolean, note: string): void => {
	mark(name, condition ? "pass" : `pending:${note}`, condition ? note : "");
};

async function inner(): Promise<void> {
	const outDir = process.env.THIN_RESIDENCY_ARTIFACTS ?? join(tmpdir(), "thin-residency-artifacts");
	const root = join(outDir, "residency-root");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });

	// ── deterministic local provider (existing SDK faux pattern) ──
	const registration = registerFauxProvider({});
	const fauxModel = registration.getModel();
	const capturedEntries: string[] = [];
	let deliveredDeltas = 0;
	let activeBarrierEntered = 0;
	let cancelObserved = false;
	let releaseBarrier: (() => void) | undefined;
	const barrier = new Promise<void>((resolve) => {
		releaseBarrier = resolve;
	});
	const abortSignalOf = (options: unknown): AbortSignal | undefined => {
		const opts = options as { signal?: AbortSignal; abortSignal?: AbortSignal } | undefined;
		return opts?.signal ?? opts?.abortSignal;
	};
	registration.setResponses([
		async (context, options) => {
			const messages = ((context as { messages?: unknown[] }).messages ?? []) as unknown[];
			capturedEntries.push(JSON.stringify(messages));
			const lastUser = JSON.stringify(messages.filter((message) => JSON.stringify(message).includes("role\":\"user") || (message as { role?: string }).role === "user").slice(-1));
			const signal = abortSignalOf(options);
			if (lastUser.includes("turn one")) {
				activeBarrierEntered += 1;
				await Promise.race([
					barrier,
					signal?.aborted
						? Promise.resolve()
						: new Promise<void>((resolve) => {
								signal?.addEventListener("abort", () => resolve(), { once: true });
							}),
				]);
				if (signal?.aborted) cancelObserved = true;
				return fauxAssistantMessage(fauxText("turn-one-reply"), { stopReason: signal?.aborted ? "aborted" : "stop" });
			}
			if (lastUser.includes("turn two") && !JSON.stringify(messages).includes('"toolName"')) {
				return fauxAssistantMessage(fauxToolCall("bash", { command: "echo tool-ran" }), { stopReason: "toolUse" });
			}
			if (lastUser.includes("turn three")) return fauxAssistantMessage(fauxText("turn-three-reply"), { stopReason: "stop" });
			return fauxAssistantMessage(fauxText("turn-two-reply"), { stopReason: "stop" });
		},
	]);

	// ── native engine layer: openDurable + member dispatch + shared host ──
	const openedBySession = new Map<string, OpenDurableResult>();
	const hydrate: HydrateSession = async (metadata: SessionMetadata, identity: InProcessSessionIdentity) => {
		const cwd = join(root, metadata.id);
		mkdirSync(cwd, { recursive: true });
		const opened = await openDurable({ cwd, continueSession: false });
		openedBySession.set(metadata.id, opened);
		const services = (opened as unknown as { services?: { models?: { registerProvider?: (id: string, config: unknown) => void } } }).services;
		const modelRuntime = services?.models;
		if (!modelRuntime?.registerProvider) {
			// Fail-closed: provider injection is p4-owned (OpenDurableResult
			// exposes {view, controller, settings, close} only). The surfaces
			// below stay PENDING until that slice lands.
			mark("provider-injection", "pending:p4-owned runtime/provider injection (OpenDurableResult exposes no modelRuntime)");
		}
		if (modelRuntime?.registerProvider) {
			mark("provider-injection", "pass", "registerProvider reached via services.models");
			modelRuntime.registerProvider(fauxModel.provider, {
				api: registration.api,
				apiKey: "faux-key",
				baseUrl: "http://127.0.0.1:0",
				models: [{ id: fauxModel.id, name: "Faux", input: ["text"], contextWindow: 128000, maxTokens: 8192 }],
			});
		}
		// Minimal-compatible observation: mirror the 693 residency adapter's
		// `residency` member (its state record) over the bare member dispatch.
		const engine = durableEngineShell(
			identity,
			async (call) => {
				const member = String((call as { member?: unknown }).member ?? "");
				if (member === "residency") {
					const current = opened.view.current() as unknown as { session?: { id?: string; directory?: string } };
					return {
						sessionId: metadata.id,
						cwd,
						nativeSessionId: current.session?.id ?? "",
						directory: current.session?.directory ?? cwd,
						released: 0,
						resumed: 0,
						live: true,
					};
				}
				return dispatchDurableMember(opened, call);
			},
			async () => undefined,
		);
		return { engine, releaseResidency: () => undefined, resumeResidency: () => undefined };
	};
	const residency = composeSharedHost(withRetainedHistory(hydrate, { maxConcurrentHydrations: 2 }), { maxSessions: 2 }, undefined);

	const open = async (id: string): Promise<ResidencyClient> => {
		const handle = await residency.runtime.host.openSession({ id }, {} as never);
		const attachment = await handle.attachClient({} as never);
		return new ResidencyClient((call) => attachment.invokeService(call as never, () => undefined, {} as never) as Promise<unknown>);
	};
	const client = await open("r1");
	const record = await client.residency();
	const setModelResult = await client.call("setModel", [{ provider: fauxModel.provider, modelId: fauxModel.id }]).then(
		() => "ok",
		(error: unknown) => String(error instanceof Error ? error.message : error),
	);
	if (setModelResult !== "ok") mark("model-select", `pending:${setModelResult.slice(0, 60)}`);

	// model accepted in NATIVE state (independently required)
	const nativeView0 = openedBySession.get("r1")?.view.current();
	const models = (nativeView0 as { models?: Array<{ provider?: string; id?: string }> } | undefined)?.models ?? [];
	hard("model-native", models.some((model) => model.provider === fauxModel.provider && model.id === fauxModel.id), `native model list includes ${fauxModel.provider}/${fauxModel.id}`);

	// delivered deltas: native view.subscribe events (delivered, not text)
	const opened = openedBySession.get("r1");
	if (opened) opened.view.subscribe(() => {
		deliveredDeltas += 1;
	});

	// rendered TTY presentation (outer replays finite keystrokes)
	let presentationDisconnected = false;
	const presentationLeg = {
		...toThinClient(client, "r1"),
		async close(): Promise<void> {
			presentationDisconnected = true;
		},
	};
	const presentation = createThinPresentation({ create: () => presentationLeg, pollMs: 200 });
	const tui = new TuiMainScreen(new ProcessTerminal(), false, tmpdir());
	tui.addChild(presentation.component);
	tui.setFocus(presentation.component);
	tui.start();
	const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	// active signal/outcome: real turn factory entered, then abort outcome
	const pendingTurn = client.submit("turn one").then(
		(result) => (JSON.stringify(result ?? null).includes("ok") ? "settled" : "settled-no-ok"),
		() => "settled-error",
	);
	for (let i = 0; i < 100 && activeBarrierEntered < 1; i++) await wait(100);
	hard("active-turn", activeBarrierEntered >= 1, "turn factory entered (active signal)");
	const abortResult = await client.abort().then(
		() => "ok",
		(error: unknown) => String(error instanceof Error ? error.message : error),
	);
	const settled = await Promise.race([pendingTurn, wait(8000).then(() => "TIMEOUT")]);
	hard("active-cancel", cancelObserved && settled !== "TIMEOUT", `abort observed at turn factory + outcome settled (abort=${abortResult})`);
	releaseBarrier?.();
	hard("input", settled === "settled", "controller accepted input ({ok:true})");

	// stream/deltas: DELIVERED subscribe events before settle (not text)
	hard("stream", deliveredDeltas > 0, `view.subscribe delivered ${deliveredDeltas} delta events before settle`);

	// tool: NATIVE executed tool result entry (EntryRecord-shaped), not text search
	try {
		await client.submit("turn two");
		const view2 = opened?.view.current() as unknown as { conversation?: { entries?: unknown[] } } | undefined;
		const entries = JSON.stringify(view2?.conversation?.entries ?? []);
		const hasToolCall = entries.includes("toolCall") || entries.includes('"toolName"');
		const hasToolResult = /"role"\s*:\s*"toolResult"/.test(entries) && entries.includes("tool-ran");
		hard("tool", hasToolCall && hasToolResult, "native toolCall + executed toolResult entries in conversation view");
	} catch (error) {
		mark("tool", `pending:${String(error instanceof Error ? error.message : error).slice(0, 60)}`);
	}

	// input content: native user entry in the conversation view (independent)
	try {
		const conv = opened?.view.current() as unknown as { conversation?: { entries?: unknown[] } } | undefined;
		const entries = JSON.stringify(conv?.conversation?.entries ?? []);
		hard("input-content", entries.includes("turn one") || entries.includes("turn two"), "native user entry carries the input content");
	} catch (error) {
		mark("input-content", `pending:${String(error instanceof Error ? error.message : error).slice(0, 60)}`);
	}

	// close + finite PTY close/re-attach + release/rehydrate history
	client.close();
	const postClose = await client.submit("late").then(
		() => "NO-ERROR",
		(error: unknown) => String(error instanceof Error ? error.message : error),
	);
	hard("close", postClose.includes("closed"), "post-close submit rejected");
	for (let i = 0; i < 20 && !presentationDisconnected; i++) await wait(250);
	hard("pty-close", presentationDisconnected, "finite PTY keystroke disconnect observed");
	try {
		const second = await open("r1");
		const record2 = await second.residency();
		hard("re-attach", record2.cwd === record.cwd && record2.nativeSessionId === record.nativeSessionId, "same cwd + native session across release/reopen");
		await second.submit("turn three");
		const conv3 = opened?.view.current() as unknown as { conversation?: { entries?: unknown[] } } | undefined;
		const entries3 = JSON.stringify(conv3?.conversation?.entries ?? []);
		hard("history", entries3.includes("turn-three-reply") && entries3.includes("turn two"), "native conversation retains exact history across release/reopen");
	} catch (error) {
		mark("history", `pending:${String(error instanceof Error ? error.message : error).slice(0, 60)}`);
	}

	tui.stop();
	presentation.dispose();
	await residency.close().catch(() => undefined);
	const pending = [...surfaces.entries()].filter(([, state]) => state !== "pass");
	process.stdout.write(pending.length === 0 ? "[verdict] ALL-PASS-CANDIDATE\n" : `[verdict] PENDING (${pending.map(([name]) => name).join(",")})\n`);
	process.exit(pending.length === 0 ? 0 : 4);
}

function digest(path: string): string {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return "UNREADABLE";
	}
}

function outer(): void {
	const self = fileURLToPath(import.meta.url);
	const outDir = process.env.THIN_RESIDENCY_ARTIFACTS ?? join(tmpdir(), "thin-residency-artifacts");
	mkdirSync(outDir, { recursive: true });
	const capture = join(outDir, "pty-capture.log");
	// Native config isolation via PI_CODING_AGENT_DIR (config getAgentDir) —
	// explicit synthetic auth/model files only; no real user config touched.
	const agentDir = join(outDir, "agent-config");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				faux: { api: "faux", apiKey: "faux-key", baseUrl: "http://127.0.0.1:0", models: [{ id: "faux-1", name: "Faux", input: ["text"], contextWindow: 128000, maxTokens: 8192 }] },
			},
		}),
	);
	const child = spawn("script", ["-qec", 'exec node --experimental-strip-types "$THIN_ACCEPT_SELF"', capture], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, THIN_ACCEPT_INNER: "1", THIN_ACCEPT_SELF: self },
		stdio: ["pipe", "inherit", "inherit"],
	});
	const steps: Array<[number, string]> = [
		[1200, "hello residency\r"],
		[1500, "\x1b"],
		[1200, "again\r"],
		[1500, "exit\r"],
	];
	let at = 800;
	for (const [delay, keys] of steps) {
		at += delay;
		setTimeout(() => child.stdin.write(keys), at);
	}
	child.on("exit", (code) => {
		let captureText = "";
		try {
			captureText = readFileSync(capture, "utf8");
		} catch {
			process.stdout.write("[proof] FAIL: pty-capture.log not written\n");
			process.exit(3);
		}
		const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		const imports: Record<string, string> = {};
		for (const specifier of ["@earendil-works/pi-client", "@earendil-works/pi-ai/compat", "@earendil-works/pi-server", "@earendil-works/pi-tui", "./runtime.ts", "./shared-host-dispatch.ts", "./thin-residency-binding.ts", "./thin-presentation.ts"]) {
			try {
				const resolved = fileURLToPath(import.meta.resolve(specifier));
				imports[specifier] = `${resolved} sha256=${digest(resolved)}`;
			} catch {
				imports[specifier] = "UNRESOLVED";
			}
		}
		const innerPid = /\[census\] inner-pid=(\d+)/.exec(captureText)?.[1] ?? "unknown";
		const verdictLine = /\[verdict\] ([A-Z-]+)/.exec(captureText)?.[1] ?? "NONE";
		const surfaceStates = [...captureText.matchAll(/\[surface\] ([a-z-]+)=([^\s(]+)/g)].map((match) => `${match[1]}=${match[2]}`);
		writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify({ measuredHead: head, imports, pidCensus: { innerPid, driverPid: process.pid, scriptExitCode: code }, keystrokesReplayed: steps.map(([, keys]) => JSON.stringify(keys)), surfaces: surfaceStates, verdict: verdictLine }, null, 2)}\n`);
		copyFileSync(capture, join(outDir, "pty-capture.log"));
		process.stdout.write(`[proof] artifacts: ${outDir}/manifest.json + pty-capture.log (measured)\n`);
		if (verdictLine === "ALL-PASS-CANDIDATE" && code === 0) {
			process.stdout.write("thin-residency-acceptance: ALL PASS\n");
			process.exit(0);
		}
		process.stdout.write(`thin-residency-acceptance: PENDING/FAIL (verdict=${verdictLine} code=${code})\n`);
		process.exit(code === 3 ? 3 : 4);
	});
}

if (process.env.THIN_ACCEPT_INNER === "1" || process.stdout.isTTY) {
	process.stdout.write(`[census] inner-pid=${process.pid}\n`);
	void inner().catch((error: unknown) => {
		process.stderr.write(`thin-residency-acceptance: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
		process.stdout.write("[verdict] FAIL\n");
		process.exit(3);
	});
} else {
	outer();
}
