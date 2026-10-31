// Independent p2J branch regression; no model/provider APIs or external tool effects.
// Source and complete red/green logs are preserved in the campaign's p2J audit evidence.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { type GoalTask, runBoundedGoal } from "../../examples/sdk/bounded-goal.ts";
import * as adapters from "../../examples/sdk/bounded-goal-adapters.mjs";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(activePhase: "acting" | null, siblingPhase: "acting" | "checking") {
	const dir = mkdtempSync(join(tmpdir(), "p2j-native-branch-"));
	dirs.push(dir);
	const task: GoalTask = {
		id: "native-branch-regression",
		goal: "Branch fixture: no real tool effects",
		sourceSha: "1ca833bbebe58496e95157013740951f38e844f6",
		acceptanceIds: ["fixture-check"],
		maxAttempts: 1,
		deadline: Date.now() + 5000,
	};
	const manager = SessionManager.create(dir, dir);
	const root = manager.appendMessage(fauxAssistantMessage("seed: make native persistence active"));
	const binding = createHash("sha256").update(JSON.stringify(task)).digest("hex");
	const checkpoint = (phase: "acting" | "checking") =>
		manager.appendCustomEntry("pi.bounded-goal.v0", {
			binding,
			attempt: 1,
			phase,
			progress: "",
			evidencePaths: [],
			sourceSha: task.sourceSha,
		});
	const active = activePhase ? checkpoint(activePhase) : root;
	manager.branch(root);
	const sibling = checkpoint(siblingPhase);
	manager.branch(active);
	// Persist the active branch as the latest file leaf WITHOUT making its checkpoint the last custom entry.
	manager.appendMessage({ role: "user", content: "active branch marker", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("Native persistent session missing");
	const reopened = SessionManager.open(file);
	expect(reopened.getEntries().some((entry) => entry.id === sibling)).toBe(true);
	expect(reopened.getBranch().some((entry) => entry.id === sibling)).toBe(false);
	if (activePhase) expect(reopened.getBranch().some((entry) => entry.id === active)).toBe(true);
	const harness = await createHarness({ sessionManager: reopened });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("fixture completed")]);
	let checkCalls = 0;
	const log = "fresh independent branch-fixture check\n";
	const evidence = [{ path: "fixture-check.log", sha256: createHash("sha256").update(log).digest("hex") }];
	const check = vi.fn(async () => ({
		sourceSha: task.sourceSha,
		oracle: {
			taskId: task.id,
			readSha: () => task.sourceSha,
			checks: new Map([
				[
					"fixture-check",
					() => {
						checkCalls++;
						writeFileSync(join(dir, "fixture-check.log"), log);
						return { conclusion: "success", exitCode: 0, evidence };
					},
				],
			]),
		},
		receipt: {
			schemaVersion: 1,
			sha: task.sourceSha,
			checks: [{ id: "fixture-check", sha: task.sourceSha, conclusion: "success", exitCode: 0, evidence }],
		},
		evidenceRoot: dir,
		progress: "fixture",
		evidencePaths: ["fixture-check.log"],
	}));
	const result = await runBoundedGoal({
		session: harness.session,
		task,
		adapters,
		check,
		readSignals: () => ({ lane: "faux", state: "runnable", reason: "local branch fixture" }),
		readEligibility: () => true, // Explicit faux-fixture eligibility for the new host-only interface.
		readUsage: () => [],
	});
	return { result, prompts: harness.eventsOfType("agent_start").length, checks: checkCalls };
}

it("disk-reopened fresh active branch ignores sibling acting uncertainty", async () => {
	const observed = await fixture(null, "acting");
	console.log(JSON.stringify({ case: "native-false-block", ...observed }));
	expect(observed.prompts).toBe(1);
	expect(observed.checks).toBe(1);
	expect(observed.result.status).toBe("verified");
});

it("disk-reopened active acting checkpoint cannot be hidden by sibling checking", async () => {
	const observed = await fixture("acting", "checking");
	console.log(JSON.stringify({ case: "native-uncertainty-bypass", ...observed }));
	expect(observed.result.status).toBe("checkpoint");
	expect(observed.result.reason).toContain("uncertain-effect");
	expect(observed.prompts).toBe(0);
	expect(observed.checks).toBe(0);
});
