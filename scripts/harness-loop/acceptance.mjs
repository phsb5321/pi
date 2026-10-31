import { createHash } from "node:crypto";
import { evaluateReceipt } from "../check-acceptance-receipt.mjs";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Host-only oracle: { taskId, readSha(), checks: Map<id, () => observed result>, dependencies?: Map }.
 * Functions must run/observe reviewed actual checks, not launder worker JSON. Receipt data never reaches them.
 * Host pins stable source/dependency revisions; this is not a sandbox against hostile host code/same-UID writes.
 * Dependencies are { taskId, expectedSha }; their host readers return { taskId, sha, verdict }.
 * Async refinement of the board interface: actual checks must finish before #51 may validate their evidence.
 */
export async function evaluateAttempt(input = {}) {
	const {
		taskId,
		expectedSha,
		requiredChecks,
		oracle,
		receipt,
		evidenceRoot,
		dependencies = [],
		previous,
	} = input ?? {};
	const sameTask = previous !== null && typeof previous === "object" && previous.taskId === taskId;
	const progressChanged = sameTask ? previous.sha !== expectedSha : null;
	const verdict = (status, reason, observed = []) => {
		const failureKey =
			status === "rejected"
				? createHash("sha256")
						.update(JSON.stringify([taskId, expectedSha, reason, observed]))
						.digest("hex")
				: null;
		return {
			verdict: status,
			taskId,
			sha: expectedSha,
			reason,
			failureKey,
			progressChanged,
			repeatedFailure:
				status === "rejected" &&
				sameTask &&
				progressChanged === false &&
				previous.verdict === "rejected" &&
				previous.failureKey === failureKey,
		};
	};
	if (
		typeof taskId !== "string" ||
		!ID.test(taskId) ||
		typeof expectedSha !== "string" ||
		!SHA.test(expectedSha) ||
		!Array.isArray(requiredChecks) ||
		requiredChecks.length === 0 ||
		requiredChecks.some((id) => typeof id !== "string" || !ID.test(id)) ||
		new Set(requiredChecks).size !== requiredChecks.length
	) {
		return verdict("unknown", "invalid host task/SHA/check selection");
	}
	if (!oracle || oracle.taskId !== taskId || typeof oracle.readSha !== "function" || !(oracle.checks instanceof Map)) {
		return verdict("unknown", "independent host oracle unavailable");
	}
	if (
		!Array.isArray(dependencies) ||
		dependencies.some(
			(dep) =>
				!dep ||
				typeof dep.taskId !== "string" ||
				!ID.test(dep.taskId) ||
				dep.taskId === taskId ||
				typeof dep.expectedSha !== "string" ||
				!SHA.test(dep.expectedSha),
		) ||
		new Set(dependencies.map((dep) => dep.taskId)).size !== dependencies.length
	) {
		return verdict("unknown", "invalid host dependency selection");
	}
	// Validate the entire selection before launching any check; never execute worker-supplied shell/functions.
	if (
		requiredChecks.some((id) => typeof oracle.checks.get(id) !== "function") ||
		(dependencies.length > 0 &&
			(!(oracle.dependencies instanceof Map) ||
				dependencies.some((dep) => typeof oracle.dependencies.get(dep.taskId) !== "function")))
	) {
		return verdict("unknown", "selected host check/dependency unavailable");
	}
	try {
		if ((await oracle.readSha()) !== expectedSha) return verdict("unknown", "source SHA is stale before checks");
		const checks = [];
		for (const id of requiredChecks) {
			const result = await oracle.checks.get(id)();
			checks.push({
				id,
				sha: expectedSha,
				conclusion: result?.conclusion,
				exitCode: result?.exitCode,
				evidence: result?.evidence,
			});
		}
		if ((await oracle.readSha()) !== expectedSha) return verdict("unknown", "source SHA changed during checks");
		for (const dep of dependencies) {
			const state = await oracle.dependencies.get(dep.taskId)();
			if (!state || state.taskId !== dep.taskId || state.sha !== dep.expectedSha || state.verdict !== "verified") {
				return verdict("unknown", `dependency ${dep.taskId} is not independently verified at pinned SHA`);
			}
		}
		if ((await oracle.readSha()) !== expectedSha)
			return verdict("unknown", "source SHA changed during dependency validation");
		const checked = evaluateReceipt({
			expectedSha,
			requiredChecks,
			oracle: { schemaVersion: 1, sha: expectedSha, checks },
			receipt,
			evidenceRoot,
		});
		// A check-level fingerprint only: diagnostic logs stay with the host, not in the verdict.
		const observed = checks.map(({ id, conclusion, exitCode }) => [id, conclusion, exitCode]);
		return checked.ok
			? verdict("verified", "fresh host checks and receipt evidence agree")
			: verdict("rejected", checked.reason, observed);
	} catch {
		return verdict("unknown", "host check/source/dependency observation failed");
	}
}
