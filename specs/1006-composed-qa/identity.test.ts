import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACED_LIMITS, type ArtifactReceipt, type InputManifest, sha256, type SourceEntry, verifyAced, verifyArtifact, verifyInputs, verifySource } from "./identity.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "msqa-oracle-"));
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "fixture.ts"), "export {};\n");
	writeFileSync(join(root, "source.json"), JSON.stringify([{ path: "fixture.ts", mode: "100644", stage: 0,
		blob: createHash("sha1").update("blob 11\0export {};\n").digest("hex") }]));
	writeFileSync(join(root, "input.json"), JSON.stringify({ count: 0, symlinks: [], overlay_data_files: {},
		selected_manifest_sha256: sha256(join(root, "source.json")) }));
	writeFileSync(join(root, "build.log"), "all declared build stages exit=0\n");
	writeFileSync(join(root, "dist/runtime.js"), "export const fixture = true;\n");
	const receipt: ArtifactReceipt = {
		schema: "memory-sound-qa-artifact/1", root, sourceRoot: root,
		sourceManifest: { path: join(root, "source.json"), sha256: sha256(join(root, "source.json")) },
		inputManifest: { path: join(root, "input.json"), sha256: sha256(join(root, "input.json")) },
		build: { exit: 0, complete: true, log: join(root, "build.log"), logSha256: sha256(join(root, "build.log")) },
		modules: { "msqa/runtime": "dist/runtime.js" },
		runtimeFiles: { [join(root, "dist/runtime.js")]: sha256(join(root, "dist/runtime.js")) },
	};
	return { root, receipt };
}

test("oracle only: Git blob and executable mode, with tamper/path/duplicate red controls", (t) => {
	const { root } = fixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "owned.ts"), "export {};\n");
	const entry: SourceEntry = { path: "owned.ts", mode: "100644", stage: 0,
		blob: createHash("sha1").update("blob 11\0export {};\n").digest("hex") };
	assert.equal(verifySource(root, [entry]), 1);
	assert.throws(() => verifySource(root, [entry, entry]), /Duplicate/);
	assert.throws(() => verifySource(root, [{ ...entry, path: "../outside" }]), /Escaping/);
	assert.throws(() => verifySource(root, [{ ...entry, path: "/etc/passwd" }]), /Absolute/);
	chmodSync(join(root, "owned.ts"), 0o755);
	assert.throws(() => verifySource(root, [entry]), /Mode mismatch/);
	chmodSync(join(root, "owned.ts"), 0o644);
	writeFileSync(join(root, "owned.ts"), "changed\n");
	assert.throws(() => verifySource(root, [entry]), /Blob mismatch/);
});

test("oracle only: reject historical/missing/incomplete or source-substituted artifact", (t) => {
	const { root, receipt } = fixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	verifyArtifact(receipt);
	assert.throws(() => verifyArtifact({ ...receipt, build: { ...receipt.build, exit: 2 } }), /Build failed/);
	assert.throws(() => verifyArtifact({ ...receipt, build: { ...receipt.build, complete: false } }), /Build incomplete/);
	assert.throws(() => verifyArtifact({ ...receipt, modules: {} }), /No composed modules/);
	assert.throws(() => verifyArtifact({ ...receipt, modules: { "msqa/runtime": "../wrong.js" } }), /Escaping/);
	assert.throws(() => verifyArtifact({ ...receipt, runtimeFiles: {} }), /Unbound/);
	writeFileSync(join(root, "fixture.ts"), "source drift\n");
	assert.throws(() => verifyArtifact(receipt), /Blob mismatch/);
	writeFileSync(join(root, "fixture.ts"), "export {};\n");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/runtime.ts"), "export {};\n");
	assert.throws(() => verifyArtifact({ ...receipt, modules: { "msqa/runtime": "src/runtime.ts" } }), /Not compiled/);
	symlinkSync(join(root, "dist/runtime.js"), join(root, "dist/alias.js"));
	assert.throws(() => verifyArtifact({ ...receipt, modules: { "msqa/runtime": "dist/alias.js" } }), /symlink substitution/);
	writeFileSync(join(root, "dist/runtime.js"), "stale or replaced output\n");
	assert.throws(() => verifyArtifact(receipt), /Runtime identity mismatch/);
});

test("oracle only: inputs reject source drift, alias replacement and catalogue tamper", (t) => {
	const { root } = fixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "packages/ai/src/providers/data"), { recursive: true });
	const catalogue = join(root, "packages/ai/src/providers/data/faux.json");
	writeFileSync(catalogue, "{}");
	symlinkSync(join(root, "dist"), join(root, "dependency"));
	const input: InputManifest = { count: 1, selected_manifest_sha256: "fixture-source-sha",
		symlinks: [{ path: "dependency", target: join(root, "dist") }], overlay_data_files: { "faux.json": sha256(catalogue) } };
	assert.deepEqual(verifyInputs(root, input, "fixture-source-sha"), { links: 1, catalogue: 1 });
	assert.throws(() => verifyInputs(root, input, "other-source"), /wrong source/);
	assert.throws(() => verifyInputs(root, { ...input, count: 2 }, "fixture-source-sha"), /count mismatch/);
	assert.throws(() => verifyInputs(root, { ...input, symlinks: [{ path: "dependency", target: join(root, "other") }] }, "fixture-source-sha"), /target changed/);
	writeFileSync(catalogue, "changed");
	assert.throws(() => verifyInputs(root, input, "fixture-source-sha"), /Catalogue changed/);
});

test("oracle only: all ACED measures mandatory; every threshold has a red control", () => {
	const green = Object.fromEntries(Object.entries(ACED_LIMITS).map(([metric, limit]) => [metric, limit.value]));
	verifyAced(green);
	for (const [metric, limit] of Object.entries(ACED_LIMITS)) {
		const missing = { ...green };
		delete missing[metric];
		assert.throws(() => verifyAced(missing), /Missing/);
		assert.throws(() => verifyAced({ ...green, [metric]: null }), /Missing/);
		assert.throws(() => verifyAced({ ...green, [metric]: Number.NaN }), /invalid/);
		assert.throws(() => verifyAced({ ...green, [metric]: limit.value + (limit.direction === "max" ? 0.01 : -0.01) }), /ACED failed/);
	}
});
