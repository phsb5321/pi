import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildSourceGraph, bindMapGraph } from "./source-denominator.mjs";

const out = resolve(process.argv[2]);
assert(out.startsWith(resolve(import.meta.dirname, "evidence") + "/"));
mkdirSync(out, { recursive: false });
const fixture = "/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1007-optin-source-maps/evidence/map-package-fixture-a1";
const inventoryBytes = readFileSync(fixture + "/map-inventory.json");
const inventory = JSON.parse(inventoryBytes);
const rows = inventory.sources.map(row => {
	const data = readFileSync(resolve(inventory.root, row.path));
	return { ...row, blob: createHash("sha1").update("blob " + data.length + "\0").update(data).digest("hex") };
});
const graph = await buildSourceGraph({ root: inventory.root, rows, baselineBlobs: { [rows[0].path]: rows[0].blob } });
const accepted = bindMapGraph(inventory, graph);
assert.equal(graph.eligiblePaths.length, 3);
assert.equal(graph.changedPaths.length, 2);
const never = graph.files[graph.eligiblePaths.find(path => path.endsWith("/never.ts"))];
assert(never && Object.values(never.zeroConditions).flat().every(n => n === 0) && Object.values(never.zeroConditions).flat().length > 0);
const checks = ["actual composed producer fixture maps bind complete eligible/changed source graph", "never-executed source conditions retained as zero census, not observed coverage"];
const abstractCode = Buffer.from('export abstract class Shape { abstract size(): number; actual(n: number) { if (n) return 1; return 0; } }\n');
writeFileSync(out + "/abstract.ts", abstractCode);
const abstractRow = { path: "abstract.ts", sha256: createHash("sha256").update(abstractCode).digest("hex"),
	blob: createHash("sha1").update("blob " + abstractCode.length + "\0").update(abstractCode).digest("hex") };
const abstractGraph = await buildSourceGraph({ root: out, rows: [abstractRow], baselineBlobs: {} });
assert(abstractGraph.eligiblePaths.length === 1 && Object.values(abstractGraph.files["abstract.ts"].zeroConditions).flat().length >= 2);
checks.push("bodyless type-only method does not crash or remove executable sibling conditions");
for (const [name, mutate] of [
	["omitted eligible source rejected", data => data.sources.pop()],
	["wrong source hash rejected", data => { data.sources[0].sha256 = "0".repeat(64); }],
	["wrong source root rejected", data => { data.root = out; }],
	["unexecuted output omission rejected", data => { data.outputs = data.outputs.filter(row => !row.path.endsWith("/never.js")); }],
]) {
	const negative = structuredClone(inventory);
	mutate(negative);
	assert.throws(() => bindMapGraph(negative, graph));
	checks.push(name);
	writeFileSync(out + "/" + checks.length + "-negative.json", JSON.stringify(negative, null, 2));
}
const result = { status: "T12_MAP_DENOMINATOR_CONTRACT_FIXTURE_PASS", checks, count: checks.length, fixture: true,
	fixtureInventorySha256: createHash("sha256").update(inventoryBytes).digest("hex"), accepted,
	productCompilerRuns: 0, oldMatrixReruns: 0, sourceRuntimeImports: 0, observedCoverage: false, ACED: false };
writeFileSync(out + "/graph.json", JSON.stringify(graph, null, 2));
writeFileSync(out + "/result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
