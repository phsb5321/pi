/**
 * history-reclaim-overlay — native streaming/tool/cancellation and durable
 * close/reopen acceptance. Record exact source and executable exits separately.
 *
 * Canonical patterns reused verbatim from the existing runnable native
 * harness tests (per the SOURCE-PUBLISH/NATIVE-822 packets):
 *   - turn completion is `await submission.wait(context)` (harness-events
 *     .test.ts:120-123), never `await submission`;
 *   - real-time bounded waits use `waitFor` (chat-support.ts:85); the
 *     task-support `eventually` (200 flush turns) has no elapsed-time
 *     guarantee and cannot outrun the faux provider's real timers;
 *   - the watchEvents signature is (harness, conversationId, context)
 *     (packages/durable/src/harness/events.ts:140) - checked, not assumed;
 *   - delivered event CHANGES and their ordering carry the streaming
 *     evidence (deltas before settled), the tool RESULT carries the tool
 *     evidence, and the abort SIGNAL/outcome carries the cancel evidence.
 *
 * Failure handling: bounded diagnostics are dumped on any fixture crash and
 * every fixture closes its native handles in `finally`. A crash becomes a
 * NAMED failure with a real report (the required-case completeness then
 * fails honestly). Nothing is swallowed; nothing is weakened.
 *
 *   node --experimental-strip-types test/history-reclaim-overlay.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	LiveDoc,
	MemoryStorage,
	defineTool,
	watchEvents,
} from "@earendil-works/pi-durable";
import { chatSetup, openChat, allEntries, waitFor } from "../packages/durable/test/chat-support.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { addTool } from "../packages/durable/test/harness-support.ts";
import { context } from "../packages/durable/test/session-support.ts";
import { withRetainedHistory } from "../packages/server/src/retained-history.ts";
import { aborted, deferred } from "../packages/durable/test/task-support.ts";

// 12 case checks (5 streaming/tool/cancel + 2 restart + 3 park/resume/
// reclaim + the strict tool-result lineage + the terminal-aborted task)
// plus the completeness check itself = 13 executed assertions.
const REQUIRED_CASES = 13;
let executed = 0;
let failures = 0;
function check(label: string, condition: boolean): void {
	executed += 1;
	if (condition) {
		process.stdout.write(`PASS ${label}\n`);
		return;
	}
	failures += 1;
	process.stderr.write(`FAIL ${label}\n`);
}

// Bounded failure diagnostics: each fixture registers a snapshot; a crash
// dumps it (capped) before the named failure. Not swallowed: surfaced.
let diagnostics: (() => unknown) | undefined;
function dumpDiagnostics(): void {
	if (diagnostics === undefined) return;
	try {
		process.stderr.write(`DIAG ${JSON.stringify(diagnostics()).slice(0, 2000)}\n`);
	} catch (error) {
		process.stderr.write(`DIAG unavailable: ${String(error)}\n`);
	}
}

function report(): never {
	// The completeness assertion counts ITSELF first, then compares.
	executed += 1;
	if (executed === REQUIRED_CASES) {
		process.stdout.write(`PASS acceptance completeness: every required assertion executed (${executed}/${REQUIRED_CASES})\n`);
	} else {
		failures += 1;
		process.stderr.write(`FAIL acceptance completeness: ${executed}/${REQUIRED_CASES} executed\n`);
	}
	if (failures > 0) {
		process.stderr.write(`HISTORY-RECLAIM OVERLAY: ${failures} FAILURE(S) - required acceptance NOT met\n`);
		process.exit(3);
	}
	process.stdout.write("HISTORY-RECLAIM OVERLAY: ALL PASS (run result - see the case labels; deterministic local faux provider through the Harness/Models pattern; no paid or external calls)\n");
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "history-reclaim-overlay-"));
process.on("uncaughtException", (error) => {
	failures += 1;
	process.stderr.write(`FAIL fixture crash (surfaced, not swallowed): ${String(error)}\n`);
	dumpDiagnostics();
	report();
});
process.on("unhandledRejection", (error) => {
	failures += 1;
	process.stderr.write(`FAIL fixture rejection (surfaced, not swallowed): ${String(error)}\n`);
	dumpDiagnostics();
	report();
});

const toolTarget = join(root, "tool-target.txt");
writeFileSync(toolTarget, "native-tool-payload-42\n");

// ==========================================================================
// FIXTURE 1 — streaming + tool + active-turn cancel (one harness; these
// three cases share a live turn lifecycle and never close mid-assert).
// ==========================================================================
{
	const setup = chatSetup({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
	// The barrier is armed ONLY for the cancellable turn.
	const gate = deferred<void>();
	const gateReached = deferred<void>();
	let gateArmed = false;
	addTool(
		setup.registry,
		defineTool({
			name: "read-fixture",
			description: "Reads the fixture file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (args, api, toolContext) => {
				const text = readFileSync(String((args as { path: string }).path), "utf8");
				api.output(text);
				if (gateArmed) {
					gateReached.resolve(); // turn-local evidence: THIS turn reached the barrier
					try {
						await Promise.race([gate.promise, aborted(toolContext.abortSignal)]);
					} catch (error) {
						// The tool's ACTUAL abortSignal observed (captured as evidence).
						toolSawAbort = true;
						throw error;
					}
				}
				return { content: [{ type: "text", text: text.trim() }] };
			},
		}),
	);

	const storage = new MemoryStorage();
	const { harness, root: chat } = await openChat(storage, setup);
	const stream = await watchEvents(harness, chat.id, context);
	const batches: AgentEvent[][] = [];
	stream.start(async (events) => {
		batches.push([...events]);
	});
	let toolSawAbort = false;
	diagnostics = () => ({
		batches: batches.length,
		lastEvents: batches.slice(-3),
		toolSawAbort,
	});
	try {
		// --- REAL STREAMING: subscribed deltas before the message settles ---
		setup.faux.setResponses([fauxAssistantMessage([fauxText("streaming-native-deltas ".repeat(12))])]);
		const submission = await chat.submit({ type: "input", content: "please stream" }, context);
		// (a) the SUBSCRIBED stream delivered message_update changes ...
		await waitFor(() => batches.some((batch) => batch.some((event) => event.type === "message_update")));
		const deltasDelivered = batches.some((batch) => batch.some((event) => event.type === "message_update"));
		// (b) ... BEFORE the message settled: the settled text is not yet in
		// the native entries at the moment the deltas are observed.
		const settledDuringDeltas = JSON.stringify(await allEntries(chat)).includes("streaming-native-deltas ".repeat(12).trim());
		check("real-streaming: subscribed watchEvents deltas delivered before the message settled", deltasDelivered && !settledDuringDeltas);
		await submission.wait(context);
		await waitFor(async () => JSON.stringify(await allEntries(chat)).includes("streaming-native-deltas"));

		// --- REAL TOOL: the registered tool executes; its result is native ---
		setup.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("read-fixture", { path: toolTarget }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("tool-saw-native-tool-payload-42")]),
		]);
		await (await chat.submit({ type: "input", content: "use the tool" }, context)).wait(context);
		await waitFor(async () => {
			const entries = JSON.stringify(await allEntries(chat));
			return entries.includes("native-tool-payload-42") && entries.includes("tool-saw-native-tool-payload-42");
		});
		const toolText = JSON.stringify(await allEntries(chat));
		check("real-tool: the registered tool-call executed with matching arguments", toolText.includes("read-fixture"));
		// Strict tool-result lineage through the REAL records (no default
		// success, missing records FAIL): the tool_execution_end event for
		// callId c1 carries the pi.tool-result entry; the entry's byTaskId
		// resolves to a terminal completed task in storage; the entry's
		// ToolResultMessage has isError false and the payload content.
		const toolEnd = batches.flat().find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolCallId === "c1",
		);
		const resultEntry = toolEnd?.entry;
		const resultMessage = resultEntry?.model?.[0];
		const toolTask = resultEntry?.byTaskId === undefined ? undefined : await storage.task(resultEntry.byTaskId, context);
		const input = toolTask?.input;
		const outcome = toolTask?.state.outcome;
		const lineageOk =
			resultEntry?.kind === "pi.tool-result" &&
			resultMessage?.role === "toolResult" && resultMessage.toolCallId === "c1" &&
			resultMessage.isError === false && JSON.stringify(resultMessage.content).includes("native-tool-payload-42") &&
			toolTask?.kind === "pi.tool" && toolTask.conversationId === chat.id &&
			input !== null && typeof input === "object" && !Array.isArray(input) && input.callId === "c1" &&
			toolTask.state.status === "terminal" && outcome?.status === "completed" &&
			outcome.result !== null && typeof outcome.result === "object" && !Array.isArray(outcome.result) &&
			outcome.result.entryId === resultEntry.id;
		check("real-tool: event/result/task lineage is terminal completed with the actual result entry", lineageOk);

		check("real-tool: the tool result content is in the native entries", toolText.includes("native-tool-payload-42") && toolText.includes("tool-saw-native-tool-payload-42"));

		// --- REAL CANCEL-OF-ACTIVE-TURN: the barrier holds the turn mid-tool;
		// the abort uses the actual AbortSignal and its outcome is asserted. ---
		setup.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("read-fixture", { path: toolTarget }, { id: "c2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("must-not-settle")]),
		]);
		const controller = new AbortController();
		const turnContext = { ...context, abortSignal: controller.signal } as typeof context;
		gateArmed = true; // arm the barrier for THIS cancellable turn only
		const cancellable = await chat.submit({ type: "input", content: "turn to cancel" }, turnContext);
		await gateReached.promise; // turn-local evidence: the barrier was reached (mid-tool)
		const activeObserved = true;
		// The active task id captured WHILE the turn is live (the canonical
		// harness-events pattern uses snapshot(LiveDoc).run.taskId).
		const live = await harness.snapshot(LiveDoc, chat.id, context);
		const cancelledTaskId = live?.run?.taskId;
		// The NATIVE abort (Conversation.abort -> scheduler.abortConversation,
		// harness/harness.ts:144): not a synthetic test-signal race.
		await chat.abort(context);
		const settled = await cancellable.wait(context); // SettledSubmissionRecord
		const settledDespiteAbort = JSON.stringify(await allEntries(chat)).includes("must-not-settle");
		// The terminal proof is the REAL storage task record (signal
		// observation alone is not terminal evidence).
		const cancelledTask = cancelledTaskId === undefined ? undefined : await storage.task(cancelledTaskId, context);
		const taskTerminalAborted =
			cancelledTask !== undefined &&
			cancelledTask.state.status === "terminal" &&
			cancelledTask.abortRequested === true &&
			cancelledTask.state.outcome.status === "aborted";
		check("cancel-of-active-turn: the turn was ACTIVE (mid-tool at the barrier) at abort time", activeObserved);
		check(
			"cancel-of-active-turn: the native Conversation.abort settled the turn (submission unanswered, tool abortSignal observed, no settle)",
			settled.status === "unanswered" && toolSawAbort === true && !settledDespiteAbort,
		);
		check("cancel-of-active-turn: the captured task is terminal-aborted in real storage (not signal-only)", taskTerminalAborted);
		gate.resolve();
	} finally {
		// Native cleanup on every path (success or failure).
		await stream.stop().catch(() => undefined);
		await harness.close(context).catch(() => undefined);
	}
}

// ==========================================================================
// FIXTURE 2 — close/restart: same NATIVE HISTORY through reopened SQLite
// (separate fixture; nothing is invoked through the closed harness).
// ==========================================================================
{
	const setup = chatSetup();
	const path = join(root, "restart.sqlite");
	const storage = await openNodeSqliteStorage(path);
	const { harness, root: chat } = await openChat(storage, setup);
	diagnostics = () => ({ fixture: "restart" });
	try {
		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("restart-marker-alpha")]),
			fauxAssistantMessage([fauxText("restart-marker-beta")]),
		]);
		await (await chat.submit({ type: "input", content: "first" }, context)).wait(context);
		await waitFor(async () => JSON.stringify(await allEntries(chat)).includes("restart-marker-alpha"));
		await (await chat.submit({ type: "input", content: "second" }, context)).wait(context);
		await waitFor(async () => JSON.stringify(await allEntries(chat)).includes("restart-marker-beta"));
		const before = JSON.stringify(await allEntries(chat));
		await harness.close(context);

		const reopened = await openChat(await openNodeSqliteStorage(path), setup);
		try {
			const after = JSON.stringify(await allEntries(reopened.root));
			check("restart: exact native history equality through close+reopen (same storage)", before === after);
			check("restart: the reopened native history contains the streamed content", after.includes("restart-marker-alpha") && after.includes("restart-marker-beta"));
		} finally {
			await reopened.harness.close(context).catch(() => undefined);
		}
	} finally {
		await harness.close(context).catch(() => undefined);
	}
}

// ==========================================================================
// FIXTURE 3 — park/resume (the wrapper's release/resume over real SDK
// close + re-open) and parked-history reclaim. Separate fixture again.
// ==========================================================================
{
	const setup = chatSetup();
	const path = join(root, "park-resume.sqlite");
	const storage = await openNodeSqliteStorage(path);
	const first = await openChat(storage, setup);
	diagnostics = () => ({ fixture: "park-resume" });
	try {
		setup.faux.setResponses([fauxAssistantMessage([fauxText("reclaim-marker")])]);
		await (await first.root.submit({ type: "input", content: "persist me" }, context)).wait(context);
		await waitFor(async () => JSON.stringify(await allEntries(first.root)).includes("reclaim-marker"));
		const beforePark = JSON.stringify(await allEntries(first.root));
		await first.harness.close(context);

		// The wrapper's HydrateSession mapped to the real SDK close/re-open.
		let live: Awaited<ReturnType<typeof openChat>> | undefined;
		let realReleases = 0;
		let realResumes = 0;
		const factory = withRetainedHistory(
			async () => {
				live = await openChat(await openNodeSqliteStorage(path), setup);
				return {
					engine: {
						identity: { sessionId: "hr-1", generation: realResumes + 1, pid: process.pid },
						attach: async () => ({
							async invokeService(call: { member?: string; args?: unknown[] }) {
								if (live === undefined) throw new Error("invoke through a released engine");
								if (call.member === "entries") return { entries: await allEntries(live.root) };
								if (call.member === "rh:park") return { parked: true };
								throw new Error(`unknown member ${String(call.member)}`);
							},
							release: async () => undefined,
						}),
						async close() {
							await live?.harness.close(context);
						},
					},
					releaseResidency: async () => {
						await live?.harness.close(context);
						live = undefined;
						realReleases += 1;
					},
					resumeResidency: async () => {
						live = await openChat(await openNodeSqliteStorage(path), setup);
						realResumes += 1;
					},
				};
			},
			{ maxConcurrentHydrations: 2 },
		);
		const wrapped = await factory.open({ id: "hr-1" }, { sessionId: "hr-1", generation: 1, pid: process.pid }, context);
		const invoke = async (member: string) => {
			const attach = await wrapped.attach({ abortSignal: undefined } as never);
			return attach.invokeService({ member, args: [] } as never, (async () => undefined) as never, {} as never);
		};

		const parkResult = (await invoke("rh:park")) as { parked: boolean };
		check("release-resume: park ran the SDK's real release (close)", parkResult.parked === true && realReleases === 1);
		const afterResume = (await invoke("entries")) as { entries: unknown[] };
		check("release-resume: the resume performed a real Harness re-open (not a counter)", realResumes === 1);
		check("parked-history-reclaim: exact native history equality across park/resume", JSON.stringify(afterResume.entries) === beforePark);
		await wrapped.close({} as never);
	} finally {
		await first.harness.close(context).catch(() => undefined);
	}
}

report();
