/** One bounded goal on an exclusively owned SDK session. No provider selection or shell execution. */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentSession } from "../../src/core/agent-session.ts";

export interface GoalTask {
	id: string;
	goal: string;
	sourceSha: string;
	acceptanceIds: string[];
	maxAttempts: number;
	deadline: number;
	dependencies?: { taskId: string; expectedSha: string }[];
}

export interface GoalEvaluation {
	verdict: "verified" | "rejected" | "unknown";
	taskId: string;
	sha: string;
	reason: string;
	failureKey: string | null;
	progressChanged: boolean | null;
	repeatedFailure: boolean;
}

export interface GoalCheck {
	/** Independently obtained current head, not a worker-supplied SHA. */
	sourceSha: string;
	oracle: unknown;
	receipt: unknown;
	evidenceRoot: string;
	progress: string;
	evidencePaths: string[];
}

export interface GoalAdapters {
	buildContextPacket(input: {
		goal: string;
		sourceSha: string;
		acceptanceIds: string[];
		progress: string;
		evidencePaths: string[];
		failure?: string;
		maxChars: number;
	}): string;
	chooseWorkerAction(input: {
		signals: unknown;
		attempt: number;
		maxAttempts: number;
		deadlineExceeded: boolean;
		lastFailure: { kind: "executable" } | null;
		progressChanged: boolean;
	}): { action: "run" | "repair" | "checkpoint" | "escalate" | "stop"; reason: string };
	evaluateAttempt(input: {
		expectedSha: string;
		requiredChecks: string[];
		taskId: string;
		oracle: unknown;
		receipt: unknown;
		evidenceRoot: string;
		dependencies: { taskId: string; expectedSha: string }[];
		previous?: GoalEvaluation;
	}): Promise<GoalEvaluation>;
	summarizeUsage(entries: unknown[], window: { startInclusive: string; endExclusive: string }): unknown;
}

interface Checkpoint {
	binding: string;
	attempt: number;
	phase: "ready" | "acting" | "checking" | "verified" | "stopped";
	progress: string;
	failure?: string;
	evidencePaths: string[];
	sourceSha: string;
	evaluation?: GoalEvaluation;
}

const entryType = "pi.bounded-goal.v0";

export async function runBoundedGoal(options: {
	session: AgentSession;
	task: GoalTask;
	adapters: GoalAdapters;
	/** Fresh normalized throttle-lanes data. Unknown availability must fail closed in the adapter. */
	readSignals: () => unknown;
	/** Positive account eligibility from an existing host credential observer; a nominal 0% meter is insufficient. */
	readEligibility: () => boolean | undefined;
	/** Prepare host-only readSha/check capabilities for p2J. Bind signal in each abort-aware callback. */
	check: (signal: AbortSignal) => Promise<GoalCheck>;
	/** Host-normalized records for p2D, not transcript strings or estimated token counts. */
	readUsage: () => unknown[];
	maxContextChars?: number;
}): Promise<{ status: "verified" | "checkpoint"; reason: string; attempts: number; usage: unknown }> {
	const { session, task, adapters } = options;
	if (
		!task.id ||
		!task.goal ||
		!/^[a-f0-9]{40}$/.test(task.sourceSha) ||
		!task.acceptanceIds.length ||
		new Set(task.acceptanceIds).size !== task.acceptanceIds.length ||
		!Number.isSafeInteger(task.maxAttempts) ||
		task.maxAttempts < 1 ||
		!Number.isSafeInteger(task.deadline)
	)
		throw new Error("Invalid bounded goal");
	const manager = session.sessionManager;
	const file = manager.getSessionFile();
	if (!file) throw new Error("A persistent, dedicated session is required");
	const lockPath = join(realpathSync(dirname(file)), `${basename(file)}.bounded-goal.lock`);
	// Never steal a stale-looking lock: an interrupted external effect requires reconciliation.
	const lock = openSync(lockPath, "wx", 0o600);
	let pending = false;
	const startedMs = Date.now();
	const started = new Date(startedMs).toISOString();
	const controller = new AbortController();
	const retry = session.autoRetryEnabled;
	const binding = createHash("sha256").update(JSON.stringify(task)).digest("hex");
	let state: Checkpoint = {
		binding,
		attempt: 0,
		phase: "ready",
		progress: "",
		evidencePaths: [],
		sourceSha: task.sourceSha,
	};
	const save = () => {
		manager.appendCustomEntry(entryType, { ...state });
		const fd = openSync(file, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	};
	const finish = (reason: string, verified = false) => ({
		status: verified ? ("verified" as const) : ("checkpoint" as const),
		reason,
		attempts: state.attempt,
		usage: adapters.summarizeUsage(options.readUsage(), {
			startInclusive: started,
			endExclusive: new Date(Math.max(startedMs + 1, Date.now())).toISOString(),
		}),
	});
	const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (Date.now() >= task.deadline) throw new Error("deadline");
		let timer: ReturnType<typeof setTimeout> | undefined;
		pending = true;
		try {
			return await Promise.race([
				operation().finally(() => {
					pending = false;
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => {
							controller.abort();
							void session.abort();
							reject(new Error("deadline"));
						},
						Math.min(task.deadline - Date.now(), 2_147_483_647),
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		writeFileSync(lock, JSON.stringify({ pid: process.pid, session: manager.getSessionId(), task: task.id }));
		fsyncSync(lock);
		if (!session.isIdle) throw new Error("Session is busy; it was not interrupted");
		const entries = manager.getBranch();
		const saved = entries.findLast((entry) => entry.type === "custom" && entry.customType === entryType);
		if (saved?.type === "custom") {
			const candidate = saved.data as Checkpoint;
			if (
				candidate?.binding !== binding ||
				!Number.isSafeInteger(candidate.attempt) ||
				candidate.attempt < 0 ||
				!["ready", "acting", "checking", "verified", "stopped"].includes(candidate.phase)
			) {
				throw new Error("Checkpoint does not match the immutable task/bounds");
			}
			state = { ...candidate };
			if (state.phase === "acting") return finish("uncertain-effect: reconcile before resume");
			if (state.phase === "stopped") return finish(state.failure ?? "stopped");
		} else {
			// Native SessionManager persists setup entries only after the first conversation message.
			manager.appendMessage({ role: "user", content: task.goal, timestamp: Date.now() });
			save();
		}
		session.setAutoRetryEnabled(false);
		while (true) {
			if (Date.now() >= task.deadline) return finish("deadline");
			// A recorded completed prompt is never re-issued. Even a saved success needs fresh checks.
			if (state.phase !== "checking" && state.phase !== "verified") {
				if (state.attempt >= task.maxAttempts) return finish("attempt-limit");
				const eligibility = options.readEligibility?.();
				if (eligibility !== true)
					return finish(eligibility === false ? "host-ineligible" : "host-eligibility-unknown");
				const action = adapters.chooseWorkerAction({
					signals: options.readSignals(),
					attempt: state.attempt,
					maxAttempts: task.maxAttempts,
					deadlineExceeded: false,
					lastFailure: state.failure ? { kind: "executable" } : null,
					progressChanged: state.evaluation?.progressChanged ?? true,
				});
				if (action.action !== "run" && action.action !== "repair") return finish(action.reason);
				const prompt = adapters.buildContextPacket({
					goal: task.goal,
					sourceSha: state.sourceSha,
					acceptanceIds: task.acceptanceIds,
					progress: state.progress,
					evidencePaths: state.evidencePaths,
					failure: state.failure,
					maxChars: options.maxContextChars ?? 8000,
				});
				state.attempt++;
				state.phase = "acting";
				save();
				await bounded(() => session.prompt(prompt));
				state.phase = "checking";
				save();
				const last = session.messages.findLast((message) => message.role === "assistant");
				if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
					state.phase = "stopped";
					state.failure = "provider-error-or-abort: refresh routing; no automatic retry";
					save();
					return finish(state.failure);
				}
			}
			const result = await bounded(() => options.check(controller.signal));
			if (Date.now() >= task.deadline) return finish("deadline");
			const verdict = await bounded(() =>
				adapters.evaluateAttempt({
					taskId: task.id,
					expectedSha: result.sourceSha,
					requiredChecks: task.acceptanceIds,
					oracle: result.oracle,
					receipt: result.receipt,
					evidenceRoot: result.evidenceRoot,
					dependencies: task.dependencies ?? [],
					previous: state.evaluation,
				}),
			);
			if (Date.now() >= task.deadline) return finish("deadline");
			state.sourceSha = result.sourceSha;
			state.progress = result.progress;
			state.evidencePaths = result.evidencePaths;
			state.evaluation = verdict;
			const verified = verdict.verdict === "verified";
			state.phase = verified ? "verified" : verdict.verdict === "unknown" ? "checking" : "ready";
			state.failure = verified ? undefined : verdict.reason;
			if (verdict.verdict === "rejected" && verdict.repeatedFailure) {
				state.phase = "stopped";
				state.failure = `nonprogress: ${state.failure}`;
			}
			save();
			if (verified) return finish("trusted checks passed", true);
			if (verdict.verdict === "unknown" || state.phase === "stopped") return finish(state.failure ?? "nonprogress");
		}
	} catch (error) {
		// Do not overwrite acting/checking: restart must reconcile an uncertain effect or recheck only.
		return finish(error instanceof Error ? error.message : "driver-error");
	} finally {
		if (!pending) session.setAutoRetryEnabled(retry);
		closeSync(lock);
		// A timed-out operation may ignore cancellation. Quarantine its session rather than overlap it.
		if (!pending) unlinkSync(lockPath);
	}
}
