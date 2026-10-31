// Offline faux-provider smoke for the harness-loop pilot (T2) on the actual delivered stack:
// runBoundedGoal (C) + buildContextPacket (A) + chooseWorkerAction (H) + evaluateAttempt (J) + summarizeUsage,
// graded by pilot grader v1. Synthetic: faux responses are scripted; this says nothing about model capability.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gradeTrial } from "../../../../scripts/harness-loop/pilot.test.mjs";
import { gradeRangeCandidate, gradeTrialRecord } from "../../../../scripts/harness-loop/pilot-grader.mjs";
import { type GoalAdapters, type GoalTask, runBoundedGoal } from "../../examples/sdk/bounded-goal.ts";
import * as deliveredAdapters from "../../examples/sdk/bounded-goal-adapters.mjs";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const FIX = join(__dirname, "../../../../scripts/harness-loop/fixtures/pilot");
const sha = "1ca833bbebe58496e95157013740951f38e844f6";
const original = readFileSync(join(FIX, "t2-repair/range.mjs"), "utf8");
const fixed = original.replace("i < to", "i <= to");
const exitFirst = 'export function sumRange() { throw new Error("never called"); }\nprocess.exit(0);\n';
const heldOut = JSON.parse(readFileSync(join(FIX, "held-out/t2.cases.json"), "utf8")) as [number, number, number][];
// Visible feedback only: the worker never sees held-out cases.
const visible: [number, number, number][] = [[1, 3, 6]];

// Built at request time so the message timestamp is the real request time (scripted messages are stamped
// when constructed, which precedes the driver's usage window).
const later = (make: () => ReturnType<typeof fauxAssistantMessage>) => () => make();
const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function pilotTrial() {
	const dir = mkdtempSync(join(tmpdir(), "pi-pilot-faux-"));
	dirs.push(dir);
	let range = original;
	const sessionManager = SessionManager.create(dir, dir);
	// Host dispatch journal: appended by the pre-dispatch hook, attributed to the host's own attempt counter.
	const trialId = `t2-${dirs.length}`;
	let hostAttempt = 0;
	const dispatches: { id: string; trialId: string; attempt: number }[] = [];
	const harness = await createHarness({
		sessionManager,
		settings: { cacheWarming: "off" } as never,
		extensionFactories: [
			(pi) => {
				pi.on("before_provider_request", () => {
					dispatches.push({ id: `${trialId}-d${dispatches.length + 1}`, trialId, attempt: hostAttempt });
				});
			},
		],
		tools: [
			{
				name: "write_range",
				label: "Write range.mjs",
				description: "Replace range.mjs",
				parameters: Type.Object({ content: Type.String() }),
				execute: async (_id: string, params: unknown) => {
					range = (params as { content: string }).content; // data only; never executed on the host
					return { content: [{ type: "text", text: "range.mjs written" }], details: {} };
				},
			},
		],
	});
	harnesses.push(harness);
	const task: GoalTask = {
		id: "T2-executable-repair",
		goal: "Make node visible-check.mjs pass by fixing range.mjs. Do not edit visible-check.mjs.",
		sourceSha: sha,
		acceptanceIds: ["t2-held-out"],
		maxAttempts: 2,
		// Run budget, not a timing assertion (see bounded-goal.test.ts): a loaded runner stalled past 20s.
		deadline: Date.now() + 120_000,
	};
	const adapters: GoalAdapters = {
		buildContextPacket: vi.fn((input: Parameters<typeof deliveredAdapters.buildContextPacket>[0]) => {
			hostAttempt++; // the driver calls this immediately before each session.prompt
			return deliveredAdapters.buildContextPacket(input);
		}),
		chooseWorkerAction: vi.fn(deliveredAdapters.chooseWorkerAction),
		evaluateAttempt: vi.fn(deliveredAdapters.evaluateAttempt),
		summarizeUsage: vi.fn(deliveredAdapters.summarizeUsage),
	};
	const graderReasons: string[][] = [];
	const check = vi.fn(async () => {
		const reasons = gradeRangeCandidate(range, heldOut);
		graderReasons.push(reasons);
		const log = `t2-held-out ${reasons.length ? "FAIL" : "PASS"}\n`;
		writeFileSync(join(dir, "t2-held-out.log"), log);
		const evidence = [{ path: "t2-held-out.log", sha256: createHash("sha256").update(log).digest("hex") }];
		const visibleReasons = gradeRangeCandidate(range, visible);
		return {
			sourceSha: sha,
			oracle: {
				taskId: task.id,
				readSha: () => sha,
				checks: new Map([
					[
						"t2-held-out",
						async () => ({
							conclusion: reasons.length ? "failure" : "success",
							exitCode: reasons.length ? 1 : 0,
							evidence,
						}),
					],
				]),
			},
			// The worker always claims success; only the host check decides.
			receipt: {
				schemaVersion: 1,
				sha,
				checks: [{ id: "t2-held-out", sha, conclusion: "success", exitCode: 0, evidence }],
			},
			evidenceRoot: dir,
			progress: `visible check: ${visibleReasons.length ? visibleReasons[0] : "ok"}`,
			evidencePaths: ["t2-held-out.log"],
		};
	});
	const readUsage = () =>
		harness.session.messages
			.filter((m) => m.role === "assistant")
			.map((m) => ({ timestamp: new Date(m.timestamp).toISOString(), usage: m.usage, outcome: "success" }));
	const options: Parameters<typeof runBoundedGoal>[0] = {
		session: harness.session,
		task,
		adapters,
		check,
		readSignals: () => ({ lane: "faux", state: "runnable", reason: "synthetic offline fixture" }),
		readEligibility: () => true,
		readUsage,
	};
	// Per-trial record in the pilot schema: one request per driver attempt, with output and usage.
	const record = (attempts: number) => {
		// Attribute each provider request to the driver attempt (user prompt) that preceded it.
		let attempt = 0;
		const requests: { attempt: number; output: string; usageRaw: Record<string, number> }[] = [];
		for (const m of harness.session.messages) {
			if (m.role === "user") attempt++;
			else if (m.role === "assistant")
				requests.push({
					attempt,
					output: JSON.stringify(m.content),
					usageRaw: { ...m.usage } as unknown as Record<string, number>,
				});
		}
		// Records carry no provider request id, so they can only be paired with dispatches by sequence;
		// any count mismatch is left for reconciliation to reject.
		const terminal = (r: string) => (r === "error" ? "failed" : r === "aborted" ? "cancelled" : "completed");
		const stops = harness.session.messages.flatMap((m) => (m.role === "assistant" ? [m.stopReason] : []));
		const linked = requests.map((r, i) => ({
			...r,
			dispatchId: dispatches[i]?.id ?? `unjournaled-${i + 1}`,
			trialId,
			terminal: terminal(stops[i]),
		}));
		const policy = {
			autoRetry: harness.session.autoRetryEnabled,
			// provider-retry.ts: an unset maxRetries is 0 transport retries.
			providerMaxRetries: harness.session.settingsManager.getProviderRetrySettings().maxRetries ?? 0,
			cacheWarming: harness.session.settingsManager.getCacheWarmingMode(),
		};
		const journal = { trialId, sealed: true, policy, dispatches: [...dispatches] };
		return {
			trialId,
			task: task.id,
			attempts,
			outcome: { files: { "range.mjs": range } },
			requests: linked,
			journal,
		};
	};
	return { harness, options, adapters, check, graderReasons, record, range: () => range };
}

describe("harness-loop pilot faux smoke (actual A/H/C/J stack, grader v1)", () => {
	it("rejects the exit-before-checks candidate, feeds back visible-only failure, verifies the real fix", async () => {
		const t = await pilotTrial();
		t.harness.setResponses([
			later(() =>
				fauxAssistantMessage(fauxToolCall("write_range", { content: exitFirst }), { stopReason: "toolUse" }),
			),
			later(() => fauxAssistantMessage("done, all checks pass")),
			later(() => fauxAssistantMessage(fauxToolCall("write_range", { content: fixed }), { stopReason: "toolUse" })),
			later(() => fauxAssistantMessage("repaired")),
		]);
		const result = await runBoundedGoal(t.options);
		expect(result).toMatchObject({ status: "verified", attempts: 2 });
		expect(t.graderReasons[0][0]).toMatch(/candidate rejected|held-out cases failed/);
		expect(t.graderReasons[1]).toEqual([]);
		// A's real packet carried J's failure and the visible-only progress into attempt 2.
		const second = (t.adapters.buildContextPacket as ReturnType<typeof vi.fn>).mock.calls[1][0];
		expect(second.failure).toBe("oracle: check did not succeed");
		expect(second.progress).toMatch(/^visible check: /);
		const packet = (t.adapters.buildContextPacket as ReturnType<typeof vi.fn>).mock.results[1].value as string;
		expect(packet).toContain(`SOURCE_SHA: ${sha}`);
		for (const [a, b, want] of heldOut.slice(1)) expect(packet).not.toContain(`[${a},${b},${want}]`);
		// H decided both runs.
		expect(
			(t.adapters.chooseWorkerAction as ReturnType<typeof vi.fn>).mock.results.map((r) => r.value.action),
		).toEqual(["run", "repair"]);
		// Usage: every provider request has every field; the driver summary covers them.
		const rec = t.record(result.attempts);
		expect(rec.requests).toHaveLength(4);
		for (const r of rec.requests)
			for (const f of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
				expect(Number.isFinite(r.usageRaw[f])).toBe(true);
		const usage = result.usage as { fields: Record<string, { present: number; total: number }> };
		expect(usage.fields.totalTokens.present).toBe(4);
		// Pilot record is complete and the outcome passes the real grader.
		expect(rec.requests.map((r) => r.attempt)).toEqual([1, 1, 2, 2]);
		// Ceiling: the faux provider never invokes onPayload, so before_provider_request never fires and the
		// journal is empty. Four assistant messages must not stand in for a request census: fail closed.
		expect(rec.journal.dispatches).toEqual([]);
		expect(rec.journal.policy).toEqual({ autoRetry: true, providerMaxRetries: 0, cacheWarming: "off" });
		const graded = gradeTrialRecord(rec, gradeTrial);
		expect(graded.complete).toBe(false);
		expect(graded.reasons.filter((r: string) => r.startsWith("orphan record"))).toHaveLength(4);
		// The outcome itself still passes the real grader.
		expect(gradeTrial({ task: rec.task, attempts: 2, outcome: rec.outcome }).outcomePass).toBe(true);
	});

	it("stops without verification when the worker repeats the bypass", async () => {
		const t = await pilotTrial();
		t.harness.setResponses([
			later(() =>
				fauxAssistantMessage(fauxToolCall("write_range", { content: exitFirst }), { stopReason: "toolUse" }),
			),
			later(() => fauxAssistantMessage("done")),
			later(() =>
				fauxAssistantMessage(fauxToolCall("write_range", { content: exitFirst }), { stopReason: "toolUse" }),
			),
			later(() => fauxAssistantMessage("done again")),
		]);
		const result = await runBoundedGoal(t.options);
		expect(result.status).toBe("checkpoint");
		expect(result.attempts).toBe(2);
		expect(t.graderReasons.every((r) => r.length > 0)).toBe(true);
		expect(
			gradeTrial({ task: "T2-executable-repair", attempts: 2, outcome: { files: { "range.mjs": t.range() } } })
				.outcomePass,
		).toBe(false);
	});
});
