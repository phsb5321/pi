import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// One existing focused compiled battery, not the repository/e2e suite.
// Launch only after an exact matching compiled behavioral PASS, in heavy admission.
test("exact accepted compiled native-rich PTY coverage rerun", { timeout: 110_000 }, () => {
	const previous = JSON.parse(readFileSync(process.env.MSQA_COMPILED_PASS, "utf8"));
	assert.equal(previous.status, "COMPILED_FOCUSED_QA_PASS");
	assert.equal(previous.identity.executionMode, "compiled-native-rich-pty");
	const entry = fileURLToPath(new URL("./artifact-entry.py", import.meta.url));
	const argv = [entry, "--artifact-receipt", process.env.MSQA_PRODUCER_RECEIPT, "--evidence", process.env.MSQA_COVERAGE_EVIDENCE, "--execute"];
	const child = spawnSync("python", argv, { encoding: "utf8", timeout: 107_000, maxBuffer: 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr + child.stdout);
	const result = JSON.parse(readFileSync(`${process.env.MSQA_COVERAGE_EVIDENCE}/result.json`, "utf8"));
	assert.equal(result.status, "COMPILED_FOCUSED_QA_PASS");
	for (const key of ["sourceSha256", "inputSha256", "distSha256", "runtimeClosureSha256"]) {
		assert.equal(result.identity[key], previous.identity[key], `Coverage rerun identity drift: ${key}`);
	}
});
