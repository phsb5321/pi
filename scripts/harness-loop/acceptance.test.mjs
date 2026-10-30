import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateAttempt } from "./acceptance.mjs";

// Local synthetic task identities; no CI or model-success claims.
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const output = "fixed reviewed host check\n";
const digest = (text) => createHash("sha256").update(text).digest("hex");

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-loop-acceptance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "source-sha"), sha);
	const evidence = [{ path: "check.log", sha256: digest(output) }];
	let runs = 0;
	const run = () => {
		runs++;
		// Fixed host-selected argv: worker receipt is never consulted or interpolated.
		const result = spawnSync(process.execPath, ["-e", "process.stdout.write('fixed reviewed host check\\n')"], {
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(result.status, 0, result.stderr);
		writeFileSync(join(root, "check.log"), result.stdout);
		return { conclusion: "success", exitCode: result.status, evidence: structuredClone(evidence) };
	};
	return {
		input: {
			taskId: "task-A",
			expectedSha: sha,
			requiredChecks: ["regression"],
			evidenceRoot: root,
			oracle: {
				taskId: "task-A",
				readSha: () => readFileSync(join(root, "source-sha"), "utf8"),
				checks: new Map([["regression", run]]),
				dependencies: new Map(),
			},
			receipt: {
				schemaVersion: 1,
				sha,
				checks: [{ id: "regression", sha, conclusion: "success", exitCode: 0, evidence }],
			},
		},
		run,
		runs: () => runs,
	};
}

async function expectVerdict(input, verdict, reason) {
	const result = await evaluateAttempt(input);
	assert.equal(result.verdict, verdict, JSON.stringify(result));
	if (reason) assert.match(result.reason, reason);
	assert.equal(Object.hasOwn(result, "passes"), false);
	assert.equal(Object.hasOwn(result, "measured"), false);
	return result;
}

test("fresh actual host command and #51 evidence validation verify without mutating input", async (t) => {
	const { input, runs } = fixture(t);
	const receiptBefore = JSON.stringify(input.receipt);
	const result = await expectVerdict(input, "verified");
	assert.equal(result.taskId, "task-A");
	assert.equal(result.sha, sha);
	assert.equal(result.failureKey, null);
	assert.equal(result.progressChanged, null);
	assert.equal(runs(), 1);
	assert.equal(JSON.stringify(input.receipt), receiptBefore);
	await expectVerdict({ ...input, previous: result }, "verified");
	assert.equal(runs(), 2, "fresh invocation, not reuse of a stored successful oracle");
});

test("only selected checks run, and asynchronous host observations are awaited", async (t) => {
	const { input, run, runs } = fixture(t);
	input.oracle.readSha = async () => sha;
	input.oracle.checks.set("regression", async () => run());
	input.oracle.checks.set("unselected", () => {
		throw new Error("must not run");
	});
	await expectVerdict(input, "verified");
	assert.equal(runs(), 1);
});

test("serialized command strings cannot masquerade as registered host functions", async (t) => {
	const { input, runs } = fixture(t);
	input.oracle.checks.set("regression", "node -e process.exit(0)");
	await expectVerdict(input, "unknown", /check\/dependency unavailable/);
	assert.equal(runs(), 0);
});

test("claimed passes and worker-invented oracle JSON cannot establish provenance", async (t) => {
	const { input, runs } = fixture(t);
	input.receipt.passes = true;
	await expectVerdict({ ...input, oracle: undefined }, "unknown", /independent host oracle/);
	await expectVerdict({ ...input, oracle: structuredClone(input.receipt) }, "unknown", /independent host oracle/);
	assert.equal(runs(), 0);
});

test("even valid old evidence plus a JSON oracle cannot bypass fresh checks", async (t) => {
	const { input, run, runs } = fixture(t);
	run();
	await expectVerdict({ ...input, oracle: structuredClone(input.receipt) }, "unknown");
	assert.equal(runs(), 1);
});

test("wrong-task host oracle cannot grade another task at the same SHA", async (t) => {
	const { input, runs } = fixture(t);
	input.oracle.taskId = "task-B";
	await expectVerdict(input, "unknown", /independent host oracle/);
	assert.equal(runs(), 0);
});

for (const field of ["document", "check"]) {
	test(`stale receipt ${field} SHA is rejected`, async (t) => {
		const { input } = fixture(t);
		if (field === "document") input.receipt.sha = otherSha;
		else input.receipt.checks[0].sha = otherSha;
		await expectVerdict(input, "rejected", /stale SHA/);
	});
}

test("source changed before or during actual checks yields unknown, never verified", async (t) => {
	const { input, run, runs } = fixture(t);
	const path = join(input.evidenceRoot, "source-sha");
	writeFileSync(path, otherSha);
	await expectVerdict(input, "unknown", /stale before/);
	assert.equal(runs(), 0);
	writeFileSync(path, sha);
	input.oracle.checks.set("regression", () => {
		const result = run();
		writeFileSync(path, otherSha);
		return result;
	});
	await expectVerdict(input, "unknown", /changed during checks/);
});

test("missing selected command refuses all check launches", async (t) => {
	const { input, runs } = fixture(t);
	input.requiredChecks.push("missing");
	await expectVerdict(input, "unknown", /check\/dependency unavailable/);
	assert.equal(runs(), 0);
});

test("actual failed command cannot be hidden by worker's successful receipt", async (t) => {
	const { input } = fixture(t);
	input.oracle.checks.set("regression", () => {
		const result = spawnSync(process.execPath, ["-e", "process.exit(7)"], { timeout: 5000 });
		assert.equal(result.status, 7);
		return { conclusion: "failure", exitCode: result.status, evidence: input.receipt.checks[0].evidence };
	});
	await expectVerdict(input, "rejected", /did not succeed/);
});

for (const conclusion of ["skipped", "pending", "cancelled"]) {
	test(`${conclusion} host check never verifies`, async (t) => {
		const { input, run } = fixture(t);
		input.oracle.checks.set("regression", () => ({ ...run(), conclusion }));
		await expectVerdict(input, "rejected", /did not succeed/);
	});
}

test("thrown/unavailable host check produces an explicit unknown verdict", async (t) => {
	const { input } = fixture(t);
	input.oracle.checks.set("regression", () => {
		throw new Error("service unavailable");
	});
	await expectVerdict(input, "unknown", /observation failed/);
});

for (const mode of ["missing evidence", "modified evidence", "missing exit code", "missing receipt check"]) {
	test(`${mode} never verifies`, async (t) => {
		const { input, run } = fixture(t);
		if (mode === "missing receipt check") input.receipt.checks = [];
		else
			input.oracle.checks.set("regression", () => {
				const result = run();
				if (mode === "missing evidence") rmSync(join(input.evidenceRoot, "check.log"));
				if (mode === "modified evidence") writeFileSync(join(input.evidenceRoot, "check.log"), "tampered");
				if (mode === "missing exit code") delete result.exitCode;
				return result;
			});
		await expectVerdict(input, "rejected");
	});
}

test("receipt-injected shell is never executed or supplied to the actual host check", async (t) => {
	const { input, runs } = fixture(t);
	const marker = join(input.evidenceRoot, "must-not-exist");
	input.receipt.command = `touch ${marker}`;
	input.receipt.recompute = `touch ${marker}`;
	await expectVerdict(input, "rejected", /unknown field/);
	assert.equal(existsSync(marker), false);
	assert.equal(runs(), 1);
});

test("pinned verified dependency is read after checks; same-SHA wrong-task proof cannot substitute", async (t) => {
	const { input, runs } = fixture(t);
	input.dependencies = [{ taskId: "task-B", expectedSha: sha }];
	input.oracle.dependencies.set("task-B", () => {
		assert.equal(runs(), 1);
		return { taskId: "task-B", sha, verdict: "verified" };
	});
	await expectVerdict(input, "verified");
	input.oracle.dependencies.set("task-B", () => ({ taskId: "task-A", sha, verdict: "verified" }));
	await expectVerdict(input, "unknown", /dependency task-B/);
});

for (const state of [
	null,
	{ taskId: "task-B", sha: otherSha, verdict: "verified" },
	{ taskId: "task-B", sha, verdict: "rejected" },
	{ taskId: "task-B", sha, verdict: "unknown" },
]) {
	test(`dependency ${JSON.stringify(state)} withholds verification`, async (t) => {
		const { input } = fixture(t);
		input.dependencies = [{ taskId: "task-B", expectedSha: sha }];
		input.oracle.dependencies.set("task-B", () => state);
		await expectVerdict(input, "unknown", /not independently verified/);
	});
}

test("dependency read that changes parent source SHA is fenced", async (t) => {
	const { input } = fixture(t);
	input.dependencies = [{ taskId: "task-B", expectedSha: sha }];
	input.oracle.dependencies.set("task-B", () => {
		writeFileSync(join(input.evidenceRoot, "source-sha"), otherSha);
		return { taskId: "task-B", sha, verdict: "verified" };
	});
	await expectVerdict(input, "unknown", /changed during dependency/);
});

test("missing dependency observer, self-dependency and duplicate dependencies fail closed", async (t) => {
	const { input, runs } = fixture(t);
	input.dependencies = [{ taskId: "task-B", expectedSha: sha }];
	await expectVerdict(input, "unknown");
	input.oracle.dependencies = {};
	await expectVerdict(input, "unknown");
	input.dependencies = [{ taskId: "task-A", expectedSha: sha }];
	await expectVerdict(input, "unknown", /invalid host dependency/);
	input.dependencies = [
		{ taskId: "task-B", expectedSha: sha },
		{ taskId: "task-B", expectedSha: sha },
	];
	await expectVerdict(input, "unknown", /invalid host dependency/);
	assert.equal(runs(), 0);
});

test("repeated failure with no source progress never becomes verified", async (t) => {
	const { input, run } = fixture(t);
	input.oracle.checks.set("regression", () => ({ ...run(), conclusion: "failure", exitCode: 1 }));
	const first = await expectVerdict(input, "rejected");
	assert.equal(first.repeatedFailure, false);
	const second = await expectVerdict({ ...input, previous: first }, "rejected");
	assert.equal(second.progressChanged, false);
	assert.equal(second.repeatedFailure, true);
	assert.equal(second.failureKey, first.failureKey);
	input.receipt.passes = true;
	await expectVerdict({ ...input, previous: second }, "rejected");
});

test("other-task history cannot count as this task's failure/progress", async (t) => {
	const { input, run } = fixture(t);
	input.oracle.checks.set("regression", () => ({ ...run(), conclusion: "failure", exitCode: 1 }));
	const first = await evaluateAttempt(input);
	const result = await expectVerdict({ ...input, previous: { ...first, taskId: "task-B" } }, "rejected");
	assert.equal(result.progressChanged, null);
	assert.equal(result.repeatedFailure, false);
});

test("fresh successful checks can recover at the same SHA; failure history is not a fake pass", async (t) => {
	const { input, run, runs } = fixture(t);
	input.oracle.checks.set("regression", () => ({ ...run(), conclusion: "failure", exitCode: 1 }));
	const previous = await evaluateAttempt(input);
	input.oracle.checks.set("regression", run);
	const result = await expectVerdict({ ...input, previous }, "verified");
	assert.equal(result.progressChanged, false);
	assert.equal(result.repeatedFailure, false);
	assert.equal(runs(), 2);
});

test("invalid host selection yields unknown, not an exception or an empty-cohort pass", async (t) => {
	const { input, runs } = fixture(t);
	for (const invalid of [
		undefined,
		null,
		{},
		{ ...input, requiredChecks: [] },
		{ ...input, requiredChecks: ["regression", "regression"] },
		{ ...input, expectedSha: "main" },
		{ ...input, taskId: 123 },
		{ ...input, dependencies: null },
	]) {
		await expectVerdict(invalid, "unknown");
	}
	assert.equal(runs(), 0);
});
