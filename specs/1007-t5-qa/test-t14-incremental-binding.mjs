import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./source-map-coverage.mjs";
import { verifyIncrementalBinding, verifyPhysicalSource } from "./incremental-source-binding.mjs";

const graphPath = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
assert(out.startsWith(resolve(import.meta.dirname, "evidence") + "/"));
mkdirSync(out, { recursive: false });
const graphBytes = readFileSync(graphPath);
const overlay = JSON.parse(graphBytes);
const baseBytes = readFileSync(overlay.baseGraph.path);
assert.equal(sha256(baseBytes), overlay.baseGraph.sha256);
const base = JSON.parse(baseBytes);
const previousRows = JSON.parse(readFileSync("/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1007-optin-source-maps/evidence/source-map-checkpoint-source-manifest.json"));
const currentBytes = readFileSync("/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1008-native-nested-policy/evidence/native-nested-policy-source-manifest.json");
const currentRows = JSON.parse(currentBytes);
const expectedIdentity = { tuple: "T14-native-nested-policy-7c2021ac9f3c",
	sourceSha256: "7c2021ac9f3c1465767f868f2c391d3e21a83544902b6882e339ae3187743517",
	inputSha256: "7833c614065c0aa6966d751453e7dd445b040db44bb6f5a495851678c73b6976" };
assert.equal(sha256(currentBytes), expectedIdentity.sourceSha256);
const packet = { overlay, base, previousRows, currentRows, expectedIdentity };
const accepted = verifyIncrementalBinding(packet);
const checks = ["actual frozen T14 full source/retained zero-condition scope accepts"];
const stale = { ...overlay, identity: base.identity };
assert.throws(() => verifyIncrementalBinding({ ...packet, overlay: stale }), /Stale T12/);
writeFileSync(out + "/stale-T12-identity.json", JSON.stringify(stale.identity, null, 2));
checks.push("stale T12 source/input identity rejects");
const row = currentRows.find(row => overlay.recensusedPaths.includes(row.path));
const source = readFileSync(resolve(overlay.root, row.path));
const fixtureRoot = out + "/mutated-source";
mkdirSync(fixtureRoot);
writeFileSync(fixtureRoot + "/mutated.ts", Buffer.concat([source, Buffer.from("\n// mutated negative bytes\n")]));
assert.throws(() => verifyPhysicalSource(fixtureRoot, { ...row, path: "mutated.ts" }), /Mutated source bytes/);
checks.push("physical mutated source bytes reject without editing producer source");
const retainedPath = Object.keys(overlay.retainedFiles).find(path => overlay.retainedFiles[path].conditions > 0);
assert(retainedPath);
const badFile = structuredClone(base.files[retainedPath]);
const branchId = Object.keys(badFile.zeroConditions).find(id => badFile.zeroConditions[id].length > 0);
badFile.zeroConditions[branchId].pop();
const badBase = { ...base, files: { ...base.files, [retainedPath]: badFile } };
assert.throws(() => verifyIncrementalBinding({ ...packet, base: badBase }), /Dropped unexecuted condition arm/);
writeFileSync(out + "/dropped-unexecuted-condition.json", JSON.stringify({ retainedPath, branchId, badFile }, null, 2));
checks.push("dropped inherited unexecuted condition rejects");
const result = { status: "T14_INCREMENTAL_SOURCE_BINDING_CHECK_PASS", count: checks.length, checks,
	graphSha256: sha256(graphBytes), identity: expectedIdentity, accepted,
	fixtureControlsOnly: true, observedV8Coverage: false, ACED: false,
	productCompilerRuns: 0, oldMatrixReruns: 0, sourceRuntimeImports: 0 };
writeFileSync(out + "/result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
