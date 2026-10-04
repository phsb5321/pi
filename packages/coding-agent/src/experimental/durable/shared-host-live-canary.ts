/**
 * shared-host-live-canary — REVERSIBLE LIVE CANARY STAGE (opt-in, DEFAULT OFF).
 *
 * Staged by the runtime owner for the shared-isolate pilot. The canary stays
 * SYNTHETIC until the pilot authorizes live: nothing here runs unless
 * PI_SHARED_LIVE_CANARY=1 is explicitly set, and a real (paid-capable) model
 * turn additionally requires PI_SHARED_LIVE_MODEL=<model-id> with pilot
 * authorization. No service, hook, or import activates this entry — it is a
 * separate entry invoked only by an operator command.
 *
 *   Opt-in run (provider-free: real engines, view/abort only):
 *     PI_SHARED_LIVE_CANARY=1 node --experimental-strip-types \
 *       packages/coding-agent/src/experimental/durable/shared-host-live-canary.ts
 *   Live model turn (PILOT AUTHORIZATION REQUIRED):
 *     PI_SHARED_LIVE_CANARY=1 PI_SHARED_LIVE_MODEL=<id> ... (same command)
 *
 * REVERT PATH (exact): `git revert <staging-sha>` — one command removes this
 * entry and restores shared-host-main.ts to its pre-resolver form. Leaving the
 * env unset is the standing default-off state.
 *
 * Exit contract: 0 = pass, 3 = fail (same as shared-host-canary.ts).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SessionMetadata } from "@earendil-works/pi-server";
import { createSharedHostMain } from "./shared-host-main.ts";
import { openAttachedSessions } from "./shared-host-acceptance-kit.ts";

const LIVE = process.env.PI_SHARED_LIVE_CANARY === "1";
const LIVE_MODEL = process.env.PI_SHARED_LIVE_MODEL;

function ok(line: string): void {
	process.stdout.write(`ok - ${line}\n`);
}

async function runLive(): Promise<number> {
	const root = mkdtempSync(join(tmpdir(), "shared-host-live-canary-"));
	const ids = ["live-s1", "live-s2", "live-s3"];
	for (const id of ids) mkdirSync(join(root, id), { recursive: true });
	const host = await createSharedHostMain({
		policy: { maxSessions: ids.length },
		// Per-session open options through the application-owned resolver.
		durable: (metadata: SessionMetadata) => ({ cwd: join(root, metadata.id), continueSession: false }),
	});
	const invoke = await openAttachedSessions(host.runtime as never, ids);
	const sessions = new Map<string, string>();
	for (const id of ids) {
		const view = (await invoke(id, "view")) as { session: { id: string; cwd: string } };
		if (view.session.cwd !== join(root, id)) throw new Error(`live canary: ${id} cwd mismatch`);
		sessions.set(id, view.session.id);
	}
	if (new Set(sessions.values()).size !== ids.length) throw new Error("live canary: session identity leak");
	ok("live: 3 real engines, per-session cwd via resolver, identities distinct");

	if (LIVE_MODEL !== undefined && LIVE_MODEL !== "") {
		// PILOT-AUTHORIZED LIVE TURN (paid-capable): one tiny prompt per session.
		for (const id of ids) {
			await invoke(id, "setModel", [{ id: LIVE_MODEL }]);
			await invoke(id, "submit", [`live canary ping (${id})`, "followUp"]);
		}
		ok(`live: model turns submitted on ${LIVE_MODEL} (pilot-authorized)`);
	} else {
		ok("live: provider-free pass (no PI_SHARED_LIVE_MODEL — view/abort only)");
	}

	for (const id of ids) {
		const abort = (await invoke(id, "abort")) as { ok: boolean };
		if (!abort.ok) throw new Error(`live canary: ${id} abort failed`);
		const after = (await invoke(id, "view")) as { session: { id: string } };
		if (after.session.id !== sessions.get(id)) throw new Error(`live canary: ${id} view leak after abort`);
	}
	ok("live: per-session abort clean, views stay own");
	await host.close();
	const remaining = (host.runtime as never as { control: { identities: () => unknown[] } }).control.identities();
	if (remaining.length !== 0) throw new Error("live canary: engines not released");
	ok("live: shutdown released every engine");
	process.stdout.write("shared-host-live-canary: ALL PASS\n");
	return 0;
}

if (!LIVE) {
	process.stdout.write("shared-host-live-canary: staged, DEFAULT OFF (set PI_SHARED_LIVE_CANARY=1 to opt in; PI_SHARED_LIVE_MODEL requires pilot authorization)\n");
	process.exit(0);
}

runLive().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`shared-host-live-canary: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(3);
	},
);
