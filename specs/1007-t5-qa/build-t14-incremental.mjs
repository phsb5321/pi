import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildSourceGraph, eligible } from "./source-denominator.mjs";
import { sha256 } from "./source-map-coverage.mjs";
import { censusBinding, verifyIncrementalBinding, verifyPhysicalSource } from "./incremental-source-binding.mjs";

const own = import.meta.dirname;
const out = resolve(process.argv[2]);
assert(out.startsWith(resolve(own, "evidence") + "/"));
mkdirSync(out, { recursive: false });
const previousRoot = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1007-optin-source-maps";
const producer = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1008-native-nested-policy";
const basePath = own + "/evidence/t12-denominator-2334/source-graph-a2-method-fix/source-condition-graph.json";
const baseBytes = readFileSync(basePath);
assert.equal(sha256(baseBytes), "aafc156d3500f6dbe745e5c37cc089182d6160f655af6566d76c99619eaed1f2");
const base = JSON.parse(baseBytes);
const identity = { tuple: "T14-native-nested-policy-7c2021ac9f3c",
	sourceSha256: "7c2021ac9f3c1465767f868f2c391d3e21a83544902b6882e339ae3187743517",
	inputSha256: "7833c614065c0aa6966d751453e7dd445b040db44bb6f5a495851678c73b6976" };
const sourcePath = producer + "/evidence/native-nested-policy-source-manifest.json";
const sourceBytes = readFileSync(sourcePath);
assert.equal(sha256(sourceBytes), identity.sourceSha256);
assert.equal(sha256(readFileSync(producer + "/evidence/native-nested-policy-input-manifest.json")), identity.inputSha256);
const currentRows = JSON.parse(sourceBytes);
const previousBytes = readFileSync(previousRoot + "/evidence/source-map-checkpoint-source-manifest.json");
assert.equal(sha256(previousBytes), base.identity.sourceSha256);
const previousRows = JSON.parse(previousBytes);
const previous = new Map(previousRows.map(row => [row.path, row]));
const current = new Map(currentRows.map(row => [row.path, row]));
assert.equal(current.size, currentRows.length);
const treePath = own + "/evidence/t12-denominator-2334/source-graph-a2-method-fix/baseline-tree.raw";
const treeBytes = readFileSync(treePath);
assert.equal(sha256(treeBytes), base.baseline.stdoutSha256);
assert.equal(base.baseline.revision, "7c10bd4337495ee613f2224843ecdf349b80d1df");
assert.equal(base.baseline.tree, "de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0");
const baselineBlobs = Object.fromEntries(treeBytes.toString().split("\0").filter(Boolean).map(row => {
	const [metadata, path] = row.split("\t");
	return [path, metadata.split(" ")[2]];
}));
const sourceChanges = currentRows.filter(row => JSON.stringify(row) !== JSON.stringify(previous.get(row.path))).map(row => row.path);
const removedPaths = previousRows.filter(row => !current.has(row.path)).map(row => row.path);
const eligibleRows = currentRows.filter(row => eligible(row.path));
for (const row of eligibleRows) verifyPhysicalSource(producer + "/execution-source", row);
const deltaRows = eligibleRows.filter(row => !previous.has(row.path) ||
	["sha256", "blob", "mode"].some(key => previous.get(row.path)[key] !== row[key]));
const delta = await buildSourceGraph({ root: producer + "/execution-source", rows: deltaRows, baselineBlobs });
delta.identity = identity;
delta.baseline = base.baseline;
writeFileSync(out + "/delta-condition-graph.json", JSON.stringify(delta, null, 2));
const overlay = { schema: "memory-sound-incremental-source-condition-graph/1", root: delta.root, identity,
	baseIdentity: base.identity, baseGraph: { path: basePath, sha256: sha256(baseBytes) },
	baseline: base.baseline, eligiblePaths: eligibleRows.map(row => row.path),
	recensusedPaths: deltaRows.map(row => row.path), retainedFiles: {}, deltaFiles: delta.files,
	sourceChanges, removedPaths, changedPaths: [], observedCoverage: false, actualMapBinding: false, ACED: false };
for (const row of eligibleRows) {
	const file = delta.files[row.path] || base.files[row.path];
	assert.equal(file.baselineBlob, baselineBlobs[row.path] || null);
	if (!delta.files[row.path]) overlay.retainedFiles[row.path] = censusBinding(file);
	if (file.changed) overlay.changedPaths.push(row.path);
}
const accepted = verifyIncrementalBinding({ overlay, base, previousRows, currentRows, expectedIdentity: identity });
writeFileSync(out + "/incremental-source-condition-graph.json", JSON.stringify(overlay, null, 2));
const counts = Object.values(overlay.retainedFiles).concat(Object.values(delta.files).map(censusBinding));
const result = { ...accepted, identity, sourceChanges, removedPaths, recensusedPaths: overlay.recensusedPaths,
	changedRelativeToRelease: overlay.changedPaths.length, conditions: counts.reduce((n, row) => n + row.conditions, 0),
	statementSpans: counts.reduce((n, row) => n + row.statements, 0),
	graphSha256: sha256(readFileSync(out + "/incremental-source-condition-graph.json")),
	deltaGraphSha256: sha256(readFileSync(out + "/delta-condition-graph.json")),
	inheritedGraphSha256: sha256(baseBytes), physicalCurrentSourcesVerified: eligibleRows.length,
	productCompilerRuns: 0, sourceRuntimeImports: 0, oldMatrixReruns: 0 };
writeFileSync(out + "/result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
