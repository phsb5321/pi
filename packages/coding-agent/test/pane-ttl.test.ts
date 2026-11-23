import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPaneBusy, PaneTtl, type PaneTtlTimer, parsePaneTtl } from "../src/core/pane-ttl.ts";
import {
	expiryReceiptPath,
	readStartTicks,
	rosterStateRoot,
	writeExpiryReceipt,
} from "../src/core/pane-ttl-receipt.ts";

const MIN = 60_000;

/** A clock the test moves by hand, and an interval the test fires by hand. */
function fakeClock() {
	let now = 1_000_000;
	const ticks: Array<() => void> = [];
	return {
		now: () => now,
		schedule: (tick: () => void): PaneTtlTimer => {
			ticks.push(tick);
			return { cancel: () => ticks.splice(ticks.indexOf(tick), 1) };
		},
		advance(ms: number) {
			now += ms;
			for (const tick of [...ticks]) tick();
		},
		timers: () => ticks.length,
	};
}

function makeTtl(ttlMin: number, busy: { value: boolean }) {
	const clock = fakeClock();
	const expired: number[] = [];
	const ttl = new PaneTtl({
		ttlMs: ttlMin * MIN,
		isBusy: () => busy.value,
		onExpire: (idleMs) => expired.push(idleMs),
		now: clock.now,
		schedule: clock.schedule,
	});
	ttl.start();
	return { clock, expired, ttl };
}

describe("parsePaneTtl", () => {
	it("is off when unset or empty", () => {
		expect(parsePaneTtl({})).toEqual({});
		expect(parsePaneTtl({ PI_PANE_TTL_MIN: "" })).toEqual({});
		expect(parsePaneTtl({ PI_PANE_TTL_MIN: "  " })).toEqual({});
	});

	it("accepts positive minutes, including fractions", () => {
		expect(parsePaneTtl({ PI_PANE_TTL_MIN: "60" }).config).toEqual({ ttlMin: 60, ttlMs: 60 * MIN });
		expect(parsePaneTtl({ PI_PANE_TTL_MIN: "0.5" }).config?.ttlMs).toBe(30_000);
	});

	it("stays off and warns on junk, zero and negative values", () => {
		for (const raw of ["abc", "0", "-5", "NaN", "Infinity", "1h"]) {
			const parsed = parsePaneTtl({ PI_PANE_TTL_MIN: raw });
			expect(parsed.config).toBeUndefined();
			expect(parsed.warning).toContain("PI_PANE_TTL_MIN");
		}
	});
});

describe("PaneTtl with a fake clock", () => {
	it("expires after the quiet time and only once", () => {
		const { clock, expired } = makeTtl(10, { value: false });
		clock.advance(9 * MIN);
		expect(expired).toEqual([]);
		clock.advance(1 * MIN);
		expect(expired).toEqual([10 * MIN]);
		clock.advance(60 * MIN);
		expect(expired).toHaveLength(1);
		expect(clock.timers()).toBe(0);
	});

	it("resets on input", () => {
		const { clock, expired, ttl } = makeTtl(10, { value: false });
		clock.advance(9 * MIN);
		ttl.touch();
		clock.advance(9 * MIN);
		expect(expired).toEqual([]);
		clock.advance(1 * MIN);
		expect(expired).toEqual([10 * MIN]);
	});

	it("never expires during a long tool, and counts quiet time only from when the tool ends", () => {
		const busy = { value: true };
		const { clock, expired } = makeTtl(10, busy);
		clock.advance(3 * 60 * MIN);
		expect(expired).toEqual([]);
		busy.value = false;
		clock.advance(9 * MIN);
		expect(expired).toEqual([]);
		clock.advance(1 * MIN);
		expect(expired).toHaveLength(1);
	});

	it("never expires while a pending prompt or a draft keeps the pane busy", () => {
		const busy = { value: true };
		const { clock, expired } = makeTtl(1, busy);
		clock.advance(24 * 60 * MIN);
		expect(expired).toEqual([]);
	});

	it("uses a short tick for short TTLs and never more than 5 s", () => {
		const everyMs: number[] = [];
		for (const ttlMin of [0.01, 1, 60]) {
			new PaneTtl({
				ttlMs: ttlMin * MIN,
				isBusy: () => false,
				onExpire: () => {},
				now: () => 0,
				schedule: (_tick, ms) => {
					everyMs.push(ms);
					return { cancel: () => {} };
				},
			}).start();
		}
		expect(everyMs).toEqual([150, 5000, 5000]);
	});

	it("does not fire after stop", () => {
		const { clock, expired, ttl } = makeTtl(1, { value: false });
		ttl.stop();
		clock.advance(5 * MIN);
		expect(expired).toEqual([]);
		expect(clock.timers()).toBe(0);
	});
});

describe("isPaneBusy", () => {
	const idle = {
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		hasPendingBashMessages: false,
		pendingMessageCount: 0,
	};
	const quietUi = { hasOpenDialog: () => false, hasDraft: () => false };

	it("is idle only when every signal is quiet", () => {
		expect(isPaneBusy(idle, quietUi)).toBe(false);
	});

	it.each([
		["provider call or tool", { isStreaming: true }],
		["compaction", { isCompacting: true }],
		["retry or 429 wait", { isRetrying: true }],
		["bash command", { isBashRunning: true }],
		["pending bash output", { hasPendingBashMessages: true }],
		["queued prompt", { pendingMessageCount: 1 }],
	])("is busy during %s", (_name, patch) => {
		expect(isPaneBusy({ ...idle, ...patch }, quietUi)).toBe(true);
	});

	it("is busy with an open dialog or an unsent draft", () => {
		expect(isPaneBusy(idle, { hasOpenDialog: () => true, hasDraft: () => false })).toBe(true);
		expect(isPaneBusy(idle, { hasOpenDialog: () => false, hasDraft: () => true })).toBe(true);
	});
});

describe("expiry receipt", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});
	const herdrEnv = (root: string) => ({
		HERDR_ENV: "1",
		HERDR_SESSION: "infra",
		HERDR_PANE_ID: "w6:pD",
		HERDR_WORKSPACE_ID: "w6",
		HERDR_ROSTER_STATE_DIR: root,
	});

	it("writes a private receipt the roster can match by transcript and pid", () => {
		const root = mkdtempSync(join(tmpdir(), "pane-ttl-"));
		dirs.push(root);
		const result = writeExpiryReceipt({
			env: herdrEnv(root),
			sessionFile: "/home/u/.pi/agent/sessions/x/s.jsonl",
			ttlMin: 60,
			idleMs: 61 * MIN,
			now: new Date("2026-11-23T18:00:00.123Z"),
			pid: 4242,
			startTicks: 987654,
		});
		expect(result.written).toBe(true);
		if (!result.written) return;
		expect(result.path).toBe(expiryReceiptPath(root, "infra", "/home/u/.pi/agent/sessions/x/s.jsonl"));
		expect(result.path).toMatch(/\/[0-9a-f]{24}\/expired\/[0-9a-f]{24}\.json$/);
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({
			version: 1,
			state: "expired",
			expired_at: "2026-11-23T18:00:00Z",
			ttl_min: 60,
			idle_s: 3660,
			session: "infra",
			pane_id: "w6:pD",
			workspace_id: "w6",
			session_file: "/home/u/.pi/agent/sessions/x/s.jsonl",
			pi_pid: 4242,
			pi_start_ticks: 987654,
		});
	});

	it("pins the path contract that the roster readers copy (sha256 prefixes)", () => {
		// echo -n infra | sha256sum | cut -c1-24 ; echo -n /s.jsonl | sha256sum | cut -c1-24
		expect(expiryReceiptPath("/r", "infra", "/s.jsonl")).toMatch(/^\/r\/[0-9a-f]{24}\/expired\/[0-9a-f]{24}\.json$/);
		expect(expiryReceiptPath("/r", "infra", "/s.jsonl")).toBe(
			"/r/eb0de251ac21fb6753f04bc9/expired/9e5049c81757287f3d3177c3.json",
		);
	});

	it("writes nothing outside a Herdr pane or for an unpersisted session", () => {
		const root = mkdtempSync(join(tmpdir(), "pane-ttl-"));
		dirs.push(root);
		const base = { sessionFile: "/s.jsonl", ttlMin: 1, idleMs: MIN, now: new Date(), pid: 1, startTicks: 1 };
		expect(writeExpiryReceipt({ ...base, env: { HERDR_ROSTER_STATE_DIR: root } })).toEqual({
			written: false,
			reason: "not a Herdr pane",
		});
		expect(writeExpiryReceipt({ ...base, env: herdrEnv(root), sessionFile: undefined })).toEqual({
			written: false,
			reason: "session is not persisted",
		});
		expect(existsSync(join(root, "anything"))).toBe(false);
	});

	it("reports a failed write instead of throwing", () => {
		const root = mkdtempSync(join(tmpdir(), "pane-ttl-"));
		dirs.push(root);
		writeFileSync(join(root, "a-file"), "x");
		const result = writeExpiryReceipt({
			env: herdrEnv(join(root, "a-file", "below")), // a directory cannot be made under a regular file
			sessionFile: "/s.jsonl",
			ttlMin: 1,
			idleMs: MIN,
			now: new Date(),
			pid: 1,
			startTicks: 1,
		});
		expect(result.written).toBe(false);
	});

	it("derives the state root like the roster does", () => {
		expect(rosterStateRoot({ HERDR_ROSTER_STATE_DIR: "/a" })).toBe("/a");
		expect(rosterStateRoot({ XDG_STATE_HOME: "/x" })).toBe("/x/pi-herdr-roster");
	});

	it("reads the process start time past a comm field with spaces and parentheses", () => {
		const fields = Array.from({ length: 30 }, (_, i) => String(i + 3)); // fields 3..32
		const stat = `1234 (pi (worker) x) ${fields.join(" ")}`;
		expect(readStartTicks(stat)).toBe(22); // field 22 is the 20th value after comm
		expect(readStartTicks("garbage")).toBeNull();
	});
});
