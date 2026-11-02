import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCheckpoint,
	createSeatSleepExtension,
	parseThresholdMin,
	type SeatSleepConfig,
	seatSleepConfig,
	sleepBlocker,
	takeDraftFile,
	writeCheckpointFiles,
} from "../src/core/seat-sleep.ts";

const STUB = resolve(import.meta.dirname, "../src/modes/interactive/assets/seat-sleep-stub.sh");
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-seat-sleep-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ARMED_ENV = {
	PI_SEAT_SLEEP_MIN: "45",
	PI_SEAT_SLEEP_LAUNCHER: "1",
	PI_SEAT_SLEEP_CHECKPOINT: "/tmp/x.json",
	HERDR_PANE_ID: "w28:p2J",
};

describe("seat sleep arming", () => {
	it("is off unless every clause holds", () => {
		expect(parseThresholdMin(undefined)).toBe(0);
		expect(parseThresholdMin("")).toBe(0);
		expect(parseThresholdMin("0")).toBe(0);
		expect(parseThresholdMin("-5")).toBe(0);
		expect(parseThresholdMin("abc")).toBe(0);
		expect(parseThresholdMin("0.01")).toBe(0); // below the test floor
		expect(parseThresholdMin("45")).toBe(45);

		expect(seatSleepConfig({}, "tui", true, true)).toBeNull();
		expect(seatSleepConfig(ARMED_ENV, "tui", true, true)).toMatchObject({ thresholdMin: 45 });
		// Without the resident launcher a sleep would close the pane, so it never arms.
		expect(seatSleepConfig({ ...ARMED_ENV, PI_SEAT_SLEEP_LAUNCHER: undefined }, "tui", true, true)).toBeNull();
		expect(seatSleepConfig({ ...ARMED_ENV, PI_SEAT_SLEEP_CHECKPOINT: undefined }, "tui", true, true)).toBeNull();
		expect(seatSleepConfig({ ...ARMED_ENV, HERDR_PANE_ID: undefined }, "tui", true, true)).toBeNull();
		expect(seatSleepConfig(ARMED_ENV, "rpc", true, true)).toBeNull();
		expect(seatSleepConfig(ARMED_ENV, "tui", false, true)).toBeNull();
		expect(seatSleepConfig(ARMED_ENV, "tui", true, false)).toBeNull();
	});

	it("registers nothing at all when off", () => {
		const saved = { ...process.env };
		for (const key of Object.keys(ARMED_ENV) as (keyof typeof ARMED_ENV)[]) delete process.env[key];
		try {
			const on = vi.fn();
			createSeatSleepExtension()({ on } as never);
			expect(on).not.toHaveBeenCalled();
		} finally {
			process.env = saved;
		}
	});

	it("arms only inside an interactive TUI session", () => {
		const saved = { ...process.env };
		Object.assign(process.env, ARMED_ENV);
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const onSleep = vi.fn();
			const pi = {
				on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
					handlers.set(event, handler);
					return () => {};
				},
			};
			createSeatSleepExtension({ onSleep })(pi as never);
			// Armed env: exactly one listener, the session_start gate. Nothing else is installed yet.
			expect([...handlers.keys()]).toEqual(["session_start"]);

			const ctx = {
				mode: "rpc",
				hasUI: true,
				isIdle: () => true,
				hasPendingMessages: () => false,
				ui: { getEditorText: () => "", setEditorText: () => {} },
			};
			handlers.get("session_start")?.({}, ctx);
			expect([...handlers.keys()]).toEqual(["session_start"]);
			expect(onSleep).not.toHaveBeenCalled();
		} finally {
			process.env = saved;
		}
	});
});

describe("sleep decision", () => {
	const base = {
		now: 1_000_000,
		lastActivity: 1_000_000 - 46 * 60_000,
		thresholdMin: 45,
		idle: true,
		pendingMessages: false,
		toolsRunning: 0,
		draft: "",
	};

	it("sleeps only when nothing can be lost", () => {
		expect(sleepBlocker(base)).toBeNull();
		expect(sleepBlocker({ ...base, thresholdMin: 0 })).toBe("disabled");
		expect(sleepBlocker({ ...base, idle: false })).toBe("busy");
		expect(sleepBlocker({ ...base, pendingMessages: true })).toBe("pending-messages");
		expect(sleepBlocker({ ...base, toolsRunning: 1 })).toBe("tool-running");
		expect(sleepBlocker({ ...base, draft: "half typed" })).toBe("draft");
		expect(sleepBlocker({ ...base, lastActivity: base.now - 60_000 })).toBe("not-idle-long-enough");
	});
});

describe("checkpoint files", () => {
	const config: SeatSleepConfig = { thresholdMin: 45, checkpointPath: "", paneId: "w28:p2J" };

	it("writes the checkpoint and a shell-quoted wake file", () => {
		const dir = tempDir();
		const path = join(dir, "w28-p2J.json");
		const checkpoint = buildCheckpoint(
			{ ...config, checkpointPath: path },
			{ cwd: "/home/o'brien/project", sessionFile: "/s/a b.jsonl", model: "zai/glm-5.3", thinking: "high" },
			"1234-1",
			"2026-11-01T00:00:00.000Z",
		);
		writeCheckpointFiles(path, checkpoint);

		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ runId: "1234-1", paneId: "w28:p2J" });
		expect(existsSync(`${path}.wake`)).toBe(true);
		// The stub sources this file; the values must survive spaces and single quotes.
		const printed = execFileSync(
			"bash",
			[
				"-c",
				`. "$1"; printf '%s\\n' "$PI_WAKE_SESSION_FILE"; printf '%s\\n' "$PI_WAKE_MODEL:$PI_WAKE_THINKING"`,
				"_",
				`${path}.wake`,
			],
			{ encoding: "utf8" },
		);
		expect(printed.trim().split("\n")).toEqual(["/s/a b.jsonl", "zai/glm-5.3:high"]);
	});

	it("reads a stashed draft once", () => {
		const dir = tempDir();
		const path = join(dir, "draft");
		writeFileSync(path, "/name x");
		expect(takeDraftFile(path)).toBe("/name x");
		expect(takeDraftFile(path)).toBeNull();
	});
});

describe("stub", () => {
	interface Run {
		status: number;
		args: string[];
		env: { draft: string; draftPath?: string };
	}

	function wake(options: {
		prompt: string;
		sessionExists: boolean;
		runId?: string;
		envRunId?: string;
		writeCheckpoint?: boolean;
	}): Run {
		const dir = tempDir();
		const bin = join(dir, "bin");
		execFileSync("mkdir", ["-p", bin]);
		const sessionFile = join(dir, "session.jsonl");
		if (options.sessionExists) writeFileSync(sessionFile, "{}\n");
		const checkpoint = join(dir, "seat.json");
		if (options.writeCheckpoint !== false) {
			writeCheckpointFiles(checkpoint, {
				v: 1,
				runId: options.runId ?? "run-1",
				paneId: "w28:p2J",
				cwd: dir,
				sessionFile,
				model: "zai/glm-5.3",
				thinking: "high",
				at: "2026-11-01T00:00:00.000Z",
			});
		}
		// Fake pi: record argv (NUL-separated) and the draft env, so the test sees exactly what the stub hands over.
		const argsFile = join(dir, "args.bin");
		const draftFile = join(dir, "draft.txt");
		writeFileSync(
			join(bin, "pi"),
			[
				"#!/usr/bin/env bash",
				'printf "%s\\0" "$@" > "$PI_TEST_ARGS"',
				'printenv PI_SEAT_SLEEP_DRAFT_FILE > "$PI_TEST_DRAFT" || true',
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "pi"), 0o755);

		const env = {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			HOME: dir,
			PI_SEAT_SLEEP_PI: join(bin, "pi"),
			PI_TEST_ARGS: argsFile,
			PI_TEST_DRAFT: draftFile,
			...(options.envRunId ? { PI_SEAT_SLEEP_RUN_ID: options.envRunId } : {}),
		};
		const output = execFileSync("bash", [STUB, "--checkpoint", checkpoint], {
			input: options.prompt,
			encoding: "utf8",
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		void output;
		const raw = existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "";
		const argv = raw === "" ? [] : raw.split("\0").slice(0, -1);
		// The stub hands over a PATH to the draft; the text is in that file.
		const draftPath = existsSync(draftFile) ? readFileSync(draftFile, "utf8").trim() : "";
		const draft = draftPath && existsSync(draftPath) ? readFileSync(draftPath, "utf8") : "";
		return { status: 0, args: argv, env: { draft, draftPath } };
	}

	it("resumes the exact checkpoint session and carries plain text in argv", () => {
		const result = wake({ prompt: "wake up\n", sessionExists: true });
		expect(result.args).toEqual([
			"--session",
			expect.stringContaining("session.jsonl"),
			"--model",
			"zai/glm-5.3:high",
			"wake up",
		]);
	});

	it("falls back to --continue when the session file is gone", () => {
		const result = wake({ prompt: "hello\n", sessionExists: false });
		expect(result.args).toEqual(["--continue", "--model", "zai/glm-5.3:high", "hello"]);
	});

	it("hands a bracketed multi-line paste over as one prompt", () => {
		const result = wake({ prompt: "\x1b[200~line one\nline two\x1b[201~\r", sessionExists: true });
		expect(result.args.at(-1)).toBe("line one\nline two");
		expect(result.args.filter((arg) => arg.startsWith("line one"))).toHaveLength(1);
	});

	it("leaves a slash or dash wake line in the editor instead of argv", () => {
		const slash = wake({ prompt: "/name new-name\n", sessionExists: true });
		expect(slash.args.join(" ")).not.toContain("/name");
		expect(slash.env.draftPath).toContain(".draft");
		expect(slash.env.draft).toBe("/name new-name");
		const dash = wake({ prompt: "--model x\n", sessionExists: true });
		expect(dash.args.join(" ")).not.toContain("--model x");
		expect(dash.env.draft).toBe("--model x");
	});

	it("does nothing when the checkpoint belongs to another run", () => {
		expect(wake({ prompt: "hi\n", sessionExists: true, runId: "run-1", envRunId: "run-2" }).args).toEqual([]);
	});

	it("does nothing without a checkpoint", () => {
		expect(wake({ prompt: "hi\n", sessionExists: true, writeCheckpoint: false }).args).toEqual([]);
	});
});
