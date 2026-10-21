import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { buildSourceGraph, eligible } from "./source-denominator.mjs";
import { sha256 } from "./source-map-coverage.mjs";
import { censusBinding, verifyIncrementalBinding, verifyPhysicalSource } from "./incremental-source-binding.mjs";

const own = import.meta.dirname;
const out = resolve(process.argv[2]);
assert(out.startsWith(resolve(own, "evidence") + "/"));
mkdirSync(out, { recursive: false });
const previousProducer = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1008-native-nested-policy";
const producer = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1008-native-nested-type-repair";
const basePath = own + "/evidence/t14-incremental-1008-1214/source-a1/incremental-source-condition-graph.json";
const baseSha = "0a145e6ee1e923154480ef0d77e61ef80d5aad6e110436dd7e2fad61961bcbd1";
const identity = { tuple: "T15-native-nested-type-repair-c60ad0ff1455",
	sourceSha256: "c60ad0ff14551d1f2e0714d9168ed3a2ac534d3991c725c8087da165038ef96d",
	inputSha256: "a7da1f25fd1bcdf327c12b5cbee52cee7abe793d4550d10363370d3045cc9ef7" };
const visited = new Set();
function inheritedGraph(path, digest) {
	assert(path.startsWith(own + "/evidence/") && realpathSync(path) === path && !visited.has(path), "Foreign/cyclic inherited graph");
	visited.add(path);
	const bytes = readFileSync(path);
	assert.equal(sha256(bytes), digest, "Inherited graph bytes drifted");
	const graph = JSON.parse(bytes);
	if (graph.files) return graph;
	const parent = inheritedGraph(graph.baseGraph.path, graph.baseGraph.sha256);
	const files = Object.fromEntries(graph.eligiblePaths.map(path => [path, graph.deltaFiles[path] || parent.files[path]]));
	for (const [path, binding] of Object.entries(graph.retainedFiles)) assert.deepEqual(censusBinding(files[path]), binding);
	return { ...graph, files };
}
const base = inheritedGraph(basePath, baseSha);
const previousBytes = readFileSync(previousProducer + "/evidence/native-nested-policy-source-manifest.json");
assert.equal(sha256(previousBytes), base.identity.sourceSha256);
const previousRows = JSON.parse(previousBytes);
const sourceBytes = readFileSync(producer + "/evidence/repair-source-manifest.json");
assert.equal(sha256(sourceBytes), identity.sourceSha256);
assert.equal(sha256(readFileSync(producer + "/evidence/repair-input-manifest.json")), identity.inputSha256);
const currentRows = JSON.parse(sourceBytes);
const previous = new Map(previousRows.map(row => [row.path, row]));
const current = new Map(currentRows.map(row => [row.path, row]));
assert.equal(currentRows.length, 2030);
assert.equal(current.size, currentRows.length);
assert(previousRows.every(row => current.has(row.path)), "Unexpected removed source");
const changedRows = currentRows.filter(row => JSON.stringify(row) !== JSON.stringify(previous.get(row.path)));
const target = "packages/coding-agent/src/experimental/durable/extension-composition.ts";
assert.deepEqual(changedRows.map(row => row.path), [target], "Not the authorized single-file delta");
const eligibleRows = currentRows.filter(row => eligible(row.path));
assert(eligible(target));
for (const row of eligibleRows) verifyPhysicalSource(producer + "/execution-source", row);
const delta = await buildSourceGraph({ root: producer + "/execution-source", rows: changedRows,
	baselineBlobs: { [target]: base.files[target].baselineBlob } });
delta.identity = identity;
delta.baseline = base.baseline;
writeFileSync(out + "/delta-condition-graph.json", JSON.stringify(delta, null, 2));
const overlay = { schema: "memory-sound-incremental-source-condition-graph/1", root: delta.root, identity,
	baseIdentity: base.identity, baseGraph: { path: basePath, sha256: baseSha }, baseline: base.baseline,
	eligiblePaths: eligibleRows.map(row => row.path), recensusedPaths: [target], retainedFiles: {}, deltaFiles: delta.files,
	changedPaths: [], outputSha256: null, artifactReceipt: null, newCoverage: null,
	observedCoverage: false, actualMapBinding: false, ACED: false };
for (const row of eligibleRows) {
	const file = delta.files[row.path] || base.files[row.path];
	if (!delta.files[row.path]) overlay.retainedFiles[row.path] = censusBinding(file);
	if (file.changed) overlay.changedPaths.push(row.path);
}
function checkSourceOnly(candidate, inherited = base) {
	assert(candidate.outputSha256 === null && candidate.artifactReceipt === null, "Fabricated artifact in source-only binding");
	assert(candidate.newCoverage === null && candidate.observedCoverage === false && candidate.actualMapBinding === false && candidate.ACED === false,
		"Fabricated observed coverage/ACED in source-only binding");
	return verifyIncrementalBinding({ overlay: candidate, base: inherited, previousRows, currentRows, expectedIdentity: identity });
}
const accepted = checkSourceOnly(overlay);
assert.equal(accepted.recensused, 1);
assert.equal(accepted.retained, 928);
const checks = ["current exact T15 one-file delta and928retained zero scopes accept"];
const stale = { ...overlay, identity: base.identity };
assert.throws(() => checkSourceOnly(stale), /source identity/);
writeFileSync(out + "/stale-T14-identity.json", JSON.stringify(stale.identity, null, 2));
checks.push("stale T14 identity rejects");
const retainedPath = Object.keys(overlay.retainedFiles).find(path => overlay.retainedFiles[path].conditions > 0);
const badFile = structuredClone(base.files[retainedPath]);
const branchId = Object.keys(badFile.zeroConditions).find(id => badFile.zeroConditions[id].length > 0);
badFile.zeroConditions[branchId].pop();
assert.throws(() => checkSourceOnly(overlay, { ...base, files: { ...base.files, [retainedPath]: badFile } }), /Dropped unexecuted condition arm/);
writeFileSync(out + "/dropped-unexecuted-condition.json", JSON.stringify({ retainedPath, branchId, badFile }, null, 2));
checks.push("dropped inherited unexecuted condition rejects");
assert.throws(() => checkSourceOnly({ ...overlay, outputSha256: "0".repeat(64), artifactReceipt: {} }), /Fabricated artifact/);
checks.push("fabricated artifact rejects");
assert.throws(() => checkSourceOnly({ ...overlay, newCoverage: 100, observedCoverage: true, ACED: true }), /Fabricated observed coverage/);
checks.push("fabricated observed coverage/ACED rejects");
writeFileSync(out + "/incremental-source-condition-graph.json", JSON.stringify(overlay, null, 2));
const bindings = Object.values(overlay.retainedFiles).concat(Object.values(delta.files).map(censusBinding));
const result = { ...accepted, identity, checks, checkCount: checks.length, sourceChanges: [target],
	changedRelativeToRelease: overlay.changedPaths.length, conditions: bindings.reduce((n, row) => n + row.conditions, 0),
	statementSpans: bindings.reduce((n, row) => n + row.statements, 0), inheritedGraphSha256: baseSha,
	graphSha256: sha256(readFileSync(out + "/incremental-source-condition-graph.json")),
	deltaGraphSha256: sha256(readFileSync(out + "/delta-condition-graph.json")), physicalCurrentSourcesVerified: eligibleRows.length,
	productCompilerRuns: 0, sourceRuntimeImports: 0, oldMatrixReruns: 0, actualMapBinding: false };
writeFileSync(out + "/result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
