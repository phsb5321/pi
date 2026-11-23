/**
 * The tool lists of `lazy` MCP servers, kept on disk so a session can register their tools without
 * starting them.
 *
 * Problem: every seat starts every configured MCP server to learn its tools, and most seats never call
 * them; 49 of 498 seats held 4.5 GiB of helper RSS in one measurement. Solution: a `lazy` server's tool
 * list from its last connection is read from `mcp-tools-cache.json`; the server starts on its first call.
 *
 * An entry is keyed by the server name and a hash of what starts it (command, args, env, cwd, or url),
 * so a new build of the server (a new store path) or an edited config is a miss and the server connects
 * once at startup to refill the entry. A damaged or unreadable file is an empty cache.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tool as McpTool } from "@earendil-works/pi-mcp";
import type { McpServerEntry } from "./config.ts";
import type { ServerSnapshot } from "./runtime.ts";

const CACHE_FILE = "mcp-tools-cache.json";
const CACHE_VERSION = 1;

interface CacheFile {
	version: number;
	servers: Record<string, { key: string; snapshot: ServerSnapshot }>;
}

/** What starts the server: anything that changes it makes the cached tools untrustworthy. */
export function startKey(entry: McpServerEntry): string {
	const { config } = entry;
	const startup =
		"url" in config
			? { url: config.url }
			: { command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd ?? "" };
	return createHash("sha256").update(JSON.stringify(startup)).digest("hex").slice(0, 24);
}

function isSnapshot(value: unknown): value is ServerSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const { tools, hasResources, instructions } = value as Partial<ServerSnapshot>;
	return (
		Array.isArray(tools) &&
		tools.every((tool) => typeof tool === "object" && tool !== null && typeof (tool as McpTool).name === "string") &&
		typeof hasResources === "boolean" &&
		(instructions === undefined || typeof instructions === "string")
	);
}

export class McpToolCache {
	private readonly path: string;
	private data: CacheFile | undefined;

	constructor(agentDir: string) {
		this.path = join(agentDir, CACHE_FILE);
	}

	private load(): CacheFile {
		if (this.data) return this.data;
		this.data = { version: CACHE_VERSION, servers: {} };
		try {
			if (existsSync(this.path)) {
				const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CacheFile>;
				if (parsed.version === CACHE_VERSION && typeof parsed.servers === "object" && parsed.servers !== null) {
					this.data.servers = parsed.servers;
				}
			}
		} catch {
			// An unreadable cache is an empty one.
		}
		return this.data;
	}

	get(entry: McpServerEntry): ServerSnapshot | undefined {
		const hit = this.load().servers[entry.name];
		return hit && hit.key === startKey(entry) && isSnapshot(hit.snapshot) ? hit.snapshot : undefined;
	}

	/** Record a connection's tools. Never throws: the cache is an optimisation. */
	set(entry: McpServerEntry, snapshot: ServerSnapshot): void {
		// Other sessions write this file too: read it again so their entries are kept.
		this.data = undefined;
		const data = this.load();
		const key = startKey(entry);
		const known = data.servers[entry.name];
		if (known && known.key === key && JSON.stringify(known.snapshot) === JSON.stringify(snapshot)) return;
		data.servers[entry.name] = { key, snapshot };
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
			renameSync(temp, this.path);
		} catch {
			// Not writable: the next session connects at startup again.
		}
	}
}
