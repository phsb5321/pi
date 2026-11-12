import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function listedFiles(config) {
	return new Set(execFileSync(join(root, "node_modules/.bin/tsc"), ["--listFilesOnly", "-p", config], {
		cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
	}).trim().split("\n").map((file) => resolve(file.trim())));
}

test("root checking retains every compiled workspace source and existing runnable test", () => {
	const checked = listedFiles("tsconfig.json");
	const omitted = new Set([
		"packages/coding-agent/test/suite/regressions/8261-subagent-project-trust.test.ts",
		"packages/coding-agent/test/subagent-extension.test.ts",
	].map((file) => resolve(root, file)));
	for (const name of readdirSync(join(root, "packages"))) {
		const directory = join(root, "packages", name);
		if (!existsSync(join(directory, "package.json"))) continue;
		const build = join(directory, "tsconfig.build.json");
		if (existsSync(build)) {
			for (const file of listedFiles(build)) {
				if (file.startsWith(`${directory}/src/`)) assert.ok(checked.has(file), `compiled source omitted: ${file}`);
			}
		}
		for (const file of globSync("test/**/*.test.ts", { cwd: directory })) {
			const absolute = resolve(directory, file);
			if (!omitted.has(absolute)) assert.ok(checked.has(absolute), `runnable test omitted: ${absolute}`);
		}
	}
	for (const name of ["client", "server"]) {
		assert.equal(existsSync(join(root, "packages", name, "package.json")), false,
			`${name} became a workspace; requalify its type-check boundary`);
	}
	const build = JSON.parse(readFileSync(join(root, "packages/coding-agent/tsconfig.build.json"), "utf8"));
	assert.ok(build.exclude.includes("src/experimental"), "experimental source became compiled; requalify root checking");
});
