/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { type ExecFileException, exec, execFile, execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();
const pendingCommandResults = new Map<string, Promise<string | undefined>>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/** Shared result mapping for the sync/async configured-shell resolvers. */
function mapConfiguredShellResult(result: { error?: ExecFileException; status: number | null; stdout: string }): {
	executed: boolean;
	value: string | undefined;
} {
	if (result.error) {
		if (result.error.code === "ENOENT") {
			return { executed: false, value: undefined };
		}
		return { executed: true, value: undefined };
	}
	if (result.status !== 0) {
		return { executed: true, value: undefined };
	}
	const value = (result.stdout ?? "").trim();
	return { executed: true, value: value || undefined };
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: 10000,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});
		return mapConfiguredShellResult(result);
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/** Shared error construction for the sync/async OrThrow resolvers. */
function resolutionError(config: string, description: string, env?: Record<string, string>): Error {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}
	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			return new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			return new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}
	return new Error(`Failed to resolve ${description}`);
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValueUncached(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}
	throw resolutionError(config, description, env);
}

// ── Async resolution (INPUT-FREEZE fix) ──────────────────────────────────────
// The synchronous command resolvers above run on the Node event loop: in the
// TUI process a slow `!`-command (credential store locks, account pickers)
// freezes keystroke echo for up to the 10s timeout, every uncached request.
// Async resolution retains the command contract (10s timeout, ENOENT/executed
// mapping, stdout trim, per-call freshness for the Uncached family and the
// shared completed-result cache) while awaiting the child
// process off the loop. The sync exports remain for API compatibility.

function runShellAsync(
	cmd: string[],
	opts: { input?: string; timeout: number },
): Promise<{ error?: ExecFileException; status: number | null; stdout: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			cmd[0],
			cmd.slice(1),
			{
				encoding: "utf-8",
				timeout: opts.timeout,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout) => {
				resolve({ error: error ?? undefined, status: error ? null : 0, stdout });
			},
		);
		// The configured Windows shell may receive the command on stdin.
		child.stdin?.on("error", () => {});
		child.stdin?.end(opts.input);
	});
}

async function executeWithConfiguredShellAsync(
	command: string,
): Promise<{ executed: boolean; value: string | undefined }> {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const argv = commandFromStdin ? [shell, ...args] : [shell, ...args, command];
		const result = await runShellAsync(argv, {
			input: commandFromStdin ? command : undefined,
			timeout: 10000,
		});
		return mapConfiguredShellResult(result);
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShellAsync(command: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		exec(command, { encoding: "utf-8", timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) return resolve(undefined);
			resolve(stdout.trim() || undefined);
		});
	});
}

async function executeCommandUncachedAsync(commandConfig: string): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	if (process.platform === "win32") {
		const configuredResult = await executeWithConfiguredShellAsync(command);
		return configuredResult.executed ? configuredResult.value : executeWithDefaultShellAsync(command);
	}
	return executeWithDefaultShellAsync(command);
}

export async function resolveConfigValueAsync(
	config: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "command") return resolveTemplate(reference.parts, env);
	const command = reference.config;
	if (commandResultCache.has(command)) return commandResultCache.get(command);
	const existing = pendingCommandResults.get(command);
	if (existing) return existing;
	const pending = executeCommandUncachedAsync(command).then((result) => {
		// Clearing the cache while a helper waits must not repopulate stale data.
		if (pendingCommandResults.get(command) === pending) {
			commandResultCache.set(command, result);
			pendingCommandResults.delete(command);
		}
		return result;
	});
	pendingCommandResults.set(command, pending);
	return pending;
}

export async function resolveConfigValueUncachedAsync(
	config: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncachedAsync(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

export async function resolveConfigValueOrThrowAsync(
	config: string,
	description: string,
	env?: Record<string, string>,
): Promise<string> {
	const resolvedValue = await resolveConfigValueUncachedAsync(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}
	throw resolutionError(config, description, env);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Async equivalent for provider resolution, preserving per-header freshness. */
export async function resolveHeadersOrThrowAsync(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = await resolveConfigValueOrThrowAsync(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	pendingCommandResults.clear();
}
