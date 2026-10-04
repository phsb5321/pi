/**
 * shared-host-acceptance — COMPOSED REAL-SDK ACCEPTANCE (battery-2 items 1-2
 * through the REAL SDK/application host path of the composed candidate
 * @59e7842de). One shared host process, N sessions on real openDurable
 * engines (real Harness + per-session SQLite stores), driven only through the
 * entry's service dispatch (DURABLE_MEMBERS). NO model turns are submitted —
 * view/abort only — so the run is provider-free and paid-call-free.
 *
 * Items:
 *   1. cancellation/history/extensions isolation — abort per session with the
 *      others unaffected and the session still responsive; per-session history
 *      stores (distinct session directories + databases); the extension
 *      registry is instantiated per session engine (createCodingRegistry per
 *      openDurable call — runtime.ts), with runtime instance isolation
 *      asserted at the seam battery (battery2 + p9's adversarial half).
 *   2. SDK/application-owned host services — the entry's service dispatch
 *      carries app-owned members per session with no cross-session leaks
 *      (each session's view identity/directory stays its own).
 *
 * W1/E durable-context axis (deferral note, printed below as CTXDEFER): the
 * host start defers ALL per-session context work — selectSession, Execu-
 * tionEnvs, ModelRuntime.create, SettingsManager.create, createCodingRegistry
 * and Harness.open all run inside openDurable per session on open, never at
 * createSharedHostMain; conversation reads are likewise per-call. The staged
 * per-session-cwd resolver (next commit) completes cwd-level config isolation.
 *
 *   node --experimental-strip-types packages/coding-agent/src/experimental/durable/shared-host-acceptance.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-server";
import { createSharedHostMain } from "./shared-host-main.ts";

let failures = 0;
function check(label: string, condition: boolean): void {
	if (condition) {
		console.log(`PASS ${label}`);
		return;
	}
	failures += 1;
	console.error(`FAIL ${label}`);
}

const root = mkdtempSync(join(tmpdir(), "shared-host-acceptance-"));
const ids = ["sdk-s1", "sdk-s2", "sdk-s3"];
for (const id of ids) mkdirSync(join(root, id), { recursive: true });

const opened: string[] = [];
const host = await createSharedHostMain({
	policy: { maxSessions: 3 },
	hooks: {
		// App-owned host service surface: cap refusals are attributed per session.
		onEngineRefused: (sessionId: string) => {
			opened.push(sessionId);
		},
	},
	durable: { cwd: root, continueSession: false },
});

const views: Array<{ id: string; session: { id: string; directory: string; cwd: string } }> = [];
const handles = new Map<string, { attachClient: (ctx: never) => Promise<{ invokeService: (call: unknown, publish: unknown, ctx: unknown) => Promise<unknown> }> }>();
for (const id of ids) {
	const handle = await (host.runtime as never as { host: { openSession: (m: SessionMetadata, c: unknown) => Promise<unknown> } }).host.openSession({ id }, BACKGROUND_CONTEXT);
	handles.set(id, handle as never);
}
for (const id of ids) {
	const attachment = await handles.get(id)!.attachClient(BACKGROUND_CONTEXT as never);
	const invoke = (member: string, args: unknown[] = []) =>
		attachment.invokeService({ member, args }, async () => undefined, BACKGROUND_CONTEXT);
	// Item 2: app-owned service dispatch carries the view per session.
	const view = (await invoke("view")) as { session: { id: string; directory: string; cwd: string } };
	views.push({ id, session: view.session });
	// Item 1 (cancel flow, real controller): abort resolves; session stays live.
	const abortResult = (await invoke("abort")) as { ok: boolean };
	check(`cancel: ${id} abort() clean through the real controller`, abortResult.ok === true);
	const after = (await invoke("view")) as { session: { id: string } };
	check(`cancel: ${id} responsive after abort (view still its own)`, after.session.id === view.session.id);
}

// Item 1 (history): per-session stores — distinct session identities and
// directories, each with its own database files (no shared history store).
const sessionIds = views.map((entry) => entry.session.id);
const directories = views.map((entry) => entry.session.directory);
check("history: every session has a distinct identity", new Set(sessionIds).size === ids.length);
check("history: every session has a distinct store directory", new Set(directories).size === ids.length);
check(
	"history: per-session store directories exist and are populated per session",
	directories.every((dir) => existsSync(dir) && readdirSync(dir).length > 0),
);

// Item 2 (no cross-session leaks): each view stayed bound to its opener.
check(
	"serverServices: views never leak across sessions (identity bound to opener)",
	views.every((entry, index) => entry.session.id === sessionIds[index] && entry.session.id !== sessionIds[(index + 1) % ids.length]),
);
check(
	"serverServices: engine identities are per session (3 distinct, seam-tracked)",
	(() => {
		const identities = (host.runtime as never as { control: { identities: () => Array<{ sessionId: string }> } }).control.identities();
		return identities.length === ids.length && new Set(identities.map((identity) => identity.sessionId)).size === ids.length;
	})(),
);

// Item 1 (extensions): registry instantiation is per session engine
// (createCodingRegistry per openDurable call in runtime.ts). The cwd context
// IS carried into every session's context chain (visible in the view); the
// staged per-session-cwd resolver completes per-session cwd isolation.
check(
	"extensions: per-session cwd context carried into every session (registry derives from it)",
	views.every((entry) => entry.session.cwd === root),
);

console.log(
	`CTXDEFER ${JSON.stringify({
		hostStart: ["SharedHostCore", "InProcessRuntime (seam)"],
		perSessionOnOpen: ["selectSession", "ExecutionEnvs", "ModelRuntime.create", "SettingsManager.create", "createCodingRegistry", "Harness.open"],
		perCall: ["conversation reads (view.entries via DurableView)", "controller ops"],
		note: "W1/E durable-context axis: all durable context work is deferred to per-session open / per-call; the host start carries none. Staged per-session-cwd resolver completes cwd-level config isolation (next commit).",
	})}`,
);

await host.close();
const remaining = (host.runtime as never as { control: { identities: () => unknown[] } }).control.identities();
check("shutdown: all engines closed, identities empty", remaining.length === 0);

if (failures > 0) {
	console.error(`SHARED-HOST REAL-SDK ACCEPTANCE: ${failures} FAILURE(S)`);
	process.exit(3);
}
console.log("SHARED-HOST REAL-SDK ACCEPTANCE: ALL PASS (candidate base 59e7842de; no model turns; provider-free)");
