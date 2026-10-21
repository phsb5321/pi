import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { convert } from "/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/node_modules/ast-v8-to-istanbul/dist/index.mjs";

const require = createRequire("/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/package.json");
const { parse } = require("@babel/parser");
const { createCoverageMap } = require("istanbul-lib-coverage");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function convertBoundCoverage({ root, sources, outputs, coverage }) {
	root = realpathSync(root);
	const contained = (path) => {
		const file = resolve(path);
		const rel = relative(root, file);
		assert(rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "Out-of-root source/output");
		assert(realpathSync(file) === file, "Symlinked source/output forbidden");
		return file;
	};
	const known = new Map(sources.map((row) => {
		const file = contained(resolve(root, row.path));
		assert(sha256(readFileSync(file)) === row.sha256, "Source byte identity mismatch");
		return [file, row];
	}));
	const mapped = new Set();
	const result = createCoverageMap({});
	const synthesizedZero = [];
	for (const row of outputs) {
		assert(row.map, "Missing source map");
		const file = contained(resolve(root, row.path));
		const mapFile = contained(resolve(root, row.map));
		const code = readFileSync(file, "utf8");
		const bytes = readFileSync(mapFile);
		assert(sha256(Buffer.from(code)) === row.sha256 && sha256(bytes) === row.mapSha256, "Output/map byte identity mismatch");
		const map = JSON.parse(bytes);
		assert(map.version === 3 && map.mappings && map.sources.length && map.sourcesContent?.length === map.sources.length, "Unmapped source map");
		for (const [index, source] of map.sources.entries()) {
			assert(!source.includes("://"), "Nonlocal map source");
			const path = contained(resolve(dirname(file), map.sourceRoot || "", source));
			assert(known.has(path), "Undeclared source in map");
			assert(sha256(Buffer.from(map.sourcesContent[index])) === known.get(path).sha256, "Source-map content mismatch");
			mapped.add(path);
		}
		let script = coverage.result.find((item) => item.url === pathToFileURL(file).href);
		if (!script) {
			// Unexecuted declared output is zero, never removed from denominator.
			script = { url: pathToFileURL(file).href, functions: [{ functionName: "", isBlockCoverage: true,
				ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }] }] };
			synthesizedZero.push(file);
		}
		const data = await convert({ code, sourceMap: map, coverage: script,
			ast: parse(code, { sourceType: "module", plugins: ["estree"], ranges: true }).program });
		for (const path of Object.keys(data)) assert(known.has(resolve(path)), "Converted unmapped/foreign source");
		result.merge(data);
	}
	for (const path of known.keys()) {
		assert(mapped.has(path) && result.files().includes(path), "Eligible source missing from mapped denominator");
	}
	return { coverage: result.toJSON(), synthesizedZero };
}
