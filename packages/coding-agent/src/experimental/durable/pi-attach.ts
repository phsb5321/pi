#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
/**
 * pi-attach — EXPERIMENTAL seat CLI for the shared-host daemon.
 *
 * Attaches a native durable TUI to a session hosted by
 * `shared-host-daemon` over its unix socket through the existing thin leg
 * (`runSharedDurableTui`: real pi-client connect → attach → durable
 * presentation → runDurableTui). This file is a separate entry; the `pi`
 * CLI default path is unchanged.
 *
 *   pi-attach --socket <path> --session <id|new> [--cwd <dir>]
 *
 * Exit codes: 0 normal detach; 2 usage error; 3 connect/attach failure
 * (e.g. daemon absent — fails fast with the transport's connect error, no
 * hang).
 */
import { parseArgs } from "node:util";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { runSharedDurableTui } from "./presentation-client.ts";
import { DEFAULT_SHARED_HOST_SERVER_ID, defaultSharedHostSocketPath } from "./shared-host-daemon.ts";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function usage(error?: string): never {
	if (error !== undefined) process.stderr.write(`pi-attach: ${error}\n`);
	process.stderr.write("usage: pi-attach --socket <path> --session <id|new> [--cwd <dir>] [--server-id <uuidv4>]\n");
	process.exit(error === undefined ? 0 : 2);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			socket: { type: "string" },
			session: { type: "string" },
			cwd: { type: "string" },
			"server-id": { type: "string" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) usage();
	const socket = values.socket ?? defaultSharedHostSocketPath();
	const serverId = values["server-id"] ?? DEFAULT_SHARED_HOST_SERVER_ID;
	let sessionId = values.session;
	if (sessionId === undefined || sessionId.length === 0) usage("--session <id|new> is required");
	if (sessionId === "new") sessionId = crypto.randomUUID();
	if (!SESSION_ID_PATTERN.test(sessionId)) usage(`invalid session id: ${sessionId}`);
	const cwd = values.cwd ?? process.cwd();
	if (!existsSync(cwd)) usage(`--cwd does not exist: ${cwd}`);
	mkdirSync(cwd, { recursive: true });

	const settings = SettingsManager.create(cwd, getAgentDir());
	await runSharedDurableTui({ socket, serverId, sessionId, settings });
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`pi-attach: ${message}\n`);
	process.exit(3);
});
