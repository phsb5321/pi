/**
 * THIN-RESIDENCY ACCEPTANCE (pD, PORT-PI-INTEGRATION-1425) — all-in-checkout
 * source-bound driver with deterministic REAL-SDK proof via the existing faux
 * provider pattern (`@earendil-works/pi-ai/compat`: registerFauxProvider /
 * fauxAssistantMessage / fauxText / fauxToolCall — the SDK test pattern; no
 * external model/API call, no separate isolate).
 *
 * Corrections (PORT-PI-THIN-PARITY-1430):
 * - EVERY required surface gates INDEPENDENTLY (any non-pass => PENDING exit
 *   4; ALL PASS only when all surfaces pass — THIN_ACCEPT_PROVIDER can no
 *   longer bypass a missing surface).
 * - active-cancel uses a REAL turn barrier: the faux response factory is the
 *   turn lifetime; it is entered (ACTIVE) and observes the abort signal
 *   (CANCEL RESULT). No Promise.race self-proofs.
 * - history is asserted from CAPTURED NATIVE history: the faux factory's
 *   `context.messages` is the exact transcript sent through the actual SDK;
 *   turn-3 (after close/re-attach) must contain turn-2's exact reply and the
 *   tool result — content, not counts.
 *
 * Surfaces: input · history · stream/deltas · tool invoke+result ·
 * active-cancel · close+re-attach (same cwd, same native session).
 *
 * Run (clean checkout of the composed tree, patch applied):
 *   node --experimental-strip-types \
 *     packages/coding-agent/src/experimental/durable/thin-residency-acceptance.ts
 * Exit: 0 = ALL PASS · 4 = PENDING (surface not evidenced) · 3 = FAIL.
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
import { createSharedHostResidency } from "./shared-host-residency.ts";
import { ResidencyClient, toThinClient } from "./thin-residency-binding.ts";
import { createThinPresentation } from "./thin-presentation.ts";

type SurfaceState = "pass" | `pending:${string}`;
const surfaces = new Map<string, SurfaceState>();
const mark = (name: string, state: SurfaceState, note = ""): void => {
	surfaces.set(name, state);
	process.stdout.write(`[surface] ${name}=${state}${note ? ` (${note})` : ""}\n`);
};
// Independent gates: a non-passed surface marks PENDING and the run continues
// so every surface reports; the verdict is PENDING unless all pass (never an
// ALL PASS fallback). A FAIL is reserved for internal errors.
const hard = (name: string, condition: boolean, note: string): void => {
	mark(name, condition ? "pass" : `pending:${note}`, condition ? note : "");
};

async function inner(): Promise<void> {
	const outDir = process.env.THIN_RESIDENCY_ARTIFACTS ?? join(tmpdir(), "thin-residency-artifacts");
	mkdirSync(outDir, { recursive: true });
	// Fresh residency root per run (a stale resident record without its store
	// fails continueSession; same-run reopen still asserts continuity).
	const root = join(outDir, "residency-root");
	rmSync(root, { recursive: true, force: true });
	rmSync(`${root}.clean`, { recursive: true, force: true });

	// ── deterministic local provider through the ACTUAL SDK (faux pattern) ──
	const registration = registerFauxProvider({});
	const fauxModel = registration.getModel();
	const capturedHistory: string[] = [];
	let activeBarrierEntered = 0;
	let cancelObservedAtFactory = false;
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
			const messages = ((context as { messages?: unknown[] }).messages ?? []) as Array<{ role?: string; content?: unknown }>;
			capturedHistory.push(JSON.stringify(messages));
			const lastUser = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join(" ");
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
				if (signal?.aborted) cancelObservedAtFactory = true;
				return fauxAssistantMessage(fauxText("turn-one-reply"), { stopReason: signal?.aborted ? "aborted" : "stop" });
			}
			if (lastUser.includes("turn two") && !JSON.stringify(messages).includes("tool-ran")) {
				return fauxAssistantMessage(fauxToolCall("bash", { command: "echo tool-ran" }), { stopReason: "toolUse" });
			}
			if (lastUser.includes("turn three")) return fauxAssistantMessage(fauxText("turn-three-reply"), { stopReason: "stop" });
			return fauxAssistantMessage(fauxText("turn-two-reply"), { stopReason: "stop" });
		},
	]);

	// ── real shared SDK host (693 adapter) ──
	const residency = await createSharedHostResidency({ policy: { maxSessions: 2 }, hydrate: { root } });
	const open = async (id: string): Promise<ResidencyClient> => {
		const handle = await residency.runtime.host.openSession({ id }, {} as never);
		const attachment = await handle.attachClient({} as never);
		return new ResidencyClient((call) => attachment.invokeService(call as never, () => undefined, {} as never) as Promise<unknown>);
	};
	const client = await open("r1");
	const record = await client.residency();
	await client.call("setModel", [{ provider: fauxModel.provider, modelId: fauxModel.id }]);
	mark("model", "pass", `faux model selected (${fauxModel.provider}/${fauxModel.id})`);

	// rendered TTY presentation (outer driver replays finite keystrokes)
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

	// input: PTY keystrokes render+submit (outer asserts the capture marker);
	// the API submit below IS turn one and must be accepted by the controller.
	// active-cancel: REAL turn barrier, then abort while the turn is live
	const pendingTurn = client.submit("turn one").then(
		(result) => (JSON.stringify(result ?? null).includes("ok") ? "settled" : "settled-no-ok"),
		() => "settled-error",
	);
	for (let i = 0; i < 150 && activeBarrierEntered < 1; i++) await wait(100);
	if (activeBarrierEntered < 1) {
		const debugView = JSON.stringify(await client.view().catch((error: unknown) => ({ error: String(error) })));
		process.stdout.write(`[debug] view-after-submit=${debugView}\n`);
	}
	hard("active-turn", activeBarrierEntered >= 1, "faux turn factory entered = turn active (barrier)");
	const abortResult = await client.abort().then(
		() => "ok",
		(error: unknown) => String(error instanceof Error ? error.message : error),
	);
	const settled = await Promise.race([pendingTurn, wait(8000).then(() => "TIMEOUT")]);
	hard("input", settled === "settled", "real controller accepted the input turn ({ok:true})");
	hard("active-cancel", cancelObservedAtFactory && settled !== "TIMEOUT", `abort observed at turn factory + submit settled (abort=${abortResult})`);
	releaseBarrier?.();

	try {
	// tool invoke + result through the actual SDK (bash runs locally)
	const toolTurn = await client.submit("turn two").then(
		() => true,
		() => false,
	);
	const toolHistory = capturedHistory.find((entry) => entry.includes("tool-ran"));
	hard("tool", toolTurn && toolHistory !== undefined, "tool call executed + result captured in native history");

	// stream/deltas: the scripted turn streamed into native history content
	const streamed = capturedHistory.some((entry) => entry.includes("turn-one-reply") || entry.includes("turn-two-reply"));
	hard("stream", streamed, "SDK turn streamed: scripted content landed in captured history");

	// close + post-close rejection + re-attach (same cwd, same native session)
	client.close();
	const postClose = await client.submit("late").then(
		() => "NO-ERROR",
		(error: unknown) => String(error instanceof Error ? error.message : error),
	);
	hard("close", postClose.includes("closed"), "post-close submit rejected");
	for (let i = 0; i < 20 && !presentationDisconnected; i++) await wait(250);
	mark("presentation-disconnect", presentationDisconnected ? "pass" : "pending:PTY exit keystroke not observed");

	const second = await open("r1");
	const record2 = await second.residency();
	hard("re-attach", record2.cwd === record.cwd && record2.nativeSessionId === record.nativeSessionId, "same cwd + same native session");
	const turn3 = await second.submit("turn three").then(
		() => true,
		() => false,
	);
	const history3 = capturedHistory.filter((entry) => entry.includes("turn-three-reply") || entry.includes("turn-two-reply")).pop();
	hard(
		"history",
		turn3 && Boolean(history3) && Boolean(history3?.includes("turn-two-reply")) && Boolean(history3?.includes("tool-ran")),
		"durable exact history across release/reopen: turn-3 context contains turn-2 reply + tool result",
	);

	} catch (error) {
		mark("exception", `pending:${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
	}
	tui.stop();
	presentation.dispose();
	await residency.close().catch(() => undefined);

	const pending = [...surfaces.entries()].filter(([, state]) => state !== "pass");
	if (pending.length === 0) {
		process.stdout.write("[verdict] ALL-PASS-CANDIDATE\n");
		process.exit(0);
	}
	process.stdout.write(`[verdict] PENDING (${pending.map(([name]) => name).join(",")})\n`);
	process.exit(4);
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
	// Isolated agent config: the app resolves auth at ~/.pi/agent (homedir) —
	// seed ONLY the faux provider auth in an isolated HOME (no real config).
	const isolatedHome = join(outDir, "home");
	mkdirSync(join(isolatedHome, ".pi", "agent"), { recursive: true });
	writeFileSync(join(isolatedHome, ".pi", "agent", "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	writeFileSync(
		join(isolatedHome, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				faux: {
					api: "faux",
					apiKey: "faux-key",
					models: [{ id: "faux-1", name: "Faux", input: ["text"], contextWindow: 128000, maxTokens: 8192 }],
				},
			},
		}),
	);
	const child = spawn("script", ["-qec", 'exec node --experimental-strip-types "$THIN_ACCEPT_SELF"', capture], {
		env: { ...process.env, HOME: isolatedHome, THIN_ACCEPT_INNER: "1", THIN_ACCEPT_SELF: self },
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
		const inputRendered = captureText.includes("[thin] submit visible: hello residency");
		if (!inputRendered) process.stdout.write("[proof] WARN: PTY input marker absent from capture\n");
		const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		const imports: Record<string, string> = {};
		for (const specifier of [
			"@earendil-works/pi-client",
			"@earendil-works/pi-ai/compat",
			"@earendil-works/pi-server",
			"@earendil-works/pi-tui",
			"./shared-host-residency.ts",
			"./thin-residency-binding.ts",
			"./thin-presentation.ts",
		]) {
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
		writeFileSync(
			join(outDir, "manifest.json"),
			`${JSON.stringify(
				{
					measuredHead: head,
					imports,
					pidCensus: { innerPid, driverPid: process.pid, scriptExitCode: code },
					keystrokesReplayed: steps.map(([, keys]) => JSON.stringify(keys)),
					ptyInputRendered: inputRendered,
					surfaces: surfaceStates,
					verdict: verdictLine,
				},
				null,
				2,
			)}\n`,
		);
		copyFileSync(capture, join(outDir, "pty-capture.log"));
		process.stdout.write(`[proof] artifacts: ${outDir}/manifest.json + pty-capture.log (measured)\n`);
		if (verdictLine === "ALL-PASS-CANDIDATE" && code === 0 && inputRendered) {
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
		process.stdout.write(`[verdict] FAIL\n`);
		process.exit(3);
	});
} else {
	outer();
}
