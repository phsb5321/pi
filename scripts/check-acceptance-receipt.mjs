#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CHECK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// ponytail: local JSON/log receipts only (8 MiB/file); large artifacts need a streaming verifier.
const MAX_BYTES = 8 * 1024 * 1024;

function requireCondition(condition, message) {
	if (!condition) throw new Error(message);
}

function object(value, keys, label) {
	requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
	requireCondition(
		Object.keys(value).every((key) => keys.includes(key)),
		`${label}: unknown field`,
	);
}

function readBounded(path) {
	const info = statSync(path);
	requireCondition(info.isFile() && info.size > 0 && info.size <= MAX_BYTES, "expected nonempty file <= 8 MiB");
	const bytes = readFileSync(path);
	requireCondition(bytes.length > 0 && bytes.length <= MAX_BYTES, "expected nonempty file <= 8 MiB");
	return bytes;
}

function validate(document, sha, requiredChecks, label) {
	object(document, ["schemaVersion", "sha", "checks"], label);
	requireCondition(document.schemaVersion === 1, `${label}: unsupported schemaVersion`);
	requireCondition(document.sha === sha, `${label}: wrong or stale SHA`);
	requireCondition(Array.isArray(document.checks), `${label}: checks missing`);
	requireCondition(document.checks.length === requiredChecks.length, `${label}: required checks mismatch`);
	const checks = new Map();
	for (const check of document.checks) {
		object(check, ["id", "sha", "conclusion", "exitCode", "evidence"], `${label} check`);
		requireCondition(
			requiredChecks.includes(check.id) && !checks.has(check.id),
			`${label}: unknown or duplicate check`,
		);
		requireCondition(check.sha === sha, `${label}: check has wrong or stale SHA`);
		requireCondition(check.conclusion === "success" && check.exitCode === 0, `${label}: check did not succeed`);
		requireCondition(Array.isArray(check.evidence) && check.evidence.length > 0, `${label}: evidence missing`);
		const evidence = new Map();
		for (const artifact of check.evidence) {
			object(artifact, ["path", "sha256"], `${label} evidence`);
			requireCondition(
				typeof artifact.path === "string" && artifact.path.length > 0 && !evidence.has(artifact.path),
				`${label}: invalid or duplicate evidence path`,
			);
			requireCondition(
				typeof artifact.sha256 === "string" && DIGEST.test(artifact.sha256),
				`${label}: invalid digest`,
			);
			evidence.set(artifact.path, artifact.sha256);
		}
		checks.set(check.id, evidence);
	}
	return checks;
}

/** No process execution, network, ledger writes, or interpretation of receipt commands. */
export function evaluateReceipt({ expectedSha, requiredChecks, oracle, receipt, evidenceRoot }) {
	try {
		requireCondition(typeof expectedSha === "string" && SHA.test(expectedSha), "expected full lowercase commit SHA");
		requireCondition(
			Array.isArray(requiredChecks) &&
				requiredChecks.length > 0 &&
				requiredChecks.every((id) => typeof id === "string" && CHECK_ID.test(id)) &&
				new Set(requiredChecks).size === requiredChecks.length,
			"explicit reviewed check IDs required (nonempty, unique)",
		);
		const trusted = validate(oracle, expectedSha, requiredChecks, "oracle");
		const claimed = validate(receipt, expectedSha, requiredChecks, "receipt");
		const root = realpathSync(evidenceRoot);
		for (const id of requiredChecks) {
			const expected = trusted.get(id);
			const actual = claimed.get(id);
			requireCondition(actual.size === expected.size, `${id}: evidence set mismatch`);
			for (const [path, digest] of expected) {
				requireCondition(actual.get(path) === digest, `${id}: evidence digest mismatch`);
				requireCondition(!isAbsolute(path), `${id}: absolute evidence path`);
				const file = realpathSync(resolve(root, path));
				const inside = relative(root, file);
				requireCondition(
					inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
					`${id}: evidence escapes root`,
				);
				requireCondition(
					createHash("sha256").update(readBounded(file)).digest("hex") === digest,
					`${id}: evidence bytes mismatch`,
				);
			}
		}
		return { ok: true, sha: expectedSha, checks: [...requiredChecks] };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : "invalid receipt" };
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let result;
	try {
		const [expectedSha, oraclePath, receiptPath, evidenceRoot, ...requiredChecks] = process.argv.slice(2);
		requireCondition(
			expectedSha && oraclePath && receiptPath && evidenceRoot && requiredChecks.length > 0,
			"usage: node scripts/check-acceptance-receipt.mjs <sha> <trusted-oracle.json> <receipt.json> <evidence-root> <check-id> [check-id...]",
		);
		result = evaluateReceipt({
			expectedSha,
			requiredChecks,
			oracle: JSON.parse(readBounded(oraclePath).toString("utf8")),
			receipt: JSON.parse(readBounded(receiptPath).toString("utf8")),
			evidenceRoot,
		});
	} catch (error) {
		result = { ok: false, reason: error instanceof Error ? error.message : "invalid input" };
	}
	console.log(JSON.stringify(result));
	process.exitCode = result.ok ? 0 : 1;
}
