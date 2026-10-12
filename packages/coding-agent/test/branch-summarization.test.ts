import {
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	agentLoop,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateBranchSummary,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import { BRANCH_SUMMARY_PREFIX, convertToLlm } from "../src/core/messages.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	SessionEntry,
	SessionMessageEntry,
} from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

// ==========================================================================
// Synthetic crosswalk for built-in bashExecution.excludeFromContext filtering:
// ordinary agent loop, compact helper with/without a previous summary, and branch
// summary helper. This does not exercise automatic dispatch or extension filters.
// ==========================================================================

const PROTECTED = "PROTECTED-SECRET-MARKER-2371";
const RETAINED = "RETAINED-ORDINARY-MARKER-2371";
const PRIOR = "PRIOR-SUMMARY-RETAINED-2371";
const BRANCH_IDENTITY = "BRANCH-IDENTITY-SUMMARY-2371";

function protectedBashExecution(): AgentMessage {
	return {
		role: "bashExecution",
		command: "cat /tmp/secrets.txt",
		output: PROTECTED,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
		excludeFromContext: true,
	};
}

function syntheticMessageEntry(message: AgentMessage): SessionMessageEntry {
	return {
		type: "message",
		id: `syn-${Math.random()}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message,
	};
}

function syntheticCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id: `syn-${Math.random()}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
}

function syntheticBranchSummaryEntry(summary: string): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id: `syn-${Math.random()}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		fromId: "ancestor-1",
		summary,
	};
}

function messagesToText(messages: Message[]): string {
	return messages
		.map((m) =>
			typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
		)
		.join("\n");
}

/** Faux summarization transport: records the exact text that reached the sink. */
function capturedSummarySink(captured: { sinkText: string }): StreamFn {
	return (_model, context) => {
		captured.sinkText = messagesToText(context.messages);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
		);
		return stream;
	};
}

// Small enough that every message is a candidate for summarization.
const forceSummarizeSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

describe("synthetic crosswalk to the shared convertToLlm boundary", () => {
	it("ordinary request: protected bash execution never reaches the faux transport", async () => {
		const captured = { sinkText: "" };
		const streamFn: StreamFn = (_model, context) => {
			captured.sinkText = messagesToText(context.messages);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "ok" }]) }),
			);
			return stream;
		};

		const config: AgentLoopConfig = { model, convertToLlm };
		const context: AgentContext = {
			systemPrompt: "",
			messages: [protectedBashExecution()],
			tools: [],
		};

		for await (const _event of agentLoop(
			[{ role: "user", content: RETAINED, timestamp: 1 }],
			context,
			config,
			undefined,
			streamFn,
		)) {
			// drain
		}

		expect(captured.sinkText).toContain(RETAINED);
		expect(captured.sinkText).not.toContain(PROTECTED);
	});

	it("manual compaction: protected message excluded from summary prompt but retained in raw preparation", async () => {
		const captured = { sinkText: "" };
		const streamFn = capturedSummarySink(captured);

		const b1 = syntheticMessageEntry(protectedBashExecution());
		const u0 = syntheticMessageEntry({ role: "user", content: RETAINED, timestamp: 1 });
		const u1 = syntheticMessageEntry({ role: "user", content: "tail", timestamp: 1 });

		const preparation = prepareCompaction([b1, u0, u1], forceSummarizeSettings);
		expect(preparation).toBeDefined();

		// Preparation retains raw bashExecution content; convertToLlm handles its
		// built-in exclusion flag. This calls compact directly, not session hooks.
		expect(JSON.stringify(preparation)).toContain(PROTECTED);

		const result = await compact(
			preparation as CompactionPreparation,
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(result.summary).toBe("summary");
		expect(captured.sinkText).toContain(RETAINED);
		expect(captured.sinkText).not.toContain(PROTECTED);
	});

	it("automatic compaction: previous summary retained, protected message excluded", async () => {
		const captured = { sinkText: "" };
		const streamFn = capturedSummarySink(captured);

		const u0 = syntheticMessageEntry({ role: "user", content: RETAINED, timestamp: 1 });
		const compaction1 = syntheticCompactionEntry(PRIOR, u0.id);
		const b1 = syntheticMessageEntry(protectedBashExecution());
		const u1 = syntheticMessageEntry({ role: "user", content: "tail", timestamp: 1 });

		const preparation = prepareCompaction([compaction1, u0, b1, u1], forceSummarizeSettings);
		expect(preparation).toBeDefined();
		expect(preparation!.previousSummary).toBe(PRIOR);

		const result = await compact(
			preparation as CompactionPreparation,
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(result.summary).toBe("summary");
		expect(captured.sinkText).toContain(PRIOR);
		expect(captured.sinkText).toContain(RETAINED);
		expect(captured.sinkText).not.toContain(PROTECTED);
	});

	it("branch summary: retained content and branch identity serialized, protected message excluded", async () => {
		const captured = { sinkText: "" };
		const streamFn = capturedSummarySink(captured);

		const branchEntries: SessionEntry[] = [
			syntheticMessageEntry({ role: "user", content: RETAINED, timestamp: 1 }),
			syntheticMessageEntry(protectedBashExecution()),
			syntheticBranchSummaryEntry(BRANCH_IDENTITY),
		];

		const result = await generateBranchSummary(branchEntries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("summary");
		expect(captured.sinkText).toContain(RETAINED);
		expect(captured.sinkText).toContain(BRANCH_IDENTITY);
		expect(captured.sinkText).toContain(BRANCH_SUMMARY_PREFIX.trim());
		expect(captured.sinkText).not.toContain(PROTECTED);
	});

	it("abort: aborted signal surfaces aborted result without a summary", async () => {
		const controller = new AbortController();
		controller.abort();

		const streamFn: StreamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (options?.signal?.aborted) {
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...response([]), stopReason: "aborted", errorMessage: "Request aborted" },
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) });
				}
			});
			return stream;
		};

		const result = await generateBranchSummary(
			[syntheticMessageEntry({ role: "user", content: RETAINED, timestamp: 1 })],
			{ model, signal: controller.signal, streamFn },
		);

		expect(result.aborted).toBe(true);
		expect(result.summary).toBeUndefined();
	});

	it("negative control: raw store keeps the protected message, boundary output drops it", () => {
		// The raw fixture contains the marker; the converter drops it. This is
		// an array-level control, not a file-backed session-store assertion.
		expect(JSON.stringify([protectedBashExecution()])).toContain(PROTECTED);
		expect(JSON.stringify(convertToLlm([protectedBashExecution()]))).not.toContain(PROTECTED);
	});
});

describe("branch summarization", () => {
	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});
});
