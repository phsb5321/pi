/**
 * Shared-host daemon (last-mile slice, 14/10/2026 build brief).
 *
 * Process shape: one Node process hosting many durable session engines over
 * the EXISTING production path — `createSharedHostResidency` (in-process
 * runtime + shared-process admission + retained-history) exposed through
 * `Server` + a REAL unix-socket listener (`@earendil-works/pi-server/unix`).
 * This is the listener-composed host form; nothing here re-implements
 * routing, admission, or engine ownership.
 *
 * Security: the Node unix transport does not expose SO_PEERCRED, so peer
 * identity cannot be checked per connection on this transport. The daemon
 * compensates at the filesystem boundary: the socket directory must be
 * 0700 and owned by the daemon euid and the socket 0600 in the same
 * ownership — no other local user can complete a connect() against the
 * socket. The gate runs after bind and refuses to serve otherwise.
 *
 * Signal-clean shutdown: SIGINT/SIGTERM stop the listener (no new
 * connections), then close the server and drain engines (releasing every
 * session's exclusive durable writer) before exiting 0.
 *
 * Sessions live under one root directory: `<root>/<session-id>/` is the
 * native session cwd and `<root>/<session-id>.resident.json` the residency
 * record. The DURABLE STORE ITSELF lives under the agent dir
 * (`~/.pi/agent/experimental/durable-sessions/<hash>/<native-id>/`, SQLite
 * WAL) — NOT under the root; the root holds only the cwd binding and the
 * resident record. Daemon restart with the same root recovers sessions from
 * durable state with native continuation (durable claim), exactly like the
 * residency acceptance. Session removal is manual (both the root entry and
 * the agent-dir store) — the daemon never deletes sessions.
 *
 * The faux wiring (`createFauxSharedHostDaemon`) is TEST-ONLY: a faux
 * provider (no network, no credentials) with a bounded scripted response
 * queue so the canary can drive real streaming/tool round-trips without
 * any paid API. Never use it to serve real seats. Default composition is
 * the production wiring: `ModelRuntime.create()` from the seat's agent dir.
 *
 * DEFAULT OFF: importing this module runs nothing; the daemon starts only
 * when `main()` runs (direct invocation) or an application calls
 * `createSharedHostDaemon`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, type StatsBase } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { getAgentDir } from "../../config.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { createExperimentalServerServices } from "../services/server.ts";
import type { SessionSummary } from "../services/sessions.ts";
import { configureDurableExtensionPaths } from "./durable-extensions.ts";
import {
	createSharedHostResidency,
	type SharedHostResidency,
	type SharedHostResidencyOptions,
} from "./shared-host-residency.ts";

/** Stable logical identity for the seat-wide shared host (serverId). */
export const DEFAULT_SHARED_HOST_SERVER_ID = "9f47c2a1-5b30-4e66-8a41-2c9d55e07f10";

/** Valid shared session ids: filesystem-safe, no traversal. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const FORCED_EXIT_MS = 10_000;

function sessionSummary(serverId: string, sessionId: string): SessionSummary {
	return { serverId: serverId as SessionSummary["serverId"], sessionId, createdAt: 0 };
}

function ownedByEuid(stats: StatsBase<number>): boolean {
	return process.getuid !== undefined && stats.uid === process.getuid();
}

/** Absolute path of the default unix socket for the shared host. */
export function defaultSharedHostSocketPath(runtimeDir: string = process.env.XDG_RUNTIME_DIR ?? ""): string {
	if (runtimeDir.length === 0) {
		throw new Error("XDG_RUNTIME_DIR is not set; pass --socket explicitly");
	}
	return join(runtimeDir, "pi-shared-host", "pi-shared-host.sock");
}

/** Absolute path of the default session root (per-seat agent dir). */
export function defaultSharedHostRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "shared-host");
}

export interface SharedHostDaemonOptions {
	readonly socket?: string;
	readonly root?: string;
	readonly serverId?: string;
	/** Hard cap on concurrently hosted session engines (refuse, never queue). */
	readonly maxSessions?: number;
	/** Application-owned model runtime; defaults to the seat's own wiring. */
	readonly modelRuntime?: SharedHostResidencyOptions["hydrate"]["modelRuntime"];
}

export interface FauxSharedHostDaemonOptions extends SharedHostDaemonOptions {
	/**
	 * TEST-ONLY scripted steps prepended to the faux queue (tool round-trips).
	 * The faux wiring itself never serves real seats.
	 */
	readonly scriptedSteps?: readonly (FauxResponseStep | FauxResponseFactory)[];
}

/**
 * Filesystem security gate (the documented substitute for per-peer
 * SO_PEERCRED on this transport): the socket directory must be 0700 and
 * owned by the daemon euid, and the socket 0600 in the same ownership.
 * Anything else refuses to serve.
 */
function assertFilesystemBoundary(socketPath: string): void {
	const directory = lstatSync(dirname(socketPath));
	if (!ownedByEuid(directory) || (directory.mode & 0o077) !== 0) {
		throw new Error(
			`Shared-host socket directory must be 0700 and owned by uid ${process.getuid?.() ?? "?"}: ${dirname(socketPath)}`,
		);
	}
	const socket = lstatSync(socketPath);
	if (!socket.isSocket()) throw new Error(`Shared host path is not a socket: ${socketPath}`);
	if (!ownedByEuid(socket) || (socket.mode & 0o077) !== 0) {
		throw new Error(`Shared-host socket must be 0600 and owned by uid ${process.getuid?.() ?? "?"}: ${socketPath}`);
	}
}

export interface SharedHostDaemon extends SharedHostResidency {
	readonly serverId: string;
	readonly socket: string;
	readonly root: string;
}

/**
 * Compose and START the daemon listener. Resolves once the socket is
 * bound, verified against the filesystem boundary, and the server accepts.
 */
export async function createSharedHostDaemon(options: SharedHostDaemonOptions = {}): Promise<SharedHostDaemon> {
	const socket = options.socket ?? defaultSharedHostSocketPath();
	const root = resolve(options.root ?? defaultSharedHostRoot());
	const serverId = options.serverId ?? DEFAULT_SHARED_HOST_SERVER_ID;
	const maxSessions = options.maxSessions ?? 8;
	if (!isAbsolute(root)) throw new Error(`Shared-host root must be absolute: ${root}`);
	mkdirSync(root, { recursive: true, mode: 0o700 });

	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());

	const residency = await createSharedHostResidency({
		policy: { maxSessions },
		hydrate: { root, modelRuntime },
	});

	const services = await createExperimentalServerServices({
		list: async () => {
			const summaries: SessionSummary[] = [];
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name)) {
					summaries.push(sessionSummary(serverId, entry.name));
				}
			}
			return summaries.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
		},
		create: async (createOptions) => {
			const id = createOptions.id ?? randomUUID();
			if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Invalid shared session id: ${id}`);
			mkdirSync(join(root, id), { recursive: true, mode: 0o700 });
			return { serverId: serverId as SessionSummary["serverId"], sessionId: id, createdAt: Date.now() };
		},
		remove: async (sessionId) => {
			throw new Error(
				`Shared-host daemon does not delete sessions (${sessionId}); remove the durable root manually`,
			);
		},
		prepareSessionPlugins: async () => {
			throw new Error("Shared-host daemon hosts no session plugins");
		},
		reloadPresentationPlugins: async () => {
			throw new Error("Shared-host daemon hosts no session plugins");
		},
	});

	const server = createUnixServer(
		{
			serverServices: services.host,
			async resolveSession(sessionId) {
				if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid shared session id: ${sessionId}`);
				return { id: sessionId };
			},
			openSession: (metadata, context) => residency.runtime.host.openSession(metadata, context),
		},
		{ path: socket, serverId, mode: 0o600 },
	);

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		try {
			await server.close();
		} finally {
			try {
				await services.dispose();
			} finally {
				await residency.close();
			}
		}
	};

	await server.start();
	assertFilesystemBoundary(socket);
	return Object.assign(residency, { serverId, socket, root, close });
}

/**
 * TEST-ONLY daemon composition with the faux provider and a bounded
 * scripted response queue (see module docs). The queue re-seeds on every
 * daemon start; echo steps read only the ACTUAL request transcript, so
 * restarts stay deterministic.
 */
export async function createFauxSharedHostDaemon(options: FauxSharedHostDaemonOptions = {}): Promise<SharedHostDaemon> {
	const models = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 8, max: 16 } });
	models.registerNativeProvider(faux.provider);
	await models.refresh({ allowNetwork: false });
	// Bounded scripted queue: scripted steps first (e.g. one tool round-trip),
	// then echo steps. Echo steps answer from the ACTUAL request transcript,
	// never from stored state, so restarts stay deterministic.
	const echo: FauxResponseFactory = (context) => {
		const last = [...context.messages].findLast((message) => message.role === "user");
		// UserMessage.content is `string | (TextContent | ImageContent)[]`; assuming
		// the array form threw here ("flatMap is not a function"), failed the turn,
		// and surfaced as the "No answer: model_error" notice.
		const content = last?.content ?? "";
		const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
		const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
		return fauxAssistantMessage([fauxText(`daemon-echo: ${text}`)]);
	};
	const scripted = [...(options.scriptedSteps ?? [])];
	faux.setResponses([...scripted, ...Array.from({ length: 16 }, () => echo)]);
	const daemon = await createSharedHostDaemon({ ...options, modelRuntime: models });
	return daemon;
}

/** Entry wiring: parse flags, start, install signal-clean shutdown. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	let socket = defaultSharedHostSocketPath();
	let root = defaultSharedHostRoot();
	let maxSessions = 8;
	let faux = false;
	// Fleet extension parity: repeatable --extension paths are forwarded to the
	// durable extension host (agentDir/extensions is discovered regardless).
	const extensionPaths: string[] = [];
	// TEST-ONLY: seed the faux queue with one real read-tool round-trip against
	// this file (engine executes the read tool; the echo step reports it).
	let scriptedRead: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--socket") socket = argv[++index] ?? socket;
		else if (flag === "--root") root = argv[++index] ?? root;
		else if (flag === "--max-sessions") maxSessions = Number(argv[++index] ?? maxSessions);
		else if (flag === "--faux") faux = true;
		else if (flag === "--extension") extensionPaths.push(argv[++index] ?? "");
		else if (flag === "--scripted-read") scriptedRead = argv[++index];
		else throw new Error(`Unknown shared-host-daemon flag: ${flag}`);
	}
	if (extensionPaths.some((path) => path.length === 0)) throw new Error("--extension requires a path");
	if (extensionPaths.length > 0) configureDurableExtensionPaths(extensionPaths);
	if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("--max-sessions must be a positive integer");
	if (scriptedRead !== undefined && !faux) throw new Error("--scripted-read requires --faux (test-only wiring)");
	const scriptedSteps = scriptedRead
		? [
				fauxAssistantMessage([fauxToolCall("read", { path: scriptedRead }, { id: "daemon-scripted-read" })], {
					stopReason: "toolUse",
				}),
				(context: TranscriptContext) => {
					const toolResult = [...context.messages].findLast((message) => message.role === "toolResult");
					const resultText =
						toolResult?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ?? "";
					return fauxAssistantMessage([fauxText(`daemon-tool-result: ${resultText}`)]);
				},
			]
		: [];
	const daemon = await (faux ? createFauxSharedHostDaemon : createSharedHostDaemon)({
		socket,
		root,
		maxSessions,
		...(faux ? { scriptedSteps } : {}),
	});
	process.stdout.write(
		`shared-host-daemon ready pid=${process.pid} socket=${daemon.socket} root=${daemon.root} serverId=${daemon.serverId}\n`,
	);
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		// Stop accepting immediately (server.close closes listeners first),
		// then drain: engines release their exclusive durable writers in order.
		setTimeout(() => process.exit(1), FORCED_EXIT_MS).unref();
		daemon
			.close()
			.then(() => process.exit(0))
			.catch(() => process.exit(3));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

function invokedDirectly(): boolean {
	const entry = process.argv[1];
	if (entry === undefined || !existsSync(entry)) return false;
	return fileURLToPath(import.meta.url) === resolve(entry);
}

if (invokedDirectly()) {
	void main().catch((error: unknown) => {
		process.stderr.write(`shared-host-daemon failed: ${String(error)}\n`);
		process.exit(1);
	});
}
