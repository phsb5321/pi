#!/usr/bin/env node
// Guard for the minified install (nix/package.nix): behaviour and diagnostics must survive.
// usage: node scripts/smoke-installed-js.mjs <install-lib-dir> <pi-bin>
// 1. an extension loads and runs, 2. a throwing extension fails with its message intact,
// 3. function names survive and an error thrown inside pi code names the throwing function and file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [libDir, piBin] = process.argv.slice(2);
if (!libDir || !piBin) throw new Error("usage: smoke-installed-js.mjs <install-lib-dir> <pi-bin>");
const dir = mkdtempSync(join(tmpdir(), "pi-smoke-"));
const env = { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent") };
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HERDR_PANE_ID"]) delete env[key];
const fail = (message) => {
	console.error(`smoke-installed-js: FAIL ${message}`);
	process.exit(1);
};

writeFileSync(join(dir, "good.ts"), 'export default function (pi) { console.error("SMOKE-EXT-LOADED " + typeof pi.registerCommand); }\n');
writeFileSync(join(dir, "bad.ts"), 'export default function brokenFactory() { throw new Error("smoke-boom"); }\n');

const good = spawnSync(piBin, ["-e", join(dir, "good.ts"), "--list-models"], { env, encoding: "utf8", timeout: 120_000 });
if (good.status !== 0 || !`${good.stderr}${good.stdout}`.includes("SMOKE-EXT-LOADED function")) {
	fail(`extension did not load: rc=${good.status} ${good.stderr.slice(0, 300)}`);
}

const bad = spawnSync(piBin, ["-e", join(dir, "bad.ts"), "-p", "hi"], { env, encoding: "utf8", timeout: 120_000 });
if (bad.status === 0 || !`${bad.stderr}${bad.stdout}`.includes("smoke-boom")) {
	fail(`broken extension error lost: rc=${bad.status} ${bad.stderr.slice(0, 300)}`);
}

const tui = await import(pathToFileURL(join(libDir, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
if (tui.visibleWidth.name !== "visibleWidth" || tui.Container.name !== "Container") fail("function/class names were rewritten");
let stack = "";
try {
	tui.truncateToWidth(null, 5);
} catch (error) {
	stack = String(error.stack);
}
if (!/at (Module\.)?truncateToWidth \(file:\/\/.*pi-tui\/dist\/utils\.js:\d+:\d+\)/.test(stack)) {
	fail(`stack frame does not name the throwing function and file:\n${stack}`);
}
console.log("smoke-installed-js: OK (extension loads, error path intact, frames name function+file)");
