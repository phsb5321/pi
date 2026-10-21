import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// QA writer assertion's installed dependency closure; no installs or source loading.
// Its root must be a producer-declared frozen input alias, not a chosen new package.
const initial = process.argv[2];
const queue = [realpathSync(initial)];
const seen = new Set();
const packages = [];
while (queue.length) {
	const root = queue.shift();
	if (seen.has(root)) continue;
	seen.add(root);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert(manifest.name && manifest.version);
	packages.push({ root, name: manifest.name, version: manifest.version });
	const require = createRequire(join(root, "package.json"));
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		let directory = dirname(require.resolve(name));
		while (true) {
			try {
				const candidate = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
				if (candidate.name === name) break;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			const parent = dirname(directory);
			assert(parent !== directory, `Unresolved required installed dependency: ${name}`);
			directory = parent;
		}
		queue.push(realpathSync(directory));
	}
}
console.log(JSON.stringify(packages));
