import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ComposedInputManifest, type InputManifest, normalizeInputs, sha256, type SourceEntry, verifyInputs, verifySource } from "./identity.ts";

const [root, manifest, expectedSha, expectedCount, inputPath, inputSha] = process.argv.slice(2);
assert(root && manifest && expectedSha && expectedCount, "Usage: reconcile-source.ts ROOT MANIFEST SHA256 COUNT");
assert.equal(sha256(manifest), expectedSha, "Manifest bytes differ from selected receipt");
const entries = JSON.parse(readFileSync(manifest, "utf8")) as SourceEntry[];
const count = verifySource(root, entries);
assert.equal(count, Number(expectedCount), "Wrong source tuple count");
let inputs: { links: number; catalogue: number } | undefined;
if (inputPath) {
	assert.equal(sha256(inputPath), inputSha, "Input manifest bytes changed");
	const input = normalizeInputs(JSON.parse(readFileSync(inputPath, "utf8")) as InputManifest | ComposedInputManifest);
	inputs = verifyInputs(root, input, expectedSha);
	assert.equal(inputs.links, 274, "Wrong link tuple");
	assert.equal(inputs.catalogue, 43, "Wrong catalogue tuple");
}
process.stdout.write(`${JSON.stringify({
	result: "SOURCE_BLOB_MODE_PASS_NOT_BUILD_OR_NATIVE_ACCEPTANCE",
	root, manifest, manifestSha256: expectedSha, verifiedEntries: count, declaredInputs: inputs,
	thinPresentationPresent: existsSync(join(root, "packages/coding-agent/src/experimental/durable/thin-presentation.ts")),
	compilerRuns: 0, nativeTestRuns: 0,
})}\n`);
