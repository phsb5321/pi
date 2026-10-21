import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	type AgentTool,
	type AgentToolCallOutcome,
	type AgentToolResult,
	runToolCall,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	type Agent,
	type ConversationId,
	defineTool,
	type Extension,
	type Harness,
	ROOT_CONVERSATION_ID,
	type Storage,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { OutputBuffer } from "../../../../durable/src/harness/output.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../../../durable/src/truncate.ts";
import { loadExtensions } from "../../core/extensions/loader.ts";
import { ExtensionRunner } from "../../core/extensions/runner.ts";
import type { LoadExtensionsResult } from "../../core/extensions/types.ts";
import { wrapRegisteredTool } from "../../core/extensions/wrapper.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { NestedToolCallRunner } from "../../core/nested-tool-calls.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import type { NormalizeToolResultImagesOptions } from "../../utils/tool-result-images.ts";
import { type NativeExtensionHistory, readNativeExtensionHistory } from "./extension-history.ts";
import { NativeExtensionSessionReader } from "./extension-session-reader.ts";
import {
	createNativeExtensionToolPolicy,
	nativeExtensionAfterTool,
	nativeExtensionBeforeTool,
} from "./extension-tool-policy.ts";
import type { SessionLocation } from "./sessions.ts";

const unavailable = (): never => {
	throw new Error("This ordinary extension action is not yet bound to native persistence/lifecycle");
};

/** The currently implemented native composition capabilities, never a silent event/registration filter. */
export async function loadNativeExtensions(paths: string[], cwd: string): Promise<LoadExtensionsResult> {
	const result = await loadExtensions(paths, cwd);
	if (result.errors.length) throw new Error(`Native extension loading failed: ${JSON.stringify(result.errors)}`);
	for (const extension of result.extensions) {
		for (const event of extension.handlers.keys()) {
			if (!["tool_call", "tool_result", "session_start", "session_shutdown"].includes(event)) {
				throw new Error(`Native extension event ${event} is not yet bound: ${extension.path}`);
			}
		}
		if (
			extension.shortcuts.size ||
			extension.messageRenderers.size ||
			extension.entryRenderers?.size ||
			extension.markdownTransformer ||
			extension.toolRenderers?.length
		) {
			throw new Error(`Native extension UI/rendering is not yet bound: ${extension.path}`);
		}
		for (const { definition } of extension.tools.values()) {
			if (definition.defaultActive === false)
				throw new Error(`Native inactive custom-tool registration is not yet bound: ${definition.name}`);
			if (definition.exposure && definition.exposure !== "direct")
				throw new Error(`Native tool exposure is not yet bound: ${definition.name}`);
		}
	}
	if (result.runtime.mcpServers.list().length) throw new Error("Native extension MCP registration is not yet bound");
	if (
		result.runtime.pendingProviderRegistrations.length ||
		result.runtime.pendingNativeProviderRegistrations.length ||
		result.runtime.pendingVirtualModelRegistrations.length
	) {
		throw new Error("Native extension provider registration is not yet bound");
	}
	return result;
}

interface BoundConversation {
	readonly runner: ExtensionRunner;
	readonly reader: NativeExtensionSessionReader;
	readonly invocations: Map<string, { api: ToolExecutionApi; context: Context; modelCallId: string }>;
	readonly nested: NestedToolCallRunner;
	callableTools: readonly AgentTool[];
	history: NativeExtensionHistory;
	agent: Agent;
	signal: AbortSignal | undefined;
	idle: boolean;
	pending: boolean;
	systemPrompt: string;
}

/** Existing ordinary loader/runner + actual native read-only history; no second registration or callback engine. */
export class NativeExtensionComposition {
	private paths: string[];
	private settings: SettingsManager;
	private location: SessionLocation;
	private models: ModelRuntime;
	private report: (error: Error) => void;
	private harness: Harness | undefined;
	private storage: Storage | undefined;
	private closed = false;
	private loadedRoot: LoadExtensionsResult | undefined;
	private bound = new Map<ConversationId, Promise<BoundConversation>>();

	constructor(
		paths: string[],
		settings: SettingsManager,
		location: SessionLocation,
		models: ModelRuntime,
		report: (error: Error) => void,
	) {
		this.paths = paths;
		this.settings = settings;
		this.location = location;
		this.models = models;
		this.report = report;
	}

	attach(harness: Harness, storage: Storage): void {
		this.harness = harness;
		this.storage = storage;
	}

	installation(loaded: LoadExtensionsResult): Extension {
		this.loadedRoot = loaded;
		const composition = this;
		const policy = createNativeExtensionToolPolicy(
			async (id, context) => (await this.forConversation(id, context)).runner,
			async (id, context) => this.imageOptions(await this.forConversation(id, context)),
		);
		return {
			...policy,
			tools: loaded.extensions
				.flatMap((extension) => [...extension.tools.values()])
				.map(({ definition }) =>
					defineTool({
						name: definition.name,
						description: definition.description,
						parameters: definition.parameters,
						prepareArguments: definition.prepareArguments,
						executionMode: definition.executionMode,
						replay: definition.replay,
						async execute(args, api, context) {
							const bound = await composition.forConversation(api.conversationId, context);
							const registered = bound.runner
								.getAllRegisteredTools()
								.find((tool) => tool.definition.name === definition.name);
							if (!registered) throw new Error(`Native extension tool disappeared: ${definition.name}`);
							const root = !bound.invocations.has(api.callId);
							if (root) bound.invocations.set(api.callId, { api, context, modelCallId: api.callId });
							bound.callableTools = api.registry
								.tools()
								.map(({ tool }) => composition.callable(tool, api, context, bound));
							try {
								const tool = wrapRegisteredTool(registered, bound.runner);
								let result: AgentToolResult<unknown>;
								try {
									result = await tool.execute(api.callId, args, context.abortSignal);
								} catch (error) {
									result = {
										content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
										details: undefined,
										isError: true,
									};
								}
								const summary = root ? bound.nested.takeRecord(api.callId) : undefined;
								if (result.structuredContent !== undefined)
									throw new Error("Native structured extension tool output is not yet bound");
								return {
									content: result.content,
									isError: result.isError,
									usage: summary?.usage
										? result.usage
											? combineUsage(result.usage, summary.usage)
											: summary.usage
										: result.usage,
									...(summary ? { nestedCalls: summary.calls } : {}),
									...(result.details === undefined ? {} : { details: copyJson(result.details) }),
								};
							} finally {
								if (root) {
									bound.invocations.delete(api.callId);
									bound.nested.takeRecord(api.callId);
								}
							}
						},
					}),
				),
		};
	}

	private imageOptions(bound: BoundConversation): NormalizeToolResultImagesOptions {
		const ref = bound.agent.model;
		return {
			autoResizeImages: this.settings.getImageAutoResize(),
			resizeOptions: ref ? this.models.getModel(ref.provider, ref.modelId)?.inputLimits?.images?.resize : undefined,
		};
	}

	/** Adapt registered native tools, using the actual parent invocation, not another task or fabricated transcript call. */
	private callable(
		tool: ToolRegistration,
		api: ToolExecutionApi,
		context: Context,
		bound: BoundConversation,
	): AgentTool {
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			prepareArguments: tool.prepareArguments,
			executionMode: tool.executionMode,
			execute: async (callId, args, signal, onUpdate) => {
				const childContext = signal ? withAbortSignal(signal, context) : context;
				const output = new OutputBuffer({
					maxBytes: tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
					maxLines: tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
					retain: tool.outputLimits?.retain ?? "head",
				});
				let details: JsonValue | undefined;
				const diagnostics: NonNullable<ToolExecutionResult["diagnostics"]>[number][] = [];
				function memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
				function memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
				function memo<T extends JsonValue>(
					...args: [string, Context] | [string, T, Context]
				): Promise<T | undefined> {
					const name = `nested:${callId}:${args[0]}`;
					return args.length === 2 ? api.memo<T>(name, args[1]) : api.memo<T>(name, args[1], args[2]);
				}
				const childApi: ToolExecutionApi = {
					...api,
					callId,
					memo,
					outputWindow: undefined,
					output(chunk, skipped) {
						output.push(chunk, skipped);
						onUpdate?.({ content: [{ type: "text", text: output.snapshot().text }], details });
					},
					diagnostic(value) {
						diagnostics.push(value);
					},
					async details(value) {
						details = copyJson(value);
					},
				};
				const parent = bound.invocations.get(api.callId);
				if (!parent) throw new Error(`Native nested caller ${api.callId} is stale`);
				bound.invocations.set(callId, { api: childApi, context: childContext, modelCallId: parent.modelCallId });
				try {
					const result = await tool.execute(args, childApi, childContext);
					return {
						...result,
						content: result.content ?? [{ type: "text", text: output.snapshot().text }],
						details: result.details ?? details,
						diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
					};
				} finally {
					bound.invocations.delete(callId);
				}
			},
		};
	}

	private async forConversation(id: ConversationId, context: Context): Promise<BoundConversation> {
		if (this.closed || !this.harness || !this.storage)
			throw new Error("Native extension composition is stale or not attached");
		const conversation = await this.harness.conversation(id, context);
		if (!conversation) throw new Error(`Native extension conversation ${id} is absent`);
		const agent = await conversation.agent(context);
		const history = await readNativeExtensionHistory(this.harness, this.storage, id, context);
		const inspection = await this.harness.inspect(context);
		let promise = this.bound.get(id);
		if (!promise) {
			promise = (async () => {
				const loaded =
					id === ROOT_CONVERSATION_ID
						? this.loadedRoot
						: await loadNativeExtensions(this.paths, agent.cwd ?? this.location.cwd);
				if (!loaded) throw new Error("Native root extensions were not loaded before binding");
				const reader = new NativeExtensionSessionReader(
					{ ...this.location, cwd: agent.cwd ?? this.location.cwd },
					history,
					{ model: agent.model ?? null, thinkingLevel: agent.thinkingLevel },
				);
				const runner = new ExtensionRunner(
					loaded.extensions,
					loaded.runtime,
					reader.getCwd(),
					reader,
					new ModelRegistry(this.models),
				);
				runner.onError((error) => this.report(new Error(`${error.extensionPath}: ${error.event}: ${error.error}`)));
				const nested = new NestedToolCallRunner({
					getTools: () => bound.callableTools,
					// Native Harness settings currently expose no execution-mode override: its default is parallel.
					isSequential: () => false,
					emit: async () => {}, // The real runner policy events below are distinct from optional UI progress.
					runToolCall: async (call, parentToolCallId, signal, onUpdate): Promise<AgentToolCallOutcome> => {
						const parent = bound.invocations.get(parentToolCallId);
						if (!parent) throw new Error(`Native nested caller ${parentToolCallId} is stale`);
						const assistantMessage = bound.history.entries
							.flatMap((entry) => entry.model)
							.findLast(
								(message): message is AssistantMessage =>
									message.role === "assistant" &&
									message.content.some((item) => item.type === "toolCall" && item.id === parent.modelCallId),
							);
						if (!assistantMessage) throw new Error(`Native model-issued parent ${parent.modelCallId} is absent`);
						const tools = parent.api.registry
							.tools()
							.map(({ tool }) => this.callable(tool, parent.api, parent.context, bound));
						return runToolCall(call, {
							tools,
							assistantMessage,
							context: { messages: [...bound.history.context.messages], tools },
							signal,
							onUpdate,
							beforeToolCall: async ({ toolCall, args }) => {
								const decision = await nativeExtensionBeforeTool(runner, toolCall, parentToolCallId, args);
								return decision ? { block: true, reason: decision.block } : undefined;
							},
							afterToolCall: async ({ toolCall, args, result, isError }) => {
								const changed = await nativeExtensionAfterTool(
									runner,
									toolCall,
									{
										...result,
										details: result.details === undefined ? undefined : copyJson(result.details),
										isError,
									},
									parentToolCallId,
									this.imageOptions(bound),
									args,
								);
								return {
									...result,
									content: changed.content ?? [],
									details: changed.details,
									isError: changed.isError ?? isError,
								};
							},
						});
					},
				});
				const bound: BoundConversation = {
					runner,
					reader,
					invocations: new Map(),
					nested,
					callableTools: [],
					history,
					agent,
					signal: context.abortSignal,
					idle: true,
					pending: false,
					systemPrompt: "",
				};
				runner.bindCore(
					{
						sendMessage: unavailable,
						sendUserMessage: unavailable,
						appendEntry: unavailable,
						setSessionName: unavailable,
						getSessionName: () => reader.getSessionName(),
						setLabel: unavailable,
						getActiveTools: () => bound.agent.tools.map((tool) => tool.name),
						getAllTools: unavailable,
						getSettings: () => this.settings.getSettings(),
						setActiveTools: unavailable,
						refreshTools: unavailable,
						getCommands: () =>
							runner.getRegisteredCommands().map((command) => ({
								name: command.invocationName,
								source: "extension",
								description: command.description,
								sourceInfo: command.sourceInfo,
							})),
						setModel: async (model) => {
							await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
							return true;
						},
						getThinkingLevel: () => bound.agent.thinkingLevel,
						setThinkingLevel: unavailable,
					},
					{
						getModel: () =>
							bound.agent.model
								? this.models.getModel(bound.agent.model.provider, bound.agent.model.modelId)
								: undefined,
						getScopedModels: unavailable,
						isIdle: () => bound.idle,
						isProjectTrusted: () => this.settings.isProjectTrusted(),
						getSignal: () => bound.signal,
						abort: unavailable,
						hasPendingMessages: () => bound.pending,
						shutdown: unavailable,
						getContextUsage: () => undefined,
						compact: unavailable,
						getSystemPrompt: () => bound.systemPrompt,
						executeTool: (callerId, name, args, options) => {
							if (!bound.invocations.has(callerId)) throw new Error(`Native nested caller ${callerId} is stale`);
							return bound.nested.execute(callerId, name, args, options);
						},
						getCallableTools: () => bound.callableTools,
					},
				);
				runner.bindCommandContext({
					waitForIdle: () => conversation.waitForIdle(context),
					newSession: unavailable,
					fork: unavailable,
					navigateTree: unavailable,
					switchSession: unavailable,
					reload: unavailable,
				});
				return bound;
			})();
			this.bound.set(id, promise);
		}
		const bound = await promise;
		if (this.closed) {
			bound.runner.invalidate();
			bound.reader.invalidate();
			throw new Error("Native extension composition is stale after close");
		}
		bound.reader.update(history, { model: agent.model ?? null, thinkingLevel: agent.thinkingLevel });
		bound.agent = agent;
		bound.history = history;
		bound.signal = context.abortSignal;
		bound.idle = !inspection.tasks.some((task) => task.record.conversationId === id);
		bound.pending = inspection.submissions.some(
			(submission) => submission.conversationId === id && submission.status === "queued",
		);
		const system = getCurrentSystemMessage(history.context.messages);
		bound.systemPrompt = system
			? typeof system.content === "string"
				? system.content
				: system.content.map((part) => part.text).join("\n")
			: "";
		return bound;
	}

	async start(id: ConversationId, reason: "new" | "resume"): Promise<void> {
		const bound = await this.forConversation(id, BACKGROUND_CONTEXT);
		await bound.runner.emit({ type: "session_start", reason });
	}

	async command(id: ConversationId, text: string): Promise<boolean> {
		if (!text.startsWith("/")) return false;
		return (await this.forConversation(id, BACKGROUND_CONTEXT)).runner.tryExecuteCommand(text);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.bound.values()) {
			const { runner, reader, nested, invocations } = await pending;
			try {
				await runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				runner.invalidate();
				reader.invalidate();
				nested.clear();
				invocations.clear();
			}
		}
		this.bound.clear();
		this.loadedRoot?.runtime.invalidate();
		this.loadedRoot = undefined;
	}
}

// mutated negative bytes
