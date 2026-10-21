#!/usr/bin/env node
/**
 * Gate-2 acceptance: extension parity in the durable runtime (16/10/2026).
 *
 * Phase A (faux + herdr): daemon with --extension parity.ts; HERDR env points
 *   herdr-agent-state at a FAKE herdr socket owned by this harness. Attach →
 *   session_start → pane.report_agent_session line; submit (faux echo) →
 *   agent_start ("working") + agent_settled ("idle") reports.
 * Phase B (production wiring): daemon WITHOUT faux (real seat catalog; no
 *   submits, zero token spend). Attached seat performs a FORBIDDEN model
 *   switch (zai/glm-5.3-flash, no PI_WORKER=flash) → parity's model_select
 *   guard reverts via pi.setModel and the refusal lands in view.notices;
 *   a CONTROL switch (zai/glm-5.3, frontier) is accepted.
 *
 * Run: node extension-parity-acceptance.mjs <repo>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachSession, Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const repo = process.argv[2];
assert.ok(repo, "usage: extension-parity-acceptance.mjs <repo>");
const daemonScript = join(repo, "packages/coding-agent/src/experimental/durable/shared-host-daemon.ts");
const PARITY = `${process.env.HOME}/.config/pi-harness/parity.ts`;
const SERVER_ID = "9f47c2a1-5b30-4e66-8a41-2c9d55e07f10";
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

let checks = 0;
const ok = (label) => {
	checks += 1;
	console.log(`PASS ${label}`);
};

function spawnDaemon(socket, root, extraEnv, extraArgs) {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", daemonScript, "--socket", socket, "--root", root, ...extraArgs],
		{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv } },
	);
	const logs = [];
	child.stdout.on("data", (chunk) => logs.push(`daemon.stdout: ${chunk}`));
	child.stderr.on("data", (chunk) => logs.push(`daemon.stderr: ${chunk}`));
	const readyStart = Date.now();
	const ready = new Promise((resolveReady, rejectReady) => {
		const tick = () => {
			if (logs.some((line) => line.includes("shared-host-daemon ready"))) return resolveReady();
			if (child.exitCode !== null) return rejectReady(new Error(`daemon exited early (${child.exitCode}): ${logs.join("")}`));
			if (Date.now() - readyStart > 60_000) return rejectReady(new Error(`daemon not ready: ${logs.join("")}`));
			setTimeout(tick, 50);
		};
		tick();
	});
	const stop = async () => {
		const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
		process.kill(child.pid, "SIGTERM");
		const code = await exit;
		assert.equal(code, 0, `SIGTERM drain exit 0 (got ${code})`);
	};
	return { child, ready, stop, logs };
}

async function connect(socket, sessionId) {
	const client = await Client.connect({ serverId: SERVER_ID, transportFactory: createUnixTransportFactory({ path: socket }) });
	const attachment = await attachSession(client, sessionId);
	const { openDurablePresentation } = await import(
		join(repo, "packages/coding-agent/src/experimental/durable/presentation-service.ts")
	);
	const presentation = await openDurablePresentation(attachment.transport);
	for (let waited = 0; waited < 30_000; waited += 50) {
		if (presentation.view.current() !== undefined) break;
		await wait(50);
	}
	const invoke = (member, args = []) => attachment.invoke({ serviceId: "canary.session", member, args });
	const view = () => presentation.view.current();
	const currentModel = () => view()?.conversation?.docs?.["pi.agent"]?.model;
	const waitNotice = async (fragment) => {
		for (let waited = 0; waited < 30_000; waited += 50) {
			const hit = (view()?.notices ?? []).some((notice) => notice.message.includes(fragment));
			if (hit) return true;
			await wait(50);
		}
		return false;
	};
	return { client, invoke, view, currentModel, waitNotice, presentation };
}

// ============================== Phase A ==============================
{
	const scratch = mkdtempSync(join(tmpdir(), "g2-"));
	const socket = join(scratch, "run", "host.sock");
	const herdrSocket = join(scratch, "herdr.sock");
	assert.ok(socket.length <= 107 && herdrSocket.length <= 107, "scratch socket paths must fit sun_path");

	const herdrLines = [];
	const herdr = createServer((connection) => {
		let buffer = "";
		connection.on("data", (chunk) => {
			buffer += String(chunk);
			let index;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				herdrLines.push(line);
				// Ack so herdr's sendRequestAttempt delivers on first attempt —
				// a silent socket retries (2s), coalescing away transient
				// states like "working" (measured first run).
				connection.write(`${JSON.stringify({ ok: true })}\n`);
			}
		});
	});
	await new Promise((resolveListen) => herdr.listen(herdrSocket, resolveListen));

	const daemon = spawnDaemon(socket, join(scratch, "root"), {
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: herdrSocket,
		HERDR_PANE_ID: "gate2",
	}, ["--faux", "--extension", PARITY]);
	await daemon.ready;
	ok("daemon up with --extension parity.ts (faux wiring)");

	const seat = await connect(socket, "gate2-a");
	ok("attached seat gate2-a (engine open dispatched session_start)");

	let sessionReports = 0;
	for (let waited = 0; waited < 15_000; waited += 50) {
		sessionReports = herdrLines.filter((line) => line.includes("pane.report_agent_session")).length;
		if (sessionReports >= 1) break;
		await wait(50);
	}
	assert.ok(sessionReports >= 1, `herdr received session_start report (got ${herdrLines.length} lines)`);
	const firstReport = JSON.parse(herdrLines.find((line) => line.includes("pane.report_agent_session")));
	assert.equal(firstReport.params.pane_id, "gate2");
	assert.ok(firstReport.params.agent_session_id || firstReport.params.agent_session_path, "session ref forwarded from ctx");
	ok("herdr-agent-state received session_start (pane.report_agent_session)");

	await seat.invoke("submit", ["gate2 parity probe", "followUp"]);
	for (let waited = 0; waited < 30_000; waited += 50) {
		const text = JSON.stringify(seat.view()?.conversation ?? {});
		if (text.includes("daemon-echo: gate2 parity probe")) break;
		await wait(50);
	}
	let workingSeen = false;
	let idleSeen = false;
	for (let waited = 0; waited < 15_000; waited += 50) {
		const states = herdrLines.map((line) => {
			try {
				return JSON.parse(line).params.state;
			} catch {
				return undefined;
			}
		});
		workingSeen ||= states.includes("working");
		idleSeen ||= states.includes("idle");
		if (workingSeen && idleSeen) break;
		await wait(50);
	}
	assert.ok(workingSeen && idleSeen, `herdr saw working->idle state reports (working=${workingSeen} idle=${idleSeen})\nHERDR LINES:\n${herdrLines.join("\n")}\nNOTICES: ${JSON.stringify(seat.view()?.notices ?? [])}`);
	ok("herdr-agent-state received agent_start/agent_settled (working -> idle)");

	await seat.client.dispose().catch(() => {});
	await daemon.stop();
	herdr.close();
	rmSync(scratch, { recursive: true, force: true });
	ok("phase A daemon SIGTERM drain exit 0");
}

// ============================== Phase B ==============================
{
	const scratch = mkdtempSync(join(tmpdir(), "g2b-"));
	const socket = join(scratch, "run", "host.sock");
	// Production wiring (no --faux): real seat catalog. NO submits — zero token
	// spend; the guard acceptance only switches models.
	const daemon = spawnDaemon(socket, join(scratch, "root"), { PI_WORKER: "" }, ["--extension", PARITY]);
	await daemon.ready;
	ok("production-wiring daemon up with --extension parity.ts");

	const seat = await connect(socket, "gate2-b");
	const before = seat.currentModel();
	assert.ok(before, `session has a saved model (got ${JSON.stringify(before)})`);
	ok(`seat model before switch: ${before.provider}/${before.modelId}`);

	await seat.invoke("setModel", [{ provider: "zai", modelId: "glm-5.3-flash" }]);
	const refused = await seat.waitNotice("Provider-frontier policy refused zai/glm-5.3-flash");
	assert.ok(refused, "parity model_select guard fired on the forbidden switch");
	const afterRefusal = seat.currentModel();
	assert.equal(afterRefusal.provider, before.provider, "guard REVERTED the switch (provider)");
	assert.equal(afterRefusal.modelId, before.modelId, "guard REVERTED the switch (model id)");
	ok("forbidden /model switch reverted by pi.setModel (seat stays on previous model)");

	await seat.invoke("setModel", [{ provider: "zai", modelId: "glm-5.3" }]);
	for (let waited = 0; waited < 30_000; waited += 50) {
		const model = seat.currentModel();
		if (model?.provider === "zai" && model?.modelId === "glm-5.3") break;
		await wait(50);
	}
	const afterAllowed = seat.currentModel();
	assert.equal(afterAllowed.provider, "zai", "frontier switch accepted (provider)");
	assert.equal(afterAllowed.modelId, "glm-5.3", "frontier switch accepted (model id)");
	ok("control: frontier switch (zai/glm-5.3) accepted — guard only blocks policy violations");

	await seat.client.dispose().catch(() => {});
	await daemon.stop();
	rmSync(scratch, { recursive: true, force: true });
	ok("phase B daemon SIGTERM drain exit 0");
}

console.log(`ALL PASS (${checks} checks) — durable extension parity: loading, guard, herdr events`);
process.exit(0);

process.on("unhandledRejection", (error) => {
	console.error("FAIL unhandled rejection:", error);
	process.exit(3);
});
process.on("uncaughtException", (error) => {
	console.error("FAIL uncaught exception:", error && error.stack ? error.stack : error);
	process.exit(3);
});
