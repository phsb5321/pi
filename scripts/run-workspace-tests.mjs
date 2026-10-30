#!/usr/bin/env node
// Runs each workspace's test script one at a time. `npm test --workspaces` starts
// every workspace's vitest concurrently; on a constrained runner (the Forgejo
// docker executor) that exhausts the container's task/thread ceiling and the
// pi-env daemon panics with `failed to spawn thread: EAGAIN` (exit 101),
// reproduced 30/10/2026 on the memory-sound-1.4 base bump. Serial execution
// runs the same tests with a bounded process count.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const globs = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
if (!globs) {
	console.error("run-workspace-tests: no workspaces in the root package.json");
	process.exit(2);
}
const paths = [];
for (const glob of globs) {
	// Only the plain `dir/*` shapes this repository declares; an explicit path is used as-is.
	const prefix = glob.endsWith("/*") ? glob.slice(0, -2) : glob;
	if (!glob.endsWith("/*")) {
		if (existsSync(join(prefix, "package.json"))) paths.push(prefix);
		continue;
	}
	const { readdirSync } = await import("node:fs");
		if (!existsSync(prefix)) continue;
	for (const entry of readdirSync(prefix)) {
		if (existsSync(join(prefix, entry, "package.json"))) paths.push(join(prefix, entry));
	}
}
let failed = 0;
for (const path of paths) {
	const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
	if (!pkg.scripts?.test) continue;
	console.log(`run-workspace-tests: ${pkg.name} (${path})`);
	// Bare `vitest --run` sizes its worker pool to the host CPU count, which
	// re-creates the task-ceiling exhaustion on constrained runners. The repo's
	// testing rules already mandate --maxWorkers=2 for vitest; node:test suites
	// (tui, scripts) keep their `npm test`. pi-env additionally runs on one
	// worker: its daemon-spawning files are the marginal case at the ceiling.
	const single = pkg.name === "@earendil-works/pi-env";
	const command = pkg.scripts.test.startsWith("vitest")
		? [
				join("..", "..", "node_modules", "vitest", "dist", "cli.js"),
				"--run",
				"--maxWorkers=2",
				...(single ? ["--maxWorkers=1"] : []),
			]
		: ["test"];
	const result = pkg.scripts.test.startsWith("vitest")
		? spawnSync(process.execPath, command, { stdio: "inherit", cwd: path })
		: spawnSync("npm", ["test"], { stdio: "inherit", cwd: path });
	if (result.status !== 0) {
		console.error(`run-workspace-tests: ${pkg.name} FAILED (exit ${result.status})`);
		failed++;
	}
}
process.exit(failed === 0 ? 0 : 1);
