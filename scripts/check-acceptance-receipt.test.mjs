import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReceipt } from "./check-acceptance-receipt.mjs";

const script = fileURLToPath(new URL("./check-acceptance-receipt.mjs", import.meta.url));
// Synthetic fixtures only; these are not actual CI results or real commit identities.
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-acceptance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const log = "synthetic local regression fixture\n";
	writeFileSync(join(root, "test.log"), log);
	const document = {
		schemaVersion: 1,
		sha,
		checks: [
			{
				id: "regression",
				sha,
				conclusion: "success",
				exitCode: 0,
				evidence: [{ path: "test.log", sha256: createHash("sha256").update(log).digest("hex") }],
			},
		],
	};
	return {
		expectedSha: sha,
		requiredChecks: ["regression"],
		oracle: structuredClone(document),
		receipt: structuredClone(document),
		evidenceRoot: root,
	};
}

function rejected(input, reason) {
	const result = evaluateReceipt(input);
	assert.equal(result.ok, false, JSON.stringify(result));
	if (reason) assert.match(result.reason, reason);
}

test("accepts SHA-bound evidence only with an independent successful oracle; deterministic", (t) => {
	const input = fixture(t);
	const expected = { ok: true, sha, checks: ["regression"] };
	assert.deepEqual(evaluateReceipt(input), expected);
	assert.deepEqual(evaluateReceipt(input), expected);
});

for (const source of ["receipt", "oracle"]) {
	for (const [name, mutate, reason] of [
		[
			"missing evidence",
			(doc) => {
				doc.checks[0].evidence = [];
			},
			/evidence missing/,
		],
		[
			"missing check",
			(doc) => {
				doc.checks = [];
			},
			/required checks mismatch/,
		],
		[
			"wrong top-level SHA",
			(doc) => {
				doc.sha = otherSha;
			},
			/wrong or stale SHA/,
		],
		[
			"stale individual check SHA",
			(doc) => {
				doc.checks[0].sha = otherSha;
			},
			/wrong or stale SHA/,
		],
		[
			"failed command",
			(doc) => {
				doc.checks[0].exitCode = 7;
			},
			/did not succeed/,
		],
		[
			"missing command exit code",
			(doc) => {
				delete doc.checks[0].exitCode;
			},
			/did not succeed/,
		],
		[
			"string exit code",
			(doc) => {
				doc.checks[0].exitCode = "0";
			},
			/did not succeed/,
		],
		[
			"skipped command",
			(doc) => {
				doc.checks[0].conclusion = "skipped";
			},
			/did not succeed/,
		],
		[
			"pending command",
			(doc) => {
				doc.checks[0].conclusion = "pending";
			},
			/did not succeed/,
		],
		[
			"unreviewed check",
			(doc) => {
				doc.checks[0].id = "unreviewed";
			},
			/unknown or duplicate check/,
		],
		[
			"bad digest",
			(doc) => {
				doc.checks[0].evidence[0].sha256 = "invalid";
			},
			/invalid digest/,
		],
		[
			"unknown schema",
			(doc) => {
				doc.schemaVersion = 2;
			},
			/unsupported schemaVersion/,
		],
	]) {
		test(`rejects ${source}: ${name}`, (t) => {
			const input = fixture(t);
			mutate(input[source]);
			rejected(input, reason);
		});
	}
}

test("claimed passes without an oracle never passes", (t) => {
	const input = fixture(t);
	input.receipt.passes = true;
	delete input.oracle;
	rejected(input, /oracle: expected object/);
});

test("rejects a bare claimed pass even with a successful oracle", (t) => {
	const input = fixture(t);
	input.receipt = { passes: true, sha };
	rejected(input, /unknown field/);
});

test("no explicitly reviewed checks never passes", (t) => {
	const input = fixture(t);
	input.requiredChecks = [];
	rejected(input, /explicit reviewed check IDs required/);
});

test("requires full trusted SHA, not a branch name or abbreviated hash", (t) => {
	const input = fixture(t);
	for (const invalid of ["memory-sound", sha.slice(0, 9), null]) {
		rejected({ ...input, expectedSha: invalid }, /full lowercase commit SHA/);
	}
});

test("rejects duplicate check IDs instead of satisfying two required checks with one", (t) => {
	const input = fixture(t);
	input.requiredChecks.push("build-check-test");
	input.oracle.checks.push(structuredClone(input.oracle.checks[0]));
	rejected(input, /duplicate check/);
});

test("rejects missing, empty or changed evidence bytes", (t) => {
	const input = fixture(t);
	for (const contents of ["", "tampered"]) {
		writeFileSync(join(input.evidenceRoot, "test.log"), contents);
		rejected(input);
	}
	rmSync(join(input.evidenceRoot, "test.log"));
	rejected(input, /ENOENT/);
});

test("receipt cannot replace the oracle's evidence digest", (t) => {
	const input = fixture(t);
	input.receipt.checks[0].evidence[0].sha256 = "c".repeat(64);
	rejected(input, /digest mismatch/);
});

test("rejects absolute, traversal and symlink escapes from the evidence root", (t) => {
	const input = fixture(t);
	const outside = join(input.evidenceRoot, "..", `outside-${input.evidenceRoot.split("/").pop()}.log`);
	writeFileSync(outside, "outside");
	t.after(() => rmSync(outside, { force: true }));
	symlinkSync(outside, join(input.evidenceRoot, "escape.log"));
	for (const path of [outside, `../${outside.split("/").pop()}`, "escape.log"]) {
		input.receipt.checks[0].evidence[0].path = path;
		input.oracle.checks[0].evidence[0].path = path;
		rejected(input, /absolute evidence path|evidence escapes root/);
	}
});

test("receipt-provided shell/recompute is rejected and never executed", (t) => {
	const input = fixture(t);
	const marker = join(input.evidenceRoot, "must-not-exist");
	input.receipt.checks[0].command = `touch ${marker}`;
	rejected(input, /unknown field/);
	delete input.receipt.checks[0].command;
	input.receipt.recompute = `touch ${marker}`;
	rejected(input, /unknown field/);
	assert.equal(existsSync(marker), false);
});

test("actual failed command cannot be hidden by a receipt claiming success", (t) => {
	const input = fixture(t);
	const failed = spawnSync(process.execPath, ["-e", "process.exit(7)"], { timeout: 5000 });
	assert.equal(failed.status, 7);
	input.oracle.checks[0].exitCode = failed.status;
	rejected(input, /did not succeed/);
});

test("CLI exits zero only for complete evidence; missing oracle and malformed JSON fail closed", (t) => {
	const input = fixture(t);
	const oracle = join(input.evidenceRoot, "oracle.json");
	const receipt = join(input.evidenceRoot, "receipt.json");
	writeFileSync(oracle, JSON.stringify(input.oracle));
	writeFileSync(receipt, JSON.stringify(input.receipt));
	const run = () =>
		spawnSync(process.execPath, [script, sha, oracle, receipt, input.evidenceRoot, "regression"], {
			encoding: "utf8",
			timeout: 5000,
		});
	let result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).ok, true);
	const marker = join(input.evidenceRoot, "must-not-exist-cli");
	input.receipt.recompute = `touch ${marker}`;
	writeFileSync(receipt, JSON.stringify(input.receipt));
	result = run();
	assert.equal(result.status, 1);
	assert.match(JSON.parse(result.stdout).reason, /unknown field/);
	assert.equal(existsSync(marker), false);
	writeFileSync(receipt, "{");
	result = run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).ok, false);
	rmSync(oracle);
	result = run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).ok, false);
});
