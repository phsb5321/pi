import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { convertBoundCoverage, sha256 } from "./source-map-coverage.mjs";

const require = createRequire("/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/package.json");
const { createCoverageMap } = require("istanbul-lib-coverage");
const libReport = require("istanbul-lib-report");
const reports = require("istanbul-reports");
const out = resolve(process.argv[2]);
assert(out.startsWith(resolve(import.meta.dirname, "evidence") + "/"));
mkdirSync(out, { recursive: false });
const root = join(out, "fixture");
mkdirSync(root);
writeFileSync(join(root, "covered.ts"), 'export function choose(n: number): string {\n if (n > 0) { return "positive"; }\n return "negative";\n}\n');
writeFileSync(join(root, "unexecuted.ts"), 'export function absent(flag: boolean): number {\n if (flag) { return 7; }\n return 9;\n}\n');
writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ES2022", target: "ES2022", sourceMap: true, inlineSources: true, types: [], outDir: "dist" }, files: ["covered.ts", "unexecuted.ts"] }));
writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
writeFileSync(join(root, "run.mjs"), 'import assert from "node:assert/strict";\nimport { choose } from "./dist/covered.js";\nassert.equal(choose(1), "positive");\n');
const commands = [];
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "LANG", "XDG_RUNTIME_DIR"].includes(key)));
safeEnv.UV_THREADPOOL_SIZE = "1";
function run(label, argv, env = safeEnv) {
	const child = spawnSync(argv[0], argv.slice(1), { env, timeout: 25000, maxBuffer: 1024 * 1024 });
	writeFileSync(join(out, label + ".log"), Buffer.concat([child.stdout || Buffer.alloc(0), child.stderr || Buffer.alloc(0)]));
	commands.push({ label, argv, exit: child.status });
	assert.equal(child.status, 0, label + ": " + child.stderr);
}
run("fixture-tsc", [process.execPath, "--v8-pool-size=1", "--max-old-space-size=128", "/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/node_modules/typescript/lib/tsc.js", "-p", join(root, "tsconfig.json")]);
const v8 = join(out, "v8");
mkdirSync(v8);
run("fixture-v8", [process.execPath, "--v8-pool-size=1", "--max-old-space-size=128", join(root, "run.mjs")], { ...safeEnv, NODE_V8_COVERAGE: v8 });
const raw = JSON.parse(readFileSync(join(v8, readdirSync(v8)[0]), "utf8"));
const sources = ["covered.ts", "unexecuted.ts"].map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
const outputs = ["covered", "unexecuted"].map(name => ({ path: "dist/" + name + ".js", map: "dist/" + name + ".js.map", sha256: sha256(readFileSync(join(root, "dist/" + name + ".js"))), mapSha256: sha256(readFileSync(join(root, "dist/" + name + ".js.map"))) }));
const inputs = { root, sources, outputs, coverage: raw };
const converted = await convertBoundCoverage(inputs);
const map = createCoverageMap(converted.coverage);
const covered = map.fileCoverageFor(join(root, "covered.ts")).toSummary().data;
const absent = map.fileCoverageFor(join(root, "unexecuted.ts")).toSummary().data;
assert(covered.lines.covered > 0 && covered.branches.total > covered.branches.covered, "Unexecuted branch disappeared");
assert(absent.lines.total > 0 && absent.lines.covered === 0 && absent.functions.covered === 0, "Unexecuted file disappeared");
assert.equal(converted.synthesizedZero.length, 1);
const checks = ["real TS compilation/V8 remap with uncovered branch", "never-loaded compiled TS file retained at zero"];
async function reject(name, changed) {
	await assert.rejects(convertBoundCoverage(changed));
	checks.push(name);
}
await reject("source-byte mismatch rejected", { ...inputs, sources: [{ ...sources[0], sha256: "0".repeat(64) }, sources[1]] });
await reject("missing source map rejected", { ...inputs, outputs: [{ ...outputs[0], map: null }, outputs[1]] });
const mapPath = join(root, outputs[0].map);
const original = readFileSync(mapPath);
for (const [name, mutate] of [
	["out-of-root map source rejected", data => { data.sources[0] = "../../../outside.ts"; }],
	["unmapped source map rejected", data => { data.mappings = ""; }],
	["source-map embedded content mismatch rejected", data => { data.sourcesContent[0] += " changed"; }],
]) {
	const data = JSON.parse(original);
	mutate(data);
	writeFileSync(mapPath, JSON.stringify(data));
	try { await reject(name, { ...inputs, outputs: [{ ...outputs[0], mapSha256: sha256(readFileSync(mapPath)) }, outputs[1]] }); }
	finally { writeFileSync(mapPath, original); }
}
writeFileSync(join(root, "orphan.ts"), "export const orphan = 3;\n");
await reject("unmapped eligible file rejected", { ...inputs, sources: [...sources, { path: "orphan.ts", sha256: sha256(readFileSync(join(root, "orphan.ts"))) }] });
const context = libReport.createContext({ dir: out, coverageMap: map });
reports.create("lcovonly").execute(context);
writeFileSync(join(out, "source-output-manifest.json"), JSON.stringify({ sources, outputs }, null, 2));
writeFileSync(join(out, "converted.json"), JSON.stringify(converted, null, 2));
const cgroup = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
const budget = Object.fromEntries(["cpu.max", "memory.max", "pids.max"].map(name => [name, readFileSync("/sys/fs/cgroup" + cgroup + "/" + name, "utf8").trim()]));
const result = { status: "REAL_TS_V8_SOURCE_MAP_FIXTURE_PASS", checks, commands, covered, unexecuted: absent,
	productCompilerEvents: 0, SonarScans: 0, ACEDOrNewCoverage80: false, eligibleFiles: sources.length, cgroup, budget };
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
