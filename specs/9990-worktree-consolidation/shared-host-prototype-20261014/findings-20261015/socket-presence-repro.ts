/**
 * Socket-presence timeline (15/10/2026): daemon binds, we statSync+connect
 * in a tight loop and print exactly when/if the socket disappears.
 * Usage: node socket-presence-repro.ts <repo>
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "presence-repro-"));
const socket = join(root, "run", "probe.sock");
const wait = (ms) => new Promise((d) => setTimeout(d, ms));
const logs = [];
const daemon = spawn(
	process.execPath,
	["--experimental-strip-types", join(repo, "packages/coding-agent/src/experimental/durable/shared-host-daemon.ts"), "--socket", socket, "--root", join(root, "root"), "--faux"],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
daemon.stdout.on("data", (c) => logs.push(String(c)));
daemon.stderr.on("data", (c) => logs.push(String(c)));
const started = Date.now();
for (;;) {
	if (logs.some((l) => l.includes("shared-host-daemon ready"))) break;
	if (daemon.exitCode !== null) throw new Error(`daemon exited early: ${logs.join("")}`);
	if (Date.now() - started > 30_000) throw new Error("not ready");
	await wait(25);
}
const t0 = Date.now();
let connectOk = 0, connectFail = 0;
for (let i = 0; i < 60; i++) {
	let stat = "gone";
	try {
		const st = statSync(socket);
		stat = `${(st.mode & 0o777).toString(8)}/ino${st.ino}`;
	} catch (e) {
		stat = `STAT-${e.code}`;
	}
	const probe = await new Promise((resolve) => {
		const s = createConnection(socket);
		const done = (r) => { s.removeAllListeners(); s.destroy(); resolve(r); };
		s.once("connect", () => done("CONNECT-OK"));
		s.once("error", (e) => done(`CONNECT-${e.code}`));
		setTimeout(() => done("CONNECT-TIMEOUT"), 500);
	});
	if (probe === "CONNECT-OK") connectOk++; else connectFail++;
	if (i < 6 || probe !== "CONNECT-OK" || stat.startsWith("STAT") || stat === "gone") {
		console.log(`t+${Date.now() - t0}ms ${stat} ${probe}`);
	}
	await wait(200);
}
console.log(`SUMMARY connectOk=${connectOk} connectFail=${connectFail} daemonAlive=${daemon.exitCode === null}`);
if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await wait(500); }
console.log(`daemon.exitCode=${daemon.exitCode}`);
console.log(`daemon.log=${logs.join("|").slice(0, 2000)}`);
rmSync(root, { recursive: true, force: true });
