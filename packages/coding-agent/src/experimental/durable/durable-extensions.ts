/**
 * Durable extension host (gate 2, 16/10/2026): loads the fleet's interactive
 * extensions into the durable runtime and forwards the hooks the runtime can
 * honor — session_start, agent_start, agent_settled, model_select.
 *
 * Interactive pi completes the loader runtime through ExtensionRunner
 * (bindCore/initialize), which requires a core SessionManager and the
 * interactive host. The durable runtime has neither, so this module completes
 * the loader runtime directly — the documented contract is "Created by loader
 * with throwing action stubs, completed by runner.initialize()" — with
 * durable-backed implementations and per-attached-session dispatch.
 *
 * Scope: the fleet-mandatory pair — parity.ts (model-policy guard,
 * `model_select` revert semantics) and herdr-agent-state.ts (session state
 * over the herdr socket) — plus anything auto-discovered under
 * `agentDir/extensions` and explicitly configured paths (daemon `--extension`,
 * mirroring interactive `--extension`).
 *
 * Handler errors are contained: a throwing handler becomes a session notice;
 * the durable operation that triggered the event never fails.
 *
 * ponytail: ONE active dispatch scope at a time (module-level `active`) —
 * the fleet runs one live seat per daemon, and pi.* actions inside a handler
 * must route to the session that dispatched. A second concurrent dispatch
 * would route them to the wrong session; per-session runtimes (one
 * loadExtensions per engine) are the upgrade path when multi-seat extension
 * parity is actually needed.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { createEventBus } from "../../core/event-bus.ts";
import { loadExtensions } from "../../core/extensions/loader.ts";
import { noOpUIContext } from "../../core/extensions/runner.ts";
import type { ExtensionContext, LoadExtensionsResult } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { Settings } from "../../core/settings-manager.ts";

let configuredExtraPaths: readonly string[] = [];

/** Paths the daemon collects from repeatable `--extension` flags (interactive parity). */
export function configureDurableExtensionPaths(paths: readonly string[]): void {
	configuredExtraPaths = [...paths];
}

/** Per-session callbacks the host routes extension actions and context reads to. */
export interface DurableExtensionScopeInput {
	notice(level: "info" | "warning" | "error", message: string): void;
	/** Apply a model switch WITHOUT re-dispatching model_select (the dispatcher owns emission). */
	applyModel(model: Model<any>): Promise<void>;
	currentModel(): Model<any> | undefined;
	currentThinkingLevel(): ThinkingLevel | undefined;
	/** Model-context messages of the active conversation (read-only view for guards). */
	conversationMessages(): readonly unknown[];
	isIdle(): boolean;
	sessionId(): string | undefined;
	sessionFile(): string | undefined;
	cwd: string;
	modelRegistry: object;
	/** Harness settings snapshot for read-only pi.getSettings(). */
	settings(): object;
}

export interface DurableExtensionScope {
	sessionStarted(reason: "startup" | "reload" | "new" | "resume" | "fork"): Promise<void>;
	agentStarted(): Promise<void>;
	agentSettled(aborted: boolean): Promise<void>;
	modelSelected(
		model: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void>;
}

interface DurableExtensionHost {
	result: LoadExtensionsResult;
	cwd: string;
}

let hostPromise: Promise<DurableExtensionHost | undefined> | undefined;
let active: DurableExtensionScopeInput | undefined;
let dispatchDepth = 0;

const dispatchInactive = (): Error => new Error("No active durable extension dispatch");

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

async function loadDurableExtensions(
	cwd: string,
	notice: DurableExtensionScopeInput["notice"],
): Promise<DurableExtensionHost | undefined> {
	const globalDir = join(getAgentDir(), "extensions");
	let discovered: string[] = [];
	try {
		discovered = readdirSync(globalDir)
			.filter((name) => isExtensionFile(name))
			.map((name) => join(globalDir, name));
	} catch {
		// No global extensions directory — configured paths only.
	}
	const seen = new Set<string>();
	const paths = [...discovered, ...configuredExtraPaths].filter((path) => {
		const resolved = join(path);
		if (seen.has(resolved)) return false;
		seen.add(resolved);
		return true;
	});
	if (paths.length === 0) return undefined;

	const eventBus = createEventBus();
	const result = await loadExtensions(paths, cwd, eventBus);
	for (const error of result.errors) {
		notice("warning", `extension ${basename(error.path)} failed to load: ${error.error}`);
	}
	if (result.extensions.length === 0) return undefined;
	return { result, cwd };
}

/**
 * Load once per process. Failures are reported once through the first
 * requesting session's notice channel and cached (no retry storm); a later
 * process restart retried by definition.
 */
export async function ensureDurableExtensions(
	cwd: string,
	notice: DurableExtensionScopeInput["notice"],
): Promise<DurableExtensionHost | undefined> {
	hostPromise ??= loadDurableExtensions(cwd, notice).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		notice("warning", `durable extension host failed to load: ${message}`);
		return undefined;
	});
	return hostPromise;
}

function buildContext(scope: DurableExtensionScopeInput): ExtensionContext {
	const ui = {
		...noOpUIContext,
		notify: (message: string, level?: "info" | "warning" | "error") => scope.notice(level ?? "info", message),
	};
	return {
		ui,
		// The attached durable TUI is a real terminal UI; herdr-agent-state
		// gates its session reporting on mode === "tui".
		mode: "tui",
		hasUI: true,
		cwd: scope.cwd,
		// Structural stub: extensions only READ the context snapshot
		// (buildSessionContext().messages). A real core SessionManager bridge
		// is the upgrade path if an extension needs writes.
		sessionManager: {
			buildSessionContext: () => ({ messages: scope.conversationMessages() }),
			getSessionFile: () => scope.sessionFile(),
			getSessionId: () => scope.sessionId(),
			// parity.ts reads the live branch/entries for tool-family analysis
			// (model_select deep path); the durable conversation's model context
			// is the honest equivalent. Return shapes beyond messages are the
			// upgrade path if a guard needs them.
			getEntries: () => scope.conversationMessages(),
			getBranch: () => scope.conversationMessages(),
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry: scope.modelRegistry as unknown as ModelRegistry,
		model: scope.currentModel(),
		scopedModels: [],
		thinkingLevel: scope.currentThinkingLevel(),
		isIdle: () => scope.isIdle(),
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

async function dispatch(
	host: DurableExtensionHost,
	scope: DurableExtensionScopeInput,
	type: string,
	event: object,
): Promise<void> {
	// Backstop for revert loops; parity guards its own reverts with a flag.
	if (dispatchDepth >= 4) return;
	const handlers = host.result.extensions.flatMap((extension) =>
		[...(extension.handlers.get(type) ?? [])].map((handler) => ({ handler, path: extension.path })),
	);
	if (handlers.length === 0) return;
	const previous = active;
	active = scope;
	dispatchDepth += 1;
	try {
		for (const { handler, path } of handlers) {
			try {
				await handler(event, buildContext(scope));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				scope.notice("warning", `extension ${basename(path)} ${type}: ${message}`);
			}
		}
	} finally {
		dispatchDepth -= 1;
		active = previous;
	}
}

/**
 * Create the per-session dispatch scope. Returns undefined when this process
 * has no extensions (host absent or empty) — the runtime then behaves exactly
 * as before this module existed.
 */
export async function createDurableExtensionScope(
	scope: DurableExtensionScopeInput,
): Promise<DurableExtensionScope | undefined> {
	const host = await ensureDurableExtensions(scope.cwd, scope.notice);
	if (host === undefined) return undefined;

	const runtime = host.result.runtime;
	// Complete the loader's throwing action stubs (loader contract: actions are
	// "throwing stubs until runner.initialize()") — durable-host completion.
	runtime.setModel = (model) => {
		if (active === undefined) return Promise.reject(dispatchInactive());
		return active.applyModel(model).then(() => true);
	};
	runtime.getThinkingLevel = () => {
		if (active === undefined) throw dispatchInactive();
		return active.currentThinkingLevel() ?? "off";
	};
	// Read-only inventory actions the fleet extensions call in lifecycle hooks;
	// routed through the active dispatch like the actions above (the durable
	// registry owns tools, so the inventory reads are truthful empties).
	runtime.getSettings = () => {
		if (active === undefined) throw dispatchInactive();
		return active.settings() as Settings;
	};
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	runtime.getCommands = () => [];
	runtime.getSessionName = () => {
		if (active === undefined) throw dispatchInactive();
		return active.sessionId();
	};

	const self: DurableExtensionScope = {
		sessionStarted: (reason) => dispatch(host, scope, "session_start", { type: "session_start", reason }),
		agentStarted: () => dispatch(host, scope, "agent_start", { type: "agent_start" }),
		agentSettled: (aborted: boolean) => dispatch(host, scope, "agent_settled", { type: "agent_settled", aborted }),
		modelSelected: (model, previousModel, source) =>
			dispatch(host, scope, "model_select", { type: "model_select", model, previousModel, source }),
	};
	return self;
}
