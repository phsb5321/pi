import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GoalAdapters, type GoalTask, runBoundedGoal } from "../../examples/sdk/bounded-goal.ts";
import * as deliveredAdapters from "../../examples/sdk/bounded-goal-adapters.mjs";
import { SessionManager } from "../../src/core/session-manager.ts";
import { freezeDate } from "./bounded-goal-clock.ts";
import { createHarness, type Harness } from "./harness.ts";

const sha = "1ca833bbebe58496e95157013740951f38e844f6";
const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
	freezeDate();
	const dir = mkdtempSync(join(tmpdir(), "pi-bounded-goal-"));
	dirs.push(dir);
	const artifact = join(dir, "artifact.txt");
	writeFileSync(artifact, "broken\n");
	let effects = 0;
	const sessionManager = SessionManager.create(dir, dir);
	const harness = await createHarness({
		sessionManager,
		tools: [
			{
				name: "repair",
				label: "Repair",
				description: "Repair the synthetic artifact",
				parameters: Type.Object({}),
				execute: async () => {
					writeFileSync(artifact, "fixed\n");
					effects++;
					return { content: [{ type: "text", text: "artifact repaired" }], details: {} };
				},
			},
		],
	});
	harnesses.push(harness);
	const task: GoalTask = {
		id: "synthetic",
		goal: "Repair the synthetic artifact",
		sourceSha: sha,
		acceptanceIds: ["artifact-check"],
		maxAttempts: 2,
		deadline: Date.now() + 5000,
	};
	const adapters: GoalAdapters = {
		buildContextPacket: vi.fn(deliveredAdapters.buildContextPacket),
		chooseWorkerAction: vi.fn(deliveredAdapters.chooseWorkerAction),
		evaluateAttempt: vi.fn(deliveredAdapters.evaluateAttempt),
		summarizeUsage: vi.fn(deliveredAdapters.summarizeUsage),
	};
	const log = "artifact-check executed independently\n";
	const evidence = [{ path: "artifact-check.log", sha256: createHash("sha256").update(log).digest("hex") }];
	const check = vi.fn(async () => ({
		sourceSha: sha,
		oracle: {
			taskId: task.id,
			readSha: () => sha,
			checks: new Map([
				[
					"artifact-check",
					async () => {
						const fixed = readFileSync(artifact, "utf8") === "fixed\n";
						writeFileSync(join(dir, "artifact-check.log"), log);
						return { conclusion: fixed ? "success" : "failure", exitCode: fixed ? 0 : 1, evidence };
					},
				],
			]),
		},
		// Worker claims success in both cases. Only the independent file check decides.
		receipt: {
			schemaVersion: 1,
			sha,
			checks: [{ id: "artifact-check", sha, conclusion: "success", exitCode: 0, evidence }],
		},
		evidenceRoot: dir,
		progress: "synthetic file artifact; see independent check",
		evidencePaths: ["artifact-check.log"],
	}));
	const options: Parameters<typeof runBoundedGoal>[0] = {
		session: harness.session,
		task,
		adapters,
		check,
		readSignals: () => ({ lane: "faux", state: "runnable", reason: "synthetic fixture" }),
		readEligibility: () => true,
		readUsage: () => [],
	};
	return { dir, harness, options, check, adapters, effects: () => effects };
}

function appendCheckpoint(manager: SessionManager, task: GoalTask, phase: "acting" | "checking") {
	return manager.appendCustomEntry("pi.bounded-goal.v0", {
		binding: createHash("sha256").update(JSON.stringify(task)).digest("hex"),
		attempt: 1,
		phase,
		progress: "",
		evidencePaths: [],
		sourceSha: task.sourceSha,
	});
}

describe("bounded native SDK goal", () => {
	it("feeds a concrete trusted failure into a repair and verifies the actual effect", async () => {
		const f = await fixture();
		f.harness.setResponses([
			fauxAssistantMessage("I am done"),
			fauxAssistantMessage(fauxToolCall("repair", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Repaired"),
		]);
		const result = await runBoundedGoal(f.options);
		expect(result).toMatchObject({ status: "verified", attempts: 2 });
		expect(f.effects()).toBe(1);
		expect(f.check).toHaveBeenCalledTimes(2);
		expect(f.adapters.buildContextPacket).toHaveBeenLastCalledWith(
			expect.objectContaining({
				failure: "oracle: check did not succeed",
				progress: "synthetic file artifact; see independent check",
			}),
		);
	});

	it("rejects repeated claimed completion and stops nonprogress", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("passes=true"), fauxAssistantMessage("verified")]);
		expect(await runBoundedGoal(f.options)).toMatchObject({
			status: "checkpoint",
			attempts: 2,
			reason: expect.stringContaining("nonprogress"),
		});
		expect(f.effects()).toBe(0);
	});

	it("enforces attempts itself even when routing asks to keep running", async () => {
		const f = await fixture();
		f.options.task.maxAttempts = 1;
		f.harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		expect(await runBoundedGoal(f.options)).toMatchObject({
			status: "checkpoint",
			attempts: 1,
			reason: "attempt-limit",
		});
		expect(f.harness.getPendingResponseCount()).toBe(1);
	});

	it("stops before an expired deadline without a provider request", async () => {
		const f = await fixture();
		f.options.task.deadline = Date.now() - 1;
		expect(await runBoundedGoal(f.options)).toMatchObject({ reason: "deadline", attempts: 0 });
		expect(f.check).not.toHaveBeenCalled();
	});

	it("hard-stops a hanging trusted check and quarantines its owner lock", async () => {
		const f = await fixture();
		f.options.task.deadline = Date.now() + 500;
		f.harness.setResponses([fauxAssistantMessage("done")]);
		f.options.check = vi.fn(() => new Promise<never>(() => {}));
		expect(await runBoundedGoal(f.options)).toMatchObject({ reason: "deadline", attempts: 1 });
		expect(readdirSync(f.dir).some((name) => name.endsWith(".lock"))).toBe(true);
		await expect(runBoundedGoal(f.options)).rejects.toThrow("EEXIST");
	});

	it("honors a quota checkpoint without prompting or retrying", async () => {
		const f = await fixture();
		f.options.readSignals = () => ({
			lane: "faux",
			state: "hold",
			holdKind: "quota",
			reason: "fixture quota refusal",
		});
		expect(await runBoundedGoal(f.options)).toMatchObject({
			reason: "quota hold on faux: checkpoint, zero retries",
			attempts: 0,
		});
		expect(f.check).not.toHaveBeenCalled();
	});

	it("does not treat a nominal runnable meter as host credential eligibility", async () => {
		const f = await fixture();
		f.options.readEligibility = () => undefined;
		expect(await runBoundedGoal(f.options)).toMatchObject({ attempts: 0, reason: "host-eligibility-unknown" });
		f.options.readEligibility = () => false;
		expect(await runBoundedGoal(f.options)).toMatchObject({ attempts: 0, reason: "host-ineligible" });
		expect(f.adapters.chooseWorkerAction).not.toHaveBeenCalled();
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("does not retry an actual faux-provider refusal", async () => {
		const f = await fixture();
		f.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota refused" }),
			fauxAssistantMessage("must not retry"),
		]);
		expect(await runBoundedGoal(f.options)).toMatchObject({
			status: "checkpoint",
			attempts: 1,
			reason: expect.stringContaining("no automatic retry"),
		});
		expect(f.check).not.toHaveBeenCalled();
		expect(f.harness.getPendingResponseCount()).toBe(1);
	});

	it("opens a persisted session and rechecks without repeating its completed effect", async () => {
		const f = await fixture();
		f.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("repair", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		f.options.check = vi.fn(async () => {
			throw new Error("runner interrupted after prompt");
		});
		expect(await runBoundedGoal(f.options)).toMatchObject({ reason: "runner interrupted after prompt" });
		expect(f.effects()).toBe(1);
		const file = f.harness.sessionManager.getSessionFile();
		if (!file) throw new Error("Missing persistent session");
		f.harness.session.dispose();
		const resumed = await createHarness({ sessionManager: SessionManager.open(file) });
		harnesses.push(resumed);
		expect(await runBoundedGoal({ ...f.options, session: resumed.session, check: f.check })).toMatchObject({
			status: "verified",
			attempts: 1,
		});
		expect(f.effects()).toBe(1);
		expect(resumed.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("does not treat recorded success as a fresh oracle", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("done")]);
		writeFileSync(join(f.dir, "artifact.txt"), "fixed\n");
		expect((await runBoundedGoal(f.options)).status).toBe("verified");
		writeFileSync(join(f.dir, "artifact.txt"), "broken\n");
		expect((await runBoundedGoal(f.options)).status).toBe("checkpoint");
		expect(f.check).toHaveBeenCalledTimes(2);
	});

	it("rejects concurrent owners before a second dispatch", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const first = runBoundedGoal(f.options);
		await entered.promise;
		try {
			await expect(runBoundedGoal(f.options)).rejects.toThrow("EEXIST");
		} finally {
			release.resolve();
			await first;
		}
	});

	it("requires reconciliation for an interrupted acting checkpoint", async () => {
		const f = await fixture();
		f.adapters.chooseWorkerAction = () => ({ action: "checkpoint", reason: "hold" });
		await runBoundedGoal(f.options);
		const saved = f.harness.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === "pi.bounded-goal.v0");
		if (saved?.type !== "custom") throw new Error("Missing checkpoint");
		f.harness.sessionManager.appendCustomEntry(saved.customType, {
			...(saved.data as Record<string, unknown>),
			phase: "acting",
			attempt: 1,
		});
		expect(await runBoundedGoal(f.options)).toMatchObject({
			reason: "uncertain-effect: reconcile before resume",
			attempts: 1,
		});
		expect(f.check).not.toHaveBeenCalled();
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("does not abort a session already busy with unrelated work", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("unrelated work");
			},
		]);
		const prompt = f.harness.session.prompt("unrelated");
		await entered.promise;
		const abort = vi.spyOn(f.harness.session, "abort");
		try {
			expect(await runBoundedGoal(f.options)).toMatchObject({ reason: "Session is busy; it was not interrupted" });
			expect(abort).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await prompt;
		}
	});

	it("withholds unknown acceptance without another worker turn and resumes at fresh checks", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("done")]);
		const prepare = f.options.check;
		f.options.check = vi.fn(async (signal: AbortSignal) => ({ ...(await prepare(signal)), oracle: {} }));
		expect(await runBoundedGoal(f.options)).toMatchObject({
			status: "checkpoint",
			attempts: 1,
			reason: "independent host oracle unavailable",
		});
		writeFileSync(join(f.dir, "artifact.txt"), "fixed\n");
		expect(await runBoundedGoal({ ...f.options, check: prepare })).toMatchObject({ status: "verified", attempts: 1 });
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("bounds the asynchronous p2J evaluation itself", async () => {
		const f = await fixture();
		f.options.task.deadline = Date.now() + 500;
		f.harness.setResponses([fauxAssistantMessage("done")]);
		f.adapters.evaluateAttempt = () => new Promise<never>(() => {});
		expect(await runBoundedGoal(f.options)).toMatchObject({ reason: "deadline", attempts: 1 });
		await expect(runBoundedGoal(f.options)).rejects.toThrow("EEXIST");
	});

	it("forwards pinned dependencies explicitly and never executes receipt shell fields", async () => {
		const f = await fixture();
		f.options.task.dependencies = [{ taskId: "other-task", expectedSha: sha }];
		f.harness.setResponses([fauxAssistantMessage("done")]);
		writeFileSync(join(f.dir, "artifact.txt"), "fixed\n");
		expect(await runBoundedGoal(f.options)).toMatchObject({
			status: "checkpoint",
			reason: "selected host check/dependency unavailable",
		});
		expect(f.adapters.evaluateAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "synthetic", dependencies: f.options.task.dependencies }),
		);
		const second = await fixture();
		second.harness.setResponses([fauxAssistantMessage("done")]);
		second.options.task.maxAttempts = 1;
		writeFileSync(join(second.dir, "artifact.txt"), "fixed\n");
		const prepare = second.check;
		const marker = join(second.dir, "injection-marker");
		second.options.check = vi.fn(async () => {
			const result = await prepare();
			return { ...result, receipt: { ...result.receipt, command: `touch ${marker}` } };
		});
		expect((await runBoundedGoal(second.options)).status).toBe("checkpoint");
		expect(existsSync(marker)).toBe(false);
	});

	it("verifies only with a fresh host observation of the pinned dependency", async () => {
		const f = await fixture();
		f.options.task.dependencies = [{ taskId: "prerequisite", expectedSha: sha }];
		f.harness.setResponses([fauxAssistantMessage("done")]);
		writeFileSync(join(f.dir, "artifact.txt"), "fixed\n");
		const dependency = vi.fn(async () => ({ taskId: "prerequisite", sha, verdict: "verified" }));
		f.options.check = async () => {
			const prepared = await f.check();
			return { ...prepared, oracle: { ...prepared.oracle, dependencies: new Map([["prerequisite", dependency]]) } };
		};
		expect((await runBoundedGoal(f.options)).status).toBe("verified");
		expect(dependency).toHaveBeenCalledTimes(1);
	});

	// Coordinator counterexample: getEntries includes inactive siblings; checkpoints belong to getBranch.
	it("ignores an inactive sibling acting checkpoint on a fresh native active branch", async () => {
		const f = await fixture();
		const manager = f.harness.sessionManager;
		const root = manager.appendMessage({ role: "user", content: "native branch root", timestamp: Date.now() });
		const sibling = appendCheckpoint(manager, f.options.task, "acting");
		manager.branch(root);
		manager.appendCustomEntry("fixture-active-branch", {});
		expect(manager.getBranch().some((entry) => entry.id === sibling)).toBe(false);
		expect(manager.getEntries().some((entry) => entry.id === sibling)).toBe(true);
		writeFileSync(join(f.dir, "artifact.txt"), "fixed\n");
		f.harness.setResponses([fauxAssistantMessage("done")]);
		expect(await runBoundedGoal(f.options)).toMatchObject({ status: "verified", attempts: 1 });
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("never lets an inactive sibling checking checkpoint bypass native active uncertainty", async () => {
		const f = await fixture();
		const manager = f.harness.sessionManager;
		const root = manager.appendMessage({ role: "user", content: "native branch root", timestamp: Date.now() });
		const active = appendCheckpoint(manager, f.options.task, "acting");
		manager.branch(root);
		appendCheckpoint(manager, f.options.task, "checking");
		manager.branch(active);
		expect(manager.getBranch().at(-1)?.id).toBe(active);
		expect(manager.getEntries().at(-1)?.id).not.toBe(active);
		writeFileSync(join(f.dir, "artifact.txt"), "fixed\n");
		expect(await runBoundedGoal(f.options)).toMatchObject({
			status: "checkpoint",
			reason: "uncertain-effect: reconcile before resume",
		});
		expect(f.check).not.toHaveBeenCalled();
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("fails closed without a prompt when indispensable context overflows", async () => {
		const f = await fixture();
		f.options.maxContextChars = 40;
		const result = await runBoundedGoal(f.options);
		expect(result.status).not.toBe("verified");
		expect(result.reason).toContain("mandatory context needs");
		expect(result.attempts).toBe(0);
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	// The context packet accepts 7-64 hex (memory-sound callers); the driver itself requires an exact commit SHA.
	it("rejects a task sourceSha that is not an exact 40-character lowercase hex SHA", async () => {
		const f = await fixture();
		for (const sourceSha of [
			sha.slice(0, 7),
			sha.slice(0, 39),
			`${sha}0`,
			sha.toUpperCase(),
			`${sha.slice(0, 39)}g`,
			` ${sha}`,
			`${sha}\n`,
		]) {
			f.options.task = { ...f.options.task, sourceSha };
			await expect(runBoundedGoal(f.options)).rejects.toThrow("Invalid bounded goal");
		}
		expect(f.harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("rejects changed task bounds on resume", async () => {
		const f = await fixture();
		f.adapters.chooseWorkerAction = () => ({ action: "checkpoint", reason: "hold" });
		await runBoundedGoal(f.options);
		f.options.task.maxAttempts++;
		expect(await runBoundedGoal(f.options)).toMatchObject({
			reason: "Checkpoint does not match the immutable task/bounds",
		});
	});
});
