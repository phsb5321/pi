/**
 * Expiry receipt for a worker pane whose idle TTL ran out (see pane-ttl.ts).
 *
 * The roster tooling that decides whether to resume, nudge or restore a pane lives outside this
 * repository (herdr-roster, fleet-idle-pull, boot restore in the NixOS config). They must treat an
 * expired pane as final. This file is the contract between them and Pi:
 *
 *   <root>/<sha256(HERDR_SESSION)[:24]>/expired/<sha256(session file path)[:24]>.json, mode 0600
 *   <root> = $HERDR_ROSTER_STATE_DIR, else ($XDG_STATE_HOME or ~/.local/state)/pi-herdr-roster
 *
 * The receipt sits in an `expired/` subdirectory so the roster's `*.json` scan of the session
 * directory never mistakes it for a pane receipt. Readers match it to a pane receipt by the
 * transcript path AND `pi_pid`: a later `pi --session ...` has another pid, so a manual resume is
 * never blocked by an old expiry.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXPIRY_RECEIPT_VERSION = 1;
export const EXPIRY_DIR_NAME = "expired";

export interface ExpiryReceipt {
	version: typeof EXPIRY_RECEIPT_VERSION;
	state: "expired";
	expired_at: string;
	ttl_min: number;
	idle_s: number;
	session: string;
	pane_id: string;
	workspace_id: string;
	session_file: string;
	pi_pid: number;
	pi_start_ticks: number | null;
}

export interface ExpiryReceiptInput {
	env: Record<string, string | undefined>;
	sessionFile: string | undefined;
	ttlMin: number;
	idleMs: number;
	now: Date;
	pid: number;
	/** Injected for tests. Defaults to reading /proc/self/stat. */
	startTicks?: number | null;
}

export type ExpiryWrite = { written: true; path: string; receipt: ExpiryReceipt } | { written: false; reason: string };

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_RE = /^w[A-Za-z0-9._-]+:p[A-Za-z0-9._-]+$/;
const WORKSPACE_RE = /^w[A-Za-z0-9._-]+$/;

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function rosterStateRoot(env: Record<string, string | undefined>): string {
	const explicit = env.HERDR_ROSTER_STATE_DIR;
	if (explicit) return explicit;
	const xdg = env.XDG_STATE_HOME;
	return join(xdg ? xdg : join(homedir(), ".local/state"), "pi-herdr-roster");
}

export function expiryReceiptPath(root: string, session: string, sessionFile: string): string {
	return join(root, shortHash(session), EXPIRY_DIR_NAME, `${shortHash(sessionFile)}.json`);
}

/** Field 22 of /proc/<pid>/stat (process start time in clock ticks). The comm field may contain spaces and parentheses. */
export function readStartTicks(stat: string): number | null {
	const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const ticks = Number(afterComm[19]);
	return Number.isInteger(ticks) && ticks > 0 ? ticks : null;
}

function currentStartTicks(): number | null {
	try {
		return readStartTicks(readFileSync("/proc/self/stat", "utf8"));
	} catch {
		return null;
	}
}

/**
 * Write the receipt. Never throws: expiry must still exit the process when the state directory is
 * unusable. Outside a Herdr pane there is no roster to tell, so nothing is written.
 */
export function writeExpiryReceipt(input: ExpiryReceiptInput): ExpiryWrite {
	const { env } = input;
	const session = env.HERDR_SESSION ?? "";
	const pane = env.HERDR_PANE_ID ?? "";
	const workspace = env.HERDR_WORKSPACE_ID ?? "";
	if (env.HERDR_ENV !== "1" || !SESSION_RE.test(session) || !PANE_RE.test(pane) || !WORKSPACE_RE.test(workspace)) {
		return { written: false, reason: "not a Herdr pane" };
	}
	if (!input.sessionFile) return { written: false, reason: "session is not persisted" };
	const receipt: ExpiryReceipt = {
		version: EXPIRY_RECEIPT_VERSION,
		state: "expired",
		expired_at: input.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
		ttl_min: input.ttlMin,
		idle_s: Math.round(input.idleMs / 1000),
		session,
		pane_id: pane,
		workspace_id: workspace,
		session_file: input.sessionFile,
		pi_pid: input.pid,
		pi_start_ticks: input.startTicks === undefined ? currentStartTicks() : input.startTicks,
	};
	const path = expiryReceiptPath(rosterStateRoot(env), session, input.sessionFile);
	try {
		const dir = join(path, "..");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const temp = `${path}.${input.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
		renameSync(temp, path);
		return { written: true, path, receipt };
	} catch (error) {
		return { written: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
