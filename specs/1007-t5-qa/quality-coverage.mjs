// Actual V8 -> qualified composed-map converter -> complete conservative source denominator.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertBoundCoverage, sha256 } from './source-map-coverage.mjs';
import { censusBinding } from './incremental-source-binding.mjs';

const require = createRequire('/home/notroot/Documents/Code/pi-upstream-ms-g4-bundle/package.json');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const bind = path => ({ path: resolve(path), sha256: sha256(readFileSync(path)) });
function document(binding) {
  assert.equal(sha256(readFileSync(binding.path)), binding.sha256, 'Coverage document drift');
  return JSON.parse(readFileSync(binding.path, 'utf8'));
}
function graph(binding, depth = 0) {
  assert(depth < 8, 'Unbounded source overlays');
  const row = document(binding);
  if (row.files) return row;
  const base = graph(row.baseGraph, depth + 1);
  assert.deepEqual(row.baseIdentity, base.identity);
  const files = {};
  for (const path of row.eligiblePaths) {
    files[path] = row.deltaFiles[path] ?? base.files[path];
    assert(files[path], 'Dropped unused source');
    if (row.retainedFiles[path]) assert.deepEqual(censusBinding(files[path]), row.retainedFiles[path]);
    else censusBinding(files[path]);
  }
  return { ...row, files };
}
const [planPath, out] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const manifest = document(plan.manifest);
const artifact = document(manifest.artifactReceipt);
const census = graph(manifest.sourceConditionGraph);
const partition = document(manifest.releaseRelativePartition);
assert.deepEqual(census.identity, { tuple: manifest.identity.tuple, sourceSha256: manifest.identity.sourceSha256, inputSha256: manifest.identity.inputSha256 });
assert.deepEqual(partition.identity, census.identity);
assert.equal(partition.sourceGraphSha256, manifest.sourceConditionGraph.sha256);
assert.deepEqual(new Set(census.eligiblePaths), new Set(manifest.eligibleSources.map(row => row.path)));
assert.deepEqual(new Set(Object.keys(partition.files)), new Set(manifest.expectedNewSources));
const inventory = document(plan.mapInventory);
assert.equal(inventory.schema, 'pi-shared-tty-source-map-inventory/1');
assert.equal(resolve(inventory.root), resolve(artifact.sourceRoot));
const root = resolve(plan.root);
const rows = new Map();
const known = new Map();
for (const row of manifest.eligibleSources) {
  const path = resolve(artifact.sourceRoot, row.path);
  assert.equal(sha256(readFileSync(path)), row.sha256);
  assert.equal(census.files[row.path].sha256, row.sha256);
  known.set(path, { path, sha256: row.sha256 });
}
const mapped = new Set();
const nonExecutable = [];
for (const row of [...inventory.inputs, ...inventory.outputs]) {
  const path = resolve(inventory.root, row.path);
  const map = resolve(inventory.root, row.map);
  assert.equal(artifact.runtimeFiles[path], row.sha256, 'Generated output outside runtime');
  assert.equal(artifact.runtimeFiles[map], row.mapSha256, 'Map outside runtime');
  assert.equal(sha256(readFileSync(path)), row.sha256);
  assert.equal(sha256(readFileSync(map)), row.mapSha256);
  const data = JSON.parse(readFileSync(map, 'utf8'));
  assert.equal(data.version, 3);
  assert(data.sources.length && data.sources.length === data.sourcesContent?.length);
  for (const [i, source] of data.sources.entries()) {
    assert(!source.includes('://'));
    const file = resolve(dirname(path), data.sourceRoot || '', source);
    const hash = sha256(Buffer.from(data.sourcesContent[i]));
    assert.equal(sha256(readFileSync(file)), hash, 'Unproven map source bytes');
    if (!known.has(file)) {
      // A real vendor source must be explicitly publisher-bound, not relabelled as first-party.
      assert.equal(artifact.producerBindings[file] ?? artifact.runtimeFiles[file], hash, 'Missing vendor-map provenance');
      known.set(file, { path: file, sha256: hash });
    }
    if (!data.mappings) {
      const eligible = relative(artifact.sourceRoot, file);
      const zero = census.files[eligible];
      assert(zero && Object.keys(zero.statementMap).length === 0 && Object.keys(zero.branchMap).length === 0,
        'Executable empty map cannot become a coverage exclusion');
    } else mapped.add(file);
  }
  if (!data.mappings) {
    assert(row.noExecutableCode === true && /^\s*export\s*\{\s*\}\s*;?\s*(?:\/\/[^\n]*\s*)*$/.test(readFileSync(path, 'utf8')),
      'No executable-code proof for empty mappings');
    nonExecutable.push({ output: bind(path), map: bind(map) });
    continue;
  }
  const normalized = { ...row, path, map };
  if (rows.has(path)) assert.deepEqual(rows.get(path), normalized, 'Conflicting map rows');
  rows.set(path, normalized);
}
assert(rows.size, 'No actual executable maps');
const coverage = createCoverageMap({});
const seenPids = new Set();
for (const binding of plan.v8) {
  const raw = document(binding);
  assert(Array.isArray(raw.result) && raw.result.length, 'Empty/non-V8 capture');
  const match = /coverage-(\d+)-/.exec(binding.path);
  assert(match, 'Missing actual Node coverage PID');
  seenPids.add(Number(match[1]));
  for (const script of raw.result) {
    if (!script.url.startsWith('file:')) continue;
    const file = fileURLToPath(script.url);
    assert(!(/\.(?:[cm]?ts|tsx)$/.test(file) && file.startsWith(artifact.sourceRoot + '/')), 'Product TS loaded for coverage');
    if (file.startsWith(artifact.sourceRoot + '/packages/') && file.includes('/dist/') || file.startsWith(artifact.root + '/dist/')) {
      assert(rows.has(file) || nonExecutable.some(row => row.output.path === file), 'Loaded first-party JS lacks a bound map');
    }
  }
  const converted = await convertBoundCoverage({ root, sources: [...known.values()].filter(row => mapped.has(row.path)),
    outputs: [...rows.values()], coverage: raw });
  coverage.merge(converted.coverage); // Merge every PID/document; find-first would silently lose A/API coverage.
}
for (const pid of plan.requiredPids) assert(seenPids.has(pid), 'API/focused child raw V8 missing');
assert(plan.requiredPids.length >= 4, 'Shared-only capture cannot supply native API coverage');
const location = loc => JSON.stringify(loc);
const files = {};
const newCodeSources = {};
const lcovCoverage = createCoverageMap({});
for (const path of census.eligiblePaths) {
  const zero = census.files[path];
  const absolute = resolve(artifact.sourceRoot, path);
  const actual = coverage.files().includes(absolute) ? coverage.fileCoverageFor(absolute).toJSON() : undefined;
  const s = { ...zero.zeroStatements };
  const b = Object.fromEntries(Object.entries(zero.zeroConditions).map(([id, values]) => [id, [...values]]));
  if (actual) {
    for (const [id, loc] of Object.entries(zero.statementMap)) {
      for (const [key, target] of Object.entries(actual.statementMap)) if (location(loc) === location(target)) s[id] += actual.s[key];
    }
    for (const [id, branch] of Object.entries(zero.branchMap)) {
      for (const [key, target] of Object.entries(actual.branchMap)) {
        if (branch.type === target.type && location(branch.loc) === location(target.loc) &&
            location(branch.locations) === location(target.locations)) {
          assert.equal(actual.b[key].length, b[id].length);
          b[id] = b[id].map((count, index) => count + actual.b[key][index]);
        }
      }
    }
  }
  // Never infer hits for unmatched/static condition candidates, including implicit arms.
  const item = { path: absolute, statementMap: zero.statementMap, fnMap: zero.functionMap,
    branchMap: zero.branchMap, s, f: { ...zero.zeroFunctions }, b };
  lcovCoverage.addFileCoverage(item);
  const lineHits = lcovCoverage.fileCoverageFor(absolute).getLineCoverage();
  const conditions = Object.values(b).flat();
  files[path] = { sourceSha256: zero.sha256, lines: { total: Object.keys(lineHits).length,
    covered: Object.values(lineHits).filter(n => n > 0).length }, conditions: { total: conditions.length, covered: conditions.filter(n => n > 0).length } };
  if (partition.files[path]) {
    const part = partition.files[path];
    assert.equal(part.sourceSha256, zero.sha256);
    const lines = part.changedLines.filter(line => Object.hasOwn(lineHits, line));
    const arms = [];
    assert.deepEqual(Object.keys(part.conditions), Object.keys(b));
    for (const [id, group] of Object.entries(part.conditions)) {
      assert.equal(group.locations.length, b[id].length);
      for (const index of group.potentialNewArmIndices) { assert(index < b[id].length); arms.push(b[id][index]); }
    }
    newCodeSources[path] = { lines: { total: lines.length, covered: lines.filter(line => lineHits[line] > 0).length },
      conditions: { total: arms.length, covered: arms.filter(n => n > 0).length } };
  }
}
reports.create('lcovonly', { file: 'lcov.info' }).execute(createContext({ dir: out, coverageMap: lcovCoverage }));
const counts = Object.values(newCodeSources).flatMap(row => [row.lines, row.conditions]);
const total = counts.reduce((n, row) => n + row.total, 0);
const hits = counts.reduce((n, row) => n + row.covered, 0);
assert(total > 0);
const result = { identity: manifest.identity, fixture: false, kind: 'source-mapped-TS-V8', sourceMapped: true,
  observedV8: true, mapsBoundToArtifact: true, completeChangedSourceConditionAccounting: true,
  newCoverage: 100 * hits / total, files, newCodeSources, mapFiles: [...rows.values()].map(row => bind(row.map)),
  rawFiles: [...plan.v8, plan.mapInventory, manifest.sourceConditionGraph, manifest.releaseRelativePartition,
    ...nonExecutable.flatMap(row => [row.output, row.map]), bind(resolve(out, 'lcov.info'))],
  conservativeUnmatchedConditionsStayZero: true, observedPids: [...seenPids], staticGraphNeverTreatedAsV8: true };
writeFileSync(resolve(out, 'coverage-result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ eligible: Object.keys(files).length, newCoverage: result.newCoverage, pids: result.observedPids }));
