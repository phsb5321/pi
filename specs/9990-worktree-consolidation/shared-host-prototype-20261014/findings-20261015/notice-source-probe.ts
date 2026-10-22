/**
 * Notices-source probe v2 (D4 finding 3, 15/10/2026): reproduce the
 * coordinator's invoke-path observation ("view-after showed notices:1
 * after submit") and NAME the notice. Also reports whether the durable
 * store received the turn, and whether the presentation view pushes
 * conversation updates. Test-only faux daemon; no paid calls.
 *
 * Run: node --experimental-strip-types notice-source-probe.ts <repo>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachSession, Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const repo = process.argv[2];
assert.ok(repo, "usage: notice-source-probe.ts <repo>");
const daemonScript = join(repo, "packages/coding-agent/src/experimental/durable/shared-host-daemon.ts");
const { openDurablePresentation } = await import(
	daemonScript.replace("shared-host-daemon.ts", "presentation-service.ts")
);

const root = mkdtempSync(join(tmpdir(), "notice-probe-"));
const socket = join(root, "run", "probe.sock");
const serverId = "9f47c2a1-5b30-4e66-8a41-2c9d55e07f10";
const MEMBER = { serviceId: "canary.session", member: "", args: [] };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const logs = [];

const daemon = spawn(
	process.execPath,
	["--experimental-strip-types", daemonScript, "--socket", socket, "--root", join(root, "root"), "--faux"],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
daemon.stdout.on("data", (chunk) => logs.push(`daemon.stdout: ${chunk}`));
daemon.stderr.on("data", (chunk) => logs.push(`daemon.stderr: ${chunk}`));
const started = Date.now();
for (;;) {
	if (logs.some((line) => line.includes("shared-host-daemon ready"))) break;
	if (daemon.exitCode !== null) throw new Error(`daemon exited early (${daemon.exitCode}): ${logs.join("")}`);
	if (Date.now() - started > 45_000) throw new Error(`daemon not ready: ${logs.join("")}`);
	await wait(50);
}

const summarize = (label, view) =>
	console.log(
		`${label}: ${JSON.stringify({
			notices: view.notices,
			conversationEntryCount: (view.conversation?.entries ?? []).length,
			entryKinds: (view.conversation?.entries ?? []).map((entry) => entry.role ?? entry.type),
		})}`,
	);

const readStore = (dir) => {
	const parts = [];
	for (const file of readdirSync(dir)) {
		if (!file.startsWith("session.sqlite")) continue;
		try {
			parts.push(readFileSync(join(dir, file), "latin1"));
		} catch {}
	}
	return parts.join("\n");
};

const client = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path: socket }) });
try {
	const attachment = await attachSession(client, "notice-probe");
	const presentation = await openDurablePresentation(attachment.transport);
	for (let waited = 0; waited < 30_000; waited += 50) {
		if (presentation.view.current() !== undefined) break;
		await wait(50);
	}
	let view = await attachment.invoke({ ...MEMBER, member: "view" });
	summarize("NOTICES-AT-HYDRATE(invoke-view)", view);

	const storeDir = view.session.directory;
	const submitted = await attachment.invoke({ ...MEMBER, member: "submit", args: ["notice source probe"] });
	console.log(`SUBMIT-RECEIPT: ${JSON.stringify(submitted)}`);

	let store = "";
	for (let waited = 0; waited < 20_000; waited += 250) {
		try {
			store = readStore(storeDir);
		} catch {}
		if (store.includes("notice source probe") && store.includes("daemon-echo")) break;
		await wait(250);
	}
	console.log(
		`STORE: userText=${store.includes("notice source probe")} echoText=${store.includes("daemon-echo: notice source probe")}`,
	);

	// Coordinator-style view-after (their notices:1 observation point)...
	view = await attachment.invoke({ ...MEMBER, member: "view" });
	summarize("NOTICES-AFTER-SUBMIT(invoke-view)", view);
	// ...and the presentation-service push view, fresh-read.
	const pushed = presentation.view.current();
	if (pushed) summarize("NOTICES-AFTER-SUBMIT(pushed-view)", pushed);
	else console.log("NOTICES-AFTER-SUBMIT(pushed-view): none");

	const stop = new Promise((resolveExit) => daemon.once("exit", (code) => resolveExit(code)));
	process.kill(daemon.pid, "SIGTERM");
	assert.equal(await stop, 0, "SIGTERM drain exit 0");
	console.log("NOTICE-PROBE-V2 DONE (see NOTICES-*/STORE lines above)");
} finally {
	await client.dispose().catch(() => {});
	if (daemon.exitCode === null) daemon.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
}
