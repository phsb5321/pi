import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { convert } from "/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/node_modules/ast-v8-to-istanbul/dist/index.mjs";
import { sha256 } from "./source-map-coverage.mjs";

const require = createRequire("/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/package.json");
const { parse } = require("@babel/parser");
export function eligible(path) {
	return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path) &&
		!/(^|\/)(test|tests)\/|\.(test|spec)\./.test(path);
}
function contained(root, path) {
	const file = resolve(root, path);
	const rel = relative(root, file);
	assert(rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"), "Out-of-root denominator source");
	assert(realpathSync(file) === file, "Symlinked denominator source");
	return file;
}
export async function buildSourceGraph({ root, rows, baselineBlobs }) {
	root = realpathSync(root);
	const files = {};
	for (const row of rows.filter(row => eligible(row.path))) {
		const path = contained(root, row.path);
		const bytes = readFileSync(path);
		assert(sha256(bytes) === row.sha256, "Frozen source byte drift");
		const blob = createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
		assert(blob === row.blob, "Frozen Git blob drift");
		const code = bytes.toString("utf8");
		const plugins = ["estree", "decorators-legacy"];
		if (/\.[cm]?tsx?$/.test(row.path)) plugins.push("typescript");
		if (/\.[jt]sx$/.test(row.path)) plugins.push("jsx");
		const ast = parse(code, { sourceType: "unambiguous", plugins, ranges: true }).program;
		// Static all-zero census only: never import/execute source or call it V8 observation.
		let census;
		try {
			census = await convert({ code, ast,
				ignoreNode: node => node.type === "MethodDefinition" && !node.value?.body ? "ignore-this-and-nested-nodes" : undefined,
				coverage: { url: pathToFileURL(path).href,
					functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }] }] } });
		} catch (error) {
			error.message = row.path + ": " + error.message;
			throw error;
		}
		const coverage = census[path];
		assert(coverage, "Source condition census omitted file");
		assert(Object.values(coverage.s).every(n => n === 0) && Object.values(coverage.b).flat().every(n => n === 0));
		files[row.path] = { sha256: row.sha256, blob, baselineBlob: baselineBlobs[row.path] || null,
			changed: baselineBlobs[row.path] !== blob, statementMap: coverage.statementMap, functionMap: coverage.fnMap,
			branchMap: coverage.branchMap, zeroStatements: coverage.s, zeroFunctions: coverage.f, zeroConditions: coverage.b };
	}
	return { schema: "memory-sound-source-condition-graph/1", root, files,
		eligiblePaths: Object.keys(files), changedPaths: Object.keys(files).filter(path => files[path].changed),
		classification: "STATIC_SOURCE_ZERO_CENSUS_NOT_OBSERVED_V8_OR_NEW_CODE_COVERAGE",
		completeSourceDenominator: true, actualMapBinding: false, observedCoverage: false };
}
export function bindMapGraph(inventory, graph) {
	assert(inventory.schema === "pi-shared-tty-source-map-inventory/1", "Wrong actual map schema");
	const root = realpathSync(inventory.root);
	assert(root === realpathSync(graph.root), "Wrong map/denominator source root");
	const sourceRows = new Map(inventory.sources.map(row => [row.path, row.sha256]));
	assert(sourceRows.size === inventory.sources.length, "Duplicate map sources");
	const required = new Set(graph.eligiblePaths);
	assert(required.size === sourceRows.size && [...required].every(path => sourceRows.get(path) === graph.files[path].sha256),
		"Eligible/unexecuted source omitted or mismatched from map graph");
	const mapped = new Set();
	for (const row of [...inventory.inputs, ...inventory.outputs]) {
		const file = contained(root, row.path);
		const mapPath = contained(root, row.map);
		assert(sha256(readFileSync(file)) === row.sha256 && sha256(readFileSync(mapPath)) === row.mapSha256, "Output/input/map byte mismatch");
		const map = JSON.parse(readFileSync(mapPath, "utf8"));
		assert(map.version === 3 && map.mappings && map.sourcesContent?.length === map.sources.length, "Unmapped composed map");
		for (const [index, source] of map.sources.entries()) {
			assert(!source.includes("://"), "Virtual/nonlocal source");
			const sourceFile = contained(root, resolve(dirname(mapPath), map.sourceRoot || "", source));
			const path = relative(root, sourceFile);
			assert(required.has(path) && sha256(Buffer.from(map.sourcesContent[index])) === graph.files[path].sha256,
				"Unmapped/uncomposed/foreign source content");
			if (inventory.outputs.includes(row)) mapped.add(path);
		}
	}
	assert([...required].every(path => mapped.has(path)), "Eligible source absent from emitted output maps");
	return { status: "SOURCE_MAP_DENOMINATOR_BOUND_NOT_OBSERVED_COVERAGE", eligiblePaths: [...required],
		changedPaths: graph.changedPaths, sourceConditions: Object.values(graph.files).reduce((n, file) => n + Object.values(file.zeroConditions).reduce((a, b) => a + b.length, 0), 0),
		observedCoverage: false, ACED: false };
}
