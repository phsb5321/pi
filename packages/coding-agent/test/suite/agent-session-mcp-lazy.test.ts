import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import type { McpExposure, McpServerConfig, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const TOOLS = [
	{ name: "search", description: "Search the docs.", inputSchema: { type: "object", properties: {} } },
	{ name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } },
];

/** One fake stdio-like server per transport. `spawned` counts child starts, `open` the ones still running. */
function fakeServerFactory() {
	const state = { spawned: 0, open: 0, calls: [] as string[], initialized: 0 };
	const createTransport = () => {
		const pair = createInMemoryTransportPair();
		state.spawned++;
		state.open++;
		const respond = (request: JsonRpcRequest): unknown => {
			if (request.method === "initialize") {
				state.initialized++;
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
					instructions: "Docs server.",
				};
			}
			if (request.method === "tools/list") return { tools: TOOLS };
			if (request.method === "tools/call") {
				state.calls.push((request.params as { name: string }).name);
				return { content: [{ type: "text", text: "ok" }] };
			}
			return {};
		};
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const request = message as JsonRpcRequest;
			queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) }));
		});
		void pair.server.start();
		const close = pair.client.close.bind(pair.client);
		let closed = false;
		pair.client.close = async () => {
			// A transport counts as stopped once, however many times the client closes it.
			if (!closed) state.open--;
			closed = true;
			await close();
		};
		return pair.client;
	};
	return { state, createTransport };
}

describe("lazy MCP servers", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function session(
		config: Partial<McpServerConfig>,
		factory: ReturnType<typeof fakeServerFactory>,
		cacheDir: string,
		exposure: McpExposure = "codemode",
	) {
		const entry: McpServerEntry = {
			name: "docs",
			config: { url: "http://unused.invalid", exposure, description: "Docs.", ...config } as McpServerConfig,
			source: "test",
		};
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createCodemodeExtension(),
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: factory.createTransport,
					toolCacheDir: cacheDir,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({}) });
		return harness;
	}

	const names = (harness: Harness) => harness.session.getAllTools().map((tool) => tool.name);
	const cacheDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-lazy-"));
		dirs.push(dir);
		return dir;
	};

	async function callPing(harness: Harness) {
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codemode", { code: "await tools.mcp__docs__ping({}); text('called');" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	it("connects once to fill the cache, then later sessions start without any child", async () => {
		const dir = cacheDir();
		const first = fakeServerFactory();
		const one = await session({ lazy: true }, first, dir);
		await vi.waitFor(() => expect(names(one)).toContain("mcp__docs__ping"));
		expect(first.state.spawned).toBe(1);
		expect(
			JSON.parse(readFileSync(join(dir, "mcp-tools-cache.json"), "utf8")).servers.docs.snapshot.tools,
		).toHaveLength(2);

		const second = fakeServerFactory();
		const two = await session({ lazy: true }, second, dir);
		await vi.waitFor(() => expect(names(two)).toContain("mcp__docs__ping"));
		expect(names(two)).toContain("mcp__docs__search");
		expect(second.state.spawned).toBe(0);
		expect(second.state.open).toBe(0);

		await callPing(two);
		expect(second.state.spawned).toBe(1);
		expect(second.state.calls).toEqual(["ping"]);
	});

	it("starts a cached lazy server only for the script that names it", async () => {
		const dir = cacheDir();
		await session({ lazy: true }, fakeServerFactory(), dir);
		const factory = fakeServerFactory();
		const harness = await session({ lazy: true }, factory, dir);
		await vi.waitFor(() => expect(names(harness)).toContain("mcp__docs__ping"));
		harness.setResponses([fauxAssistantMessage("no tools used")]);
		await harness.session.prompt("just talk");
		expect(factory.state.spawned).toBe(0);
	});

	it("registers the same tools and prompt section whether the server is started or cached", async () => {
		const dir = cacheDir();
		const eager = await session({ lazy: true }, fakeServerFactory(), dir);
		await vi.waitFor(() => expect(names(eager)).toContain("mcp__docs__ping"));
		const lazy = await session({ lazy: true }, fakeServerFactory(), dir);
		await vi.waitFor(() => expect(names(lazy)).toContain("mcp__docs__ping"));
		expect(names(lazy).sort()).toEqual(names(eager).sort());
		const codemode = (harness: Harness) =>
			harness.session.getAllTools().find((tool) => tool.name === "codemode")?.description;
		expect(codemode(lazy)).toBe(codemode(eager));
		expect(codemode(lazy)).toBeTruthy();
	});

	it("never serves tools from a stale cache entry: a changed start command connects again", async () => {
		const dir = cacheDir();
		await session({ lazy: true, url: "http://a.invalid" }, fakeServerFactory(), dir);
		const factory = fakeServerFactory();
		const harness = await session({ lazy: true, url: "http://b.invalid" }, factory, dir);
		await vi.waitFor(() => expect(names(harness)).toContain("mcp__docs__ping"));
		expect(factory.state.spawned).toBe(1);
	});

	it("treats a damaged cache file as empty", async () => {
		const dir = cacheDir();
		writeFileSync(join(dir, "mcp-tools-cache.json"), "{not json");
		const factory = fakeServerFactory();
		const harness = await session({ lazy: true }, factory, dir);
		await vi.waitFor(() => expect(names(harness)).toContain("mcp__docs__ping"));
		expect(factory.state.spawned).toBe(1);
	});

	it("does not apply lazy to a server with tools declared to the model", async () => {
		const dir = cacheDir();
		await session({ lazy: true }, fakeServerFactory(), dir, "direct");
		const factory = fakeServerFactory();
		const harness = await session({ lazy: true }, factory, dir, "direct");
		await vi.waitFor(() => expect(names(harness)).toContain("mcp__docs__ping"));
		expect(factory.state.spawned).toBe(1);
	});

	it("closes an idle connection, keeps the tools, and connects again on the next call", async () => {
		const dir = cacheDir();
		const factory = fakeServerFactory();
		const harness = await session({ idleTimeout: 0.2 }, factory, dir);
		await vi.waitFor(() => expect(names(harness)).toContain("mcp__docs__ping"));
		expect(factory.state.open).toBe(1);
		await vi.waitFor(() => expect(factory.state.open).toBe(0), { timeout: 3000 });
		expect(names(harness)).toContain("mcp__docs__ping");

		await callPing(harness);
		expect(factory.state.calls).toEqual(["ping"]);
		expect(factory.state.spawned).toBe(2);
		await vi.waitFor(() => expect(factory.state.open).toBe(0), { timeout: 3000 });
	});

	it("never closes a connection while a request is in flight", async () => {
		const dir = cacheDir();
		const factory = fakeServerFactory();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = factory.createTransport;
		let slowCalls = 0;
		const gated = {
			state: factory.state,
			createTransport: () => {
				const client = slow();
				const send = client.send.bind(client);
				client.send = async (message) => {
					if ("method" in message && message.method === "tools/call") {
						slowCalls++;
						await gate;
					}
					return send(message);
				};
				return client;
			},
		};
		const harness = await session({ idleTimeout: 0.15 }, gated, dir);
		await vi.waitFor(() => expect(names(harness)).toContain("mcp__docs__ping"));
		const running = callPing(harness);
		await vi.waitFor(() => expect(slowCalls).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(factory.state.open).toBe(1);
		release();
		await running;
		expect(factory.state.calls).toEqual(["ping"]);
		await vi.waitFor(() => expect(factory.state.open).toBe(0), { timeout: 3000 });
	});

	it("rejects invalid lifecycle settings", async () => {
		const { validateMcpServerConfig } = await import("../../src/core/mcp-servers.ts");
		expect(validateMcpServerConfig("x", { command: "a", lazy: "yes" })).toContain("lazy must be a boolean");
		expect(validateMcpServerConfig("x", { command: "a", idleTimeout: 0 })).toContain(
			"idleTimeout must be a positive",
		);
		expect(validateMcpServerConfig("x", { command: "a", idleTimeout: -1 })).toContain(
			"idleTimeout must be a positive",
		);
		expect(validateMcpServerConfig("x", { command: "a", lazy: true, idleTimeout: 30 })).toEqual({
			command: "a",
			lazy: true,
			idleTimeout: 30,
		});
	});
});
