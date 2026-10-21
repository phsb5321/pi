import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { eligible } from "./source-denominator.mjs";
import { sha256 } from "./source-map-coverage.mjs";

export function censusBinding(file) {
	assert.deepEqual(Object.keys(file.branchMap), Object.keys(file.zeroConditions), "Dropped condition group");
	for (const [id, branch] of Object.entries(file.branchMap)) {
		assert.equal(branch.locations.length, file.zeroConditions[id].length, "Dropped unexecuted condition arm");
		assert(file.zeroConditions[id].every(count => count === 0), "Static zero census acquired fake hits");
	}
	assert(Object.values(file.zeroStatements).every(count => count === 0));
	assert(Object.values(file.zeroFunctions).every(count => count === 0));
	return { sha256: sha256(Buffer.from(JSON.stringify(file))),
		conditions: Object.values(file.zeroConditions).reduce((n, arms) => n + arms.length, 0),
		statements: Object.keys(file.statementMap).length };
}

export function verifyIncrementalBinding({ overlay, base, previousRows, currentRows, expectedIdentity }) {
	assert.deepEqual(overlay.identity, expectedIdentity, "Stale T12/current source identity");
	assert.deepEqual(overlay.baseIdentity, base.identity, "Wrong inherited graph identity");
	const previous = new Map(previousRows.filter(row => eligible(row.path)).map(row => [row.path, row]));
	const current = new Map(currentRows.filter(row => eligible(row.path)).map(row => [row.path, row]));
	assert.equal(previous.size, Object.keys(base.files).length, "Incomplete inherited eligible graph");
	assert.equal(current.size, overlay.eligiblePaths.length, "Dropped eligible/unexecuted file");
	assert.deepEqual(new Set(overlay.eligiblePaths), new Set(current.keys()));
	const changed = [...current.values()].filter(row => {
		const old = previous.get(row.path);
		return !old || old.sha256 !== row.sha256 || old.blob !== row.blob || old.mode !== row.mode;
	}).map(row => row.path);
	assert.deepEqual(overlay.recensusedPaths, changed, "Wrong incremental recensus scope");
	assert.deepEqual(new Set(Object.keys(overlay.deltaFiles)), new Set(changed));
	assert.deepEqual(new Set(Object.keys(overlay.retainedFiles)), new Set([...current.keys()].filter(path => !changed.includes(path))));
	const releaseChanged = [];
	for (const [path, row] of current) {
		const retained = overlay.retainedFiles[path];
		const file = retained ? base.files[path] : overlay.deltaFiles[path];
		assert(file && file.sha256 === row.sha256 && file.blob === row.blob, "Mutated frozen source binding");
		if (retained) {
			assert(previous.get(path).sha256 === file.sha256 && previous.get(path).blob === file.blob);
			assert.deepEqual(retained, censusBinding(file), "Dropped unchanged unexecuted condition");
		} else censusBinding(file);
		if (file.changed) releaseChanged.push(path);
	}
	assert.deepEqual(overlay.changedPaths, releaseChanged, "Dropped release-relative changed source");
	return { status: "EXACT_CURRENT_INCREMENTAL_SOURCE_SCOPE_BOUND", eligible: current.size,
		recensused: changed.length, retained: Object.keys(overlay.retainedFiles).length, observedCoverage: false, ACED: false };
}

export function verifyPhysicalSource(root, row) {
	const file = resolve(root, row.path);
	assert(file.startsWith(realpathSync(root) + "/") && realpathSync(file) === file, "Foreign/symlinked current source");
	assert.equal(sha256(readFileSync(file)), row.sha256, "Mutated source bytes");
}
