import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBacklogEvaluator } from "./backlog.mjs";

// Synthetic local policy; these are not production CI receipts or effectiveness results.
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-backlog-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const output = "host assertion completed\n";
	const evidence = [{ path: "check.log", sha256: createHash("sha256").update(output).digest("hex") }];
	writeFileSync(join(root, "source-sha"), sha);
	let runs = 0;
	const task = {
		taskId: "task-A",
		expectedSha: sha,
		requiredChecks: ["regression"],
		evidenceRoot: root,
		oracle: {
			taskId: "task-A",
			readSha: () => readFileSync(join(root, "source-sha"), "utf8"),
			checks: new Map([
				[
					"regression",
					() => {
						runs++;
						writeFileSync(join(root, "check.log"), output);
						return { conclusion: "success", exitCode: 0, evidence };
					},
				],
			]),
		},
	};
	const receipt = {
		schemaVersion: 1,
		sha,
		checks: [{ id: "regression", sha, conclusion: "success", exitCode: 0, evidence }],
	};
	const batch = { schemaVersion: 1, receipts: [{ taskId: "task-A", receipt }] };
	return { root, task, receipt, batch, runs: () => runs };
}

function notAccepted(state) {
	assert.equal(state.allVerified, false);
	assert.equal(state.tasks[0].accepted, false);
	assert.notEqual(state.tasks[0].verdict, "verified");
	assert.equal(Object.hasOwn(state.tasks[0], "passes"), false);
	assert.equal(Object.hasOwn(state.tasks[0], "measured"), false);
}

test("only fresh host verification produces checker-owned acceptance; output is deterministic and frozen", async (t) => {
	const { task, batch, runs } = fixture(t);
	const evaluate = createBacklogEvaluator([task]);
	const input = JSON.stringify(batch);
	const first = await evaluate(input);
	assert.equal(first.allVerified, true);
	assert.equal(first.tasks[0].accepted, true);
	assert.equal(first.tasks[0].verdict, "verified");
	assert.equal(runs(), 1);
	assert.deepEqual(await evaluate(input), first);
	assert.equal(runs(), 2, "never reuse a prior positive flag");
	assert.throws(() => {
		first.tasks[0].accepted = false;
	}, TypeError);
	assert.equal(JSON.stringify(batch), input);
	notAccepted(await evaluate(JSON.stringify({ schemaVersion: 1, receipts: [] })));
	assert.equal(runs(), 2);
});

for (const claim of [true, {}, "verified", { verdict: "verified", accepted: true }]) {
	test(`fabricated/truthy verdict cannot substitute for a receipt: ${JSON.stringify(claim)}`, async (t) => {
		const { task, batch } = fixture(t);
		batch.receipts[0].receipt = claim;
		notAccepted(await createBacklogEvaluator([task])(JSON.stringify(batch)));
	});
}

for (const field of ["oracle", "expectedSha", "requiredChecks", "verdict", "accepted", "passes", "measured"]) {
	test(`worker-spread ${field} cannot replace pinned host policy or outcome`, async (t) => {
		const { task, batch, runs } = fixture(t);
		batch.receipts[0][field] = field === "oracle" ? { checks: "() => true" } : true;
		notAccepted(await createBacklogEvaluator([task])(JSON.stringify(batch)));
		assert.equal(runs(), 0);
	});
}

for (const mode of [
	"wrong SHA",
	"wrong check ID",
	"hash mismatch",
	"missing evidence",
	"failed host",
	"unknown host",
	"untrusted callback",
	"bare exit zero",
]) {
	test(`${mode} cannot produce backlog acceptance`, async (t) => {
		const { task, batch, receipt } = fixture(t);
		if (mode === "wrong SHA") receipt.sha = otherSha;
		if (mode === "wrong check ID") receipt.checks[0].id = "worker-invented";
		if (mode === "hash mismatch") receipt.checks[0].evidence[0].sha256 = "f".repeat(64);
		if (mode === "missing evidence") receipt.checks[0].evidence = [];
		if (mode === "failed host") task.oracle.checks.set("regression", () => ({ conclusion: "failure", exitCode: 1 }));
		if (mode === "unknown host")
			task.oracle.checks.set("regression", () => {
				throw new Error("unavailable");
			});
		if (mode === "untrusted callback") task.oracle.checks.set("regression", "process.exit(0)");
		if (mode === "bare exit zero")
			task.oracle.checks.set("regression", () => {
				const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 5000 });
				assert.equal(child.status, 0);
				return { exitCode: child.status };
			});
		notAccepted(await createBacklogEvaluator([task])(JSON.stringify(batch)));
	});
}

test("host assertions after an early-exiting child reject fake success even though the child exits zero", async (t) => {
	const { task, batch } = fixture(t);
	task.oracle.checks.set("regression", () => {
		const child = spawnSync(process.execPath, ["-e", "process.exit(0); console.log(42)"], {
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(child.status, 0);
		assert.equal(child.stdout.trim(), "42", "trusted host asserts the actual result, not the child exit code");
		throw new Error("unreachable");
	});
	const result = await createBacklogEvaluator([task])(JSON.stringify(batch));
	notAccepted(result);
	assert.equal(result.tasks[0].verdict, "unknown");
});

test("policy and check registry are captured before worker input; later worker-like mutation cannot overwrite them", async (t) => {
	const { task, batch, runs } = fixture(t);
	const evaluate = createBacklogEvaluator([task]);
	task.expectedSha = otherSha;
	task.requiredChecks.push("worker-invented");
	task.oracle.checks.set("regression", () => {
		throw new Error("replaced registry");
	});
	const result = await evaluate(JSON.stringify(batch));
	assert.equal(result.allVerified, true);
	assert.equal(result.tasks[0].sha, sha);
	assert.equal(runs(), 1);
});

test("stale source revokes previously accepted results; no sticky success", async (t) => {
	const { task, batch, root } = fixture(t);
	const evaluate = createBacklogEvaluator([task]);
	assert.equal((await evaluate(JSON.stringify(batch))).allVerified, true);
	writeFileSync(join(root, "source-sha"), otherSha);
	notAccepted(await evaluate(JSON.stringify(batch)));
});

for (const mode of [
	"duplicate",
	"foreign task",
	"top-level oracle",
	"malformed",
	"oversized",
	"nonserialized callback",
]) {
	test(`ambiguous or non-data batch fails closed before checks: ${mode}`, async (t) => {
		const { task, batch, runs } = fixture(t);
		if (mode === "duplicate") batch.receipts.push(batch.receipts[0]);
		if (mode === "foreign task") batch.receipts[0].taskId = "foreign";
		if (mode === "top-level oracle") batch.oracle = { verdict: "verified" };
		let input = JSON.stringify(batch);
		if (mode === "malformed") input = "{";
		if (mode === "oversized") input = " ".repeat(8 * 1024 * 1024 + 1);
		if (mode === "nonserialized callback")
			input = {
				toJSON: () => {
					throw new Error("must not execute worker callback");
				},
			};
		notAccepted(await createBacklogEvaluator([task])(input));
		assert.equal(runs(), 0);
	});
}

test("partial backlog keeps missing tasks unknown in host order, regardless of worker receipt order", async (t) => {
	const a = fixture(t);
	const b = fixture(t);
	b.task.taskId = "task-B";
	b.task.oracle.taskId = "task-B";
	const state = await createBacklogEvaluator([b.task, a.task])(JSON.stringify(a.batch));
	assert.deepEqual(
		state.tasks.map((row) => [row.taskId, row.accepted]),
		[
			["task-B", false],
			["task-A", true],
		],
	);
	assert.equal(state.allVerified, false);
	assert.equal(b.runs(), 0);
});

test("empty or duplicate host backlog cannot vacuously pass", (t) => {
	const { task } = fixture(t);
	for (const tasks of [undefined, [], [null], [task, task]])
		assert.throws(() => createBacklogEvaluator(tasks), TypeError);
});
