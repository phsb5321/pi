import { evaluateAttempt } from "./acceptance.mjs";

/**
 * Construct ONLY in reviewed host code. Pin policy/callbacks before receiving worker JSON.
 * Returns a one-shot state evaluator, not a scheduler, persistence layer or callback authenticator.
 */
export function createBacklogEvaluator(tasks) {
	if (
		!Array.isArray(tasks) ||
		tasks.length === 0 ||
		tasks.some((task) => !task || typeof task.taskId !== "string") ||
		new Set(tasks.map((task) => task.taskId)).size !== tasks.length
	) {
		throw new TypeError("nonempty uniquely identified host tasks required");
	}
	const policies = tasks.map((task) => ({
		taskId: task.taskId,
		expectedSha: task.expectedSha,
		requiredChecks: Array.isArray(task.requiredChecks) ? [...task.requiredChecks] : undefined,
		evidenceRoot: task.evidenceRoot,
		dependencies: Array.isArray(task.dependencies)
			? task.dependencies.map((dep) => ({ taskId: dep.taskId, expectedSha: dep.expectedSha }))
			: task.dependencies,
		oracle: {
			taskId: task.oracle?.taskId,
			readSha: task.oracle?.readSha,
			checks: task.oracle?.checks instanceof Map ? new Map(task.oracle.checks) : undefined,
			dependencies: task.oracle?.dependencies instanceof Map ? new Map(task.oracle.dependencies) : undefined,
		},
	}));
	return async function evaluateBacklog(workerJson) {
		let receipts;
		try {
			// ponytail: bounded data-only batches (8 MiB); larger backlogs need a streaming reader.
			if (typeof workerJson !== "string" || Buffer.byteLength(workerJson, "utf8") > 8 * 1024 * 1024)
				throw new Error("invalid batch");
			const batch = JSON.parse(workerJson);
			if (
				!batch ||
				Array.isArray(batch) ||
				batch.schemaVersion !== 1 ||
				Object.keys(batch).some((key) => !["schemaVersion", "receipts"].includes(key)) ||
				!Array.isArray(batch.receipts)
			)
				throw new Error("invalid batch");
			receipts = new Map();
			for (const item of batch.receipts) {
				if (
					!item ||
					Array.isArray(item) ||
					Object.keys(item).some((key) => !["taskId", "receipt"].includes(key)) ||
					!policies.some((policy) => policy.taskId === item.taskId) ||
					receipts.has(item.taskId)
				)
					throw new Error("invalid batch");
				receipts.set(item.taskId, item.receipt);
			}
		} catch {
			receipts = undefined;
		}
		const outcomes = [];
		for (const policy of policies) {
			const result = receipts?.has(policy.taskId)
				? await evaluateAttempt({
						taskId: policy.taskId,
						expectedSha: policy.expectedSha,
						requiredChecks: policy.requiredChecks,
						evidenceRoot: policy.evidenceRoot,
						dependencies: policy.dependencies,
						oracle: policy.oracle,
						receipt: receipts.get(policy.taskId),
					})
				: { verdict: "unknown", reason: receipts ? "receipt missing" : "invalid worker batch" };
			const verdict = ["verified", "rejected"].includes(result.verdict) ? result.verdict : "unknown";
			outcomes.push(
				Object.freeze({
					taskId: policy.taskId,
					sha: policy.expectedSha,
					verdict,
					accepted: verdict === "verified",
					reason: result.reason,
				}),
			);
		}
		return Object.freeze({
			schemaVersion: 1,
			tasks: Object.freeze(outcomes),
			allVerified: outcomes.every((task) => task.accepted),
		});
	};
}
