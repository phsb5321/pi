import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSourceGraph } from "./source-denominator.mjs";
import { sha256 } from "./source-map-coverage.mjs";

const own = import.meta.dirname;
const out = resolve(process.argv[2]);
assert(out.startsWith(resolve(own, "evidence") + "/"));
mkdirSync(out, { recursive: false });
const base = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1007-optin-source-maps";
const sourceFile = base + "/evidence/source-map-checkpoint-source-manifest.json";
const inputFile = base + "/evidence/source-map-checkpoint-input-manifest.json";
const sourceSha = "59d93fa891b2def373cef7436555545a63e122c216b0a487e7cb9e57fddd0355";
const inputSha = "ac15f1c8c03e9ee362f109804262326a6de1b49d5128877e869122fc02c236b1";
assert.equal(sha256(readFileSync(sourceFile)), sourceSha);
assert.equal(sha256(readFileSync(inputFile)), inputSha);
const revision = "7c10bd4337495ee613f2224843ecdf349b80d1df";
const argv = ["git", "-C", resolve(own, "../.."), "ls-tree", "-r", "-z", revision];
const git = spawnSync(argv[0], argv.slice(1), { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(git.status, 0);
writeFileSync(out + "/baseline-tree.raw", git.stdout);
const baselineBlobs = Object.fromEntries(git.stdout.toString().split("\0").filter(Boolean).map(row => {
	const [metadata, path] = row.split("\t");
	return [path, metadata.split(" ")[2]];
}));
const graph = await buildSourceGraph({ root: base + "/execution-source", rows: JSON.parse(readFileSync(sourceFile, "utf8")), baselineBlobs });
graph.identity = { tuple: "T12-optin-source-maps-59d93fa891b2", sourceSha256: sourceSha, inputSha256: inputSha };
graph.baseline = { revision, tree: "de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0", command: argv, exit: git.status, stdoutSha256: sha256(git.stdout) };
writeFileSync(out + "/source-condition-graph.json", JSON.stringify(graph, null, 2));
const report = { status: "T12_COMPLETE_SOURCE_ZERO_CONDITION_CENSUS_BOUND", eligible: graph.eligiblePaths.length, changed: graph.changedPaths.length,
	statementSpans: Object.values(graph.files).reduce((n, f) => n + Object.keys(f.statementMap).length, 0),
	conditions: Object.values(graph.files).reduce((n, f) => n + Object.values(f.zeroConditions).reduce((a, b) => a + b.length, 0), 0),
	graphSha256: sha256(readFileSync(out + "/source-condition-graph.json")),
	identity: graph.identity, baseline: graph.baseline, observedCoverage: false, actualMapBinding: false, ACED: false,
	productCompilerRuns: 0, sourceRuntimeImports: 0 };
writeFileSync(out + "/result.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
