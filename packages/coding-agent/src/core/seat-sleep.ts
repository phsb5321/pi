/**
 * Idle-seat sleep — the in-process half. DEFAULT OFF.
 *
 * An idle pi seat costs ~150 MiB whether it is working or has been idle for hours (census 01/11/2026: median
 * 148.4 MiB whole subtree, 35.6 GiB over 248 seats). Nothing inside the process can return that memory, so the
 * lever is not having the process: after `PI_SEAT_SLEEP_MIN` minutes of nothing happening this module writes a
 * checkpoint and shuts pi down. A resident launcher then hands the pane to the stub
 * (`modes/interactive/assets/seat-sleep-stub.sh`), which wakes pi on the first line typed into the pane.
 *
 * Armed means all of: `PI_SEAT_SLEEP_MIN` > 0, `PI_SEAT_SLEEP_CHECKPOINT` set by a resident launcher,
 * `PI_SEAT_SLEEP_LAUNCHER=1` (that launcher is really there), a herdr pane id, and an interactive TUI on a tty.
 * Anything else returns before registering a listener or a timer: the feature is inert and cannot wake itself.
 *
 * The wake path prefers the checkpoint's exact session file. `pi --continue` is only the fallback for when that
 * file is gone, because `--continue` is cwd-scoped and latest-wins: another pi that ran in the same directory
 * after the seat slept would be resumed instead.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "./extensions/types.ts";

export const MIN_THRESHOLD_MIN = 0.05; // 3 s: test value only; the fleet value is minutes
export const MAX_POLL_MS = 15_000;

/** Parse the gate. Returns minutes, or 0 when sleep is OFF (unset, invalid, or below the test floor). */
export function parseThresholdMin(raw: string | undefined): number {
	if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw.trim())) {
		return 0;
	}
	const minutes = Number(raw.trim());
	return minutes >= MIN_THRESHOLD_MIN ? minutes : 0;
}

export interface SeatSleepConfig {
	thresholdMin: number;
	checkpointPath: string;
	paneId: string;
}

/**
 * The environment half of the arming predicate, available before any session exists. Every clause is a reason the
 * feature must stay off; when this returns null the extension registers no listener at all.
 */
export function seatSleepGate(env: NodeJS.ProcessEnv): SeatSleepConfig | null {
	const thresholdMin = parseThresholdMin(env.PI_SEAT_SLEEP_MIN);
	if (thresholdMin === 0) return null;
	if (env.PI_SEAT_SLEEP_LAUNCHER !== "1") return null; // no resident launcher: sleeping would close the pane
	const checkpointPath = env.PI_SEAT_SLEEP_CHECKPOINT;
	if (!checkpointPath) return null;
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return null;
	return { thresholdMin, checkpointPath, paneId };
}

/** The complete predicate: the gate plus an interactive TUI on a real terminal. */
export function seatSleepConfig(
	env: NodeJS.ProcessEnv,
	mode: string,
	hasUI: boolean,
	isTTY: boolean,
): SeatSleepConfig | null {
	const config = seatSleepGate(env);
	if (config === null) return null;
	if (mode !== "tui" || !hasUI || !isTTY) return null;
	return config;
}

export interface SleepInputs {
	now: number;
	lastActivity: number;
	thresholdMin: number;
	idle: boolean;
	pendingMessages: boolean;
	toolsRunning: number;
	draft: string;
}

/** Pure decision: null means "may sleep now", otherwise the blocking reason. */
export function sleepBlocker(inputs: SleepInputs): string | null {
	if (inputs.thresholdMin <= 0) return "disabled";
	if (!inputs.idle) return "busy";
	if (inputs.pendingMessages) return "pending-messages";
	if (inputs.toolsRunning > 0) return "tool-running";
	if (inputs.draft.trim() !== "") return "draft";
	if (inputs.now - inputs.lastActivity < inputs.thresholdMin * 60_000) return "not-idle-long-enough";
	return null;
}

export interface Checkpoint {
	v: 1;
	runId: string;
	paneId: string;
	cwd: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	at: string;
}

/** Single-quote a value for the stub's shell, which rebuilds argv from a file. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The stub reads this next to the checkpoint; it is the only source of the wake arguments. */
export function wakeFileText(checkpoint: Checkpoint): string {
	const lines = [
		`PI_WAKE_RUN_ID=${shellQuote(checkpoint.runId)}`,
		`PI_WAKE_SESSION_FILE=${shellQuote(checkpoint.sessionFile ?? "")}`,
		`PI_WAKE_MODEL=${shellQuote(checkpoint.model ?? "")}`,
		`PI_WAKE_THINKING=${shellQuote(checkpoint.thinking ?? "")}`,
		`PI_WAKE_CWD=${shellQuote(checkpoint.cwd)}`,
	];
	return `${lines.join("\n")}\n`;
}

/** Atomic write (tmp + rename) so the launcher never reads half a file. */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, { mode });
	renameSync(tmp, path);
}

/** Write the checkpoint and its wake file. Separate from the timer so a test can call it directly. */
export function writeCheckpointFiles(path: string, checkpoint: Checkpoint): void {
	writeFileAtomic(path, `${JSON.stringify(checkpoint)}\n`);
	writeFileAtomic(`${path}.wake`, wakeFileText(checkpoint));
}

/** Read and delete a wake draft left by the stub (a `/`- or `-`-leading line cannot ride in argv). */
export function takeDraftFile(path: string | undefined): string | null {
	if (!path) return null;
	try {
		const text = readFileSync(path, "utf8");
		unlinkSync(path);
		return text === "" ? null : text;
	} catch {
		return null;
	}
}

/** Everything the extension needs from the live session, so the decision path stays testable. */
export interface SleepContext {
	cwd: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
}

export function buildCheckpoint(config: SeatSleepConfig, context: SleepContext, runId: string, at: string): Checkpoint {
	return {
		v: 1,
		runId,
		paneId: config.paneId,
		cwd: context.cwd,
		sessionFile: context.sessionFile,
		model: context.model,
		thinking: context.thinking,
		at,
	};
}

export interface SeatSleepDeps {
	/** Test seam: called instead of writing files when the timer decides to sleep. */
	onSleep?: (config: SeatSleepConfig, checkpoint: Checkpoint) => void;
}

export function createSeatSleepExtension(deps: SeatSleepDeps = {}) {
	return function seatSleepExtension(pi: ExtensionAPI): void {
		// Inert before anything else: no gate, no listener.
		if (seatSleepGate(process.env) === null) return;
		pi.on("session_start", (_event, ctx) => {
			const config = seatSleepConfig(process.env, ctx.mode, ctx.hasUI, Boolean(process.stdin.isTTY));
			if (config === null) return;
			installSeatSleep(pi, ctx, config, deps);
		});
	};
}

function installSeatSleep(pi: ExtensionAPI, ctx: ExtensionContext, config: SeatSleepConfig, deps: SeatSleepDeps): void {
	// A draft the stub could not put in argv belongs in the editor, never in a submitted prompt.
	const draft = takeDraftFile(process.env.PI_SEAT_SLEEP_DRAFT_FILE);
	if (draft !== null) {
		ctx.ui.setEditorText(draft);
	}

	let lastActivity = Date.now();
	let toolsRunning = 0;
	const bump = () => {
		lastActivity = Date.now();
	};
	pi.on("agent_start", bump);
	pi.on("turn_start", bump);
	pi.on("message_start", bump);
	pi.on("model_select", bump);
	pi.on("agent_end", bump);
	pi.on("agent_settled", bump);
	pi.on("tool_execution_start", () => {
		toolsRunning++;
		bump();
	});
	pi.on("tool_execution_end", () => {
		toolsRunning = Math.max(0, toolsRunning - 1);
		bump();
	});

	let sleeping = false;
	const timer = setInterval(
		() => {
			if (sleeping) return;
			const blocker = sleepBlocker({
				now: Date.now(),
				lastActivity,
				thresholdMin: config.thresholdMin,
				idle: ctx.isIdle(),
				pendingMessages: ctx.hasPendingMessages(),
				toolsRunning,
				draft: ctx.ui.getEditorText(),
			});
			if (blocker !== null) return;
			sleeping = true;
			clearInterval(timer);
			const checkpoint = buildCheckpoint(
				config,
				{
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinking: ctx.thinkingLevel,
				},
				`${process.pid}-${Date.now()}`,
				new Date().toISOString(),
			);
			if (deps.onSleep) {
				deps.onSleep(config, checkpoint);
			} else {
				writeCheckpointFiles(config.checkpointPath, checkpoint);
			}
			ctx.shutdown();
		},
		Math.min(MAX_POLL_MS, Math.max(1_000, (config.thresholdMin * 60_000) / 2)),
	);
	timer.unref?.();
	pi.on("session_shutdown", () => clearInterval(timer));
}

export const seatSleepExtension = createSeatSleepExtension();
