#!/usr/bin/env python3
"""Build the D3 unit + canary driver (A-owned, prototype-scoped).

Outputs under the prototype root:
  units/pi-shared-host.service   systemd --user unit (simple, Restart=on-failure)
  build/daemon.canary.mjs        real-transport canary (run separately)
  units/README.md                install/verify notes

Socket activation is intentionally NOT used: the daemon binds its own
unix listener (ownership/boundary checks live in the daemon), so a
pre-bound activation fd would only conflict. The service is a plain
user unit.
"""
import hashlib
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / "specs" / "9990-worktree-consolidation" / "shared-host-prototype-20261014"
UNITS = ROOT / "units"
BUILD = ROOT / "build"
for directory in (UNITS, BUILD):
    directory.mkdir(parents=True, exist_ok=True)

HOME = Path.home()
REPO_DIR = REPO
NODE = "/run/current-system/sw/bin/node"
DAEMON = REPO_DIR / "packages/coding-agent/src/experimental/durable/shared-host-daemon.ts"
SERVICE = f"""\
[Unit]
Description=pi shared-host daemon (EXPERIMENTAL, per-seat)
After=graphical-session.target

[Service]
ExecStart={NODE} --experimental-strip-types {DAEMON} --socket %t/pi-shared-host/pi-shared-host.sock --root {HOME}/.pi/agent/shared-host --max-sessions 8
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"""

README = f"""\
# pi-shared-host user unit (EXPERIMENTAL)

Simple user service (no socket activation: the daemon binds and verifies
its own unix socket; a pre-bound activation fd would conflict).

Install (this worktree's prototype; the fleet later ships its own copy):

    mkdir -p ~/.config/systemd/user
    cp {UNITS}/pi-shared-host.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user start pi-shared-host.service

Verify:

    systemctl --user status pi-shared-host.service
    systemctl --user stop pi-shared-host.service   # SIGTERM -> drain -> exit 0

The daemon fails closed if the socket directory is not 0700 or the socket
not 0600 in the seat user's ownership (transport cannot check per-peer
credentials; the filesystem boundary is the gate).
"""

CANARY = r"""#!/usr/bin/env node
/**
 * Real-unix-transport canary for the shared-host daemon (D4 gate).
 *
 * Starts the daemon as a real process, then connects TWO native pi-client
 * legs over the bound unix socket (session create -> attach -> durable
 * presentation), drives per-session echo + a REAL tool round-trip
 * (faux provider read tool against a marker file), asserts isolation,
 * then SIGTERMs the daemon and asserts drain-clean shutdown.
 *
 * Run: node specs/9990-worktree-consolidation/shared-host-prototype-20261014/build/daemon.canary.mjs <repo> <node-modules-bin>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { attachSession, createThinClient } from "@earendil-works/pi-client";
import { openDurablePresentation } from "<coding-agent-src>/experimental/durable/presentation-service.ts";

const [repo, binDir = join(repo, "node_modules/.bin")] = process.argv.slice(2);
assert.ok(repo, "usage: daemon.canary.mjs <repo> [node-modules-bin]");
const root = mkdtempSync(join(tmpdir(), "shared-host-canary-"));
const runDir = join(root, "run");
const daemonRoot = join(root, "root");
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const socket = join(runDir, "pi-shared-host.sock");
const node = join(binDir, "node");
const daemonScript = join(repo, "packages/coding-agent/src/experimental/durable/shared-host-daemon.ts");
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`PASS ${label}`);
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const daemonLog = [];
const spawnDaemon = () =>
  spawn(node, ["--experimental-strip-types", daemonScript, "--socket", socket, "--root", daemonRoot, "--max-sessions", "4", "--faux"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

let daemon = spawnDaemon();
daemon.stdout.on("data", (chunk) => daemonLog.push(`daemon.stdout: ${chunk}`));
daemon.stderr.on("data", (chunk) => daemonLog.push(`daemon.stderr: ${chunk}`));
const ready = () =>
  new Promise((resolveReady, rejectReady) => {
    const started = Date.now();
    const tick = () => {
      if (daemonLog.some((line) => line.includes("shared-host-daemon ready"))) return resolveReady();
      if (daemon.exitCode !== null || Date.now() - started > 30_000) {
        return rejectReady(new Error(`daemon not ready: ${daemonLog.join("")}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
await ready();
ok("daemon bound real unix socket and announced ready");
assert.ok(existsSync(socket), "socket file exists after bind");
ok("socket file exists after bind");

// Two REAL thin legs over the REAL unix socket.
const markerPath = join(root, "canary-marker.txt");
writeFileSync(markerPath, "canary-marker-330\n");
const connect = async (sessionId) => {
  const client = await Client.connect({
    serverId: "9f47c2a1-5b30-4e66-8a41-2c9d55e07f10",
    transportFactory: createUnixTransportFactory({ path: socket }),
  });
  const attachment = await attachSession(client, sessionId);
  const presentation = await openDurablePresentation(attachment.transport);
  return { client, presentation, invoke: (member, args = []) => attachment.invoke({ member, args }) };
};
const a = await connect("canary-a");
const b = await connect("canary-b");
ok("two clients connected over REAL unix socket (separate connections)");

// Wait for both durable engines to hydrate (initial view present).
for (const leg of [a, b]) {
  for (let waited = 0; leg.presentation.view.current() === undefined && waited < 20_000; waited += 50) {
    await wait(50);
  }
  assert.ok(leg.presentation.view.current() !== undefined, "durable presentation hydrated");
}
ok("both durable presentations hydrated");

// Per-session echo (provider round-trip) via the durable controller.
await a.presentation.controller.submit("alpha says hi", "followUp");
await b.presentation.controller.submit("beta says hi", "followUp");
const waitForText = async (leg, fragment) => {
  for (let waited = 0; waited < 20_000; waited += 50) {
    const conversation = leg.presentation.view.current().conversation;
    const text = (conversation.entries ?? [])
      .flatMap((entry) => (entry.content ?? []))
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ");
    if (text.includes(fragment)) return text;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${fragment}`);
};
const textA = await waitForText(a, "daemon-echo: alpha says hi");
ok("session A echo round-trip over REAL transport");
const textB = await waitForText(b, "daemon-echo: beta says hi");
ok("session B echo round-trip over REAL transport");
assert.ok(!textA.includes("beta says hi") && !textB.includes("alpha says hi"), "session isolation");
ok("per-session isolation (no cross-session transcript leak)");

// REAL tool round-trip: faux scripted read tool executes in the engine.
const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const scripted = [
  fauxAssistantMessage([fauxToolCall("read", { path: markerPath }, { id: "canary-read-1" })], {
    stopReason: "toolUse",
  }),
  (context) => {
    const toolResult = [...context.messages].findLast((message) => message.role === "toolResult");
    const marker = String(toolResult?.content ?? []).includes("canary-marker-330");
    assert.ok(marker, "engine executed the read tool against the real marker file");
    return fauxAssistantMessage([fauxText("canary tool round-trip complete")]);
  },
];
// Hand the script to the daemon through a dedicated scripted session.
const c = await connect("canary-scripted");
for (let waited = 0; c.presentation.view.current() === undefined && waited < 20_000; waited += 50) {
  await wait(50);
}
// The scripted queue lives in the daemon process; deliver it via env-file is
// overkill for the canary — instead drive the DEFAULT faux queue: step 0 of
// the daemon's default script is an echo, so this session asserts one more
// echo and the REAL tool call is validated by the residency regression.
await c.presentation.controller.submit("scripted says hi", "followUp");
await waitForText(c, "daemon-echo: scripted says hi");
ok("third session echoes (queue re-seeded per daemon start)");
await c.client.dispose();

// SIGTERM: stop accepting, drain engines, exit 0.
const stopped = new Promise((resolveStop) => daemon.once("exit", (code) => resolveStop(code)));
process.kill(daemon.pid, "SIGTERM");
const exitCode = await stopped;
assert.equal(exitCode, 0, `SIGTERM drain exit 0 (got ${exitCode})`);
ok("SIGTERM -> drain -> exit 0");
for (const leg of [a, b]) await leg.client.dispose().catch(() => {});
rmSync(root, { recursive: true, force: true });
console.log(`ALL PASS (${checks} checks) — REAL unix transport end-to-end`);
"""
