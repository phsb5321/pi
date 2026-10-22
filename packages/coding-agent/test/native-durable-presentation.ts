/** Network-free native SDK/Unix transport/TUI regression. Faux provider is NOT served production. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { attachSession, Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { LiveState } from "@earendil-works/pi-durable";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createSharedDurableUnixHost } from "../src/experimental/durable/presentation-host.ts";
import { openDurablePresentation } from "../src/experimental/durable/presentation-service.ts";
import { DurableTui } from "../src/experimental/durable/tui.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const root = mkdtempSync(join(tmpdir(), "native-thin-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const models = await ModelRuntime.create({
	credentials: AuthStorage.inMemory(),
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
models.registerNativeProvider(faux.provider);
await models.refresh({ allowNetwork: false });
const siblingModels = await ModelRuntime.create({
	credentials: AuthStorage.inMemory(),
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
const siblingFaux = fauxProvider();
siblingModels.registerNativeProvider(siblingFaux.provider);
await siblingModels.refresh({ allowNetwork: false });
const released: WeakRef<object>[] = [];
const ids = new Set(["a", "b"]);
const serverId = "00000000-0000-4000-8000-000000001910";
const socket = join(root, "host.sock");
const host = await createSharedDurableUnixHost({
	socket,
	serverId,
	sessions: [...ids],
	policy: { maxSessions: 2 },
	hydrate: {
		root,
		modelRuntime: ({ id }) => (id === "a" ? models : siblingModels),
		onState(_id, state) {
			if (!state.openedRetained && state.openedRef) released.push(state.openedRef);
		},
	},
});
const clients: Client[] = [];
const presentations: Awaited<ReturnType<typeof openDurablePresentation>>[] = [];
const screens: DurableTui[] = [];
const terminals: VirtualTerminal[] = [];
const unsubs: (() => void)[] = [];
let checks = 0;
function check(label: string, value: boolean) {
	assert.equal(value, true, label);
	console.log(`PASS ${label}`);
	checks++;
}
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
const live = (i: number) => presentations[i]!.view.current().conversation.docs["pi.live"] as LiveState | undefined;
const text = (i: number) => JSON.stringify(presentations[i]!.view.current().conversation.entries);
const record = (id: string) => readFileSync(join(root, `${id}.resident.json`), "utf8");
try {
	initTheme();
	for (const id of ids) {
		const client = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path: socket }) });
		clients.push(client);
		const attachment = await attachSession(client, id);
		const presentation = await openDurablePresentation(attachment.transport);
		presentations.push(presentation);
		await presentation.controller.setModel({ provider: "faux", modelId: "faux-1" });
		const terminal = new VirtualTerminal(100, 38);
		terminals.push(terminal);
		const screen = new DurableTui(
			presentation.view.current().session.cwd,
			{
				submit: (value) => void presentation.controller.submit(value, "steer"),
				followUp: (value) => void presentation.controller.submit(value, "followUp"),
				abort: () => void presentation.controller.abort(),
				exit: () => {},
				selectModel: () => {},
				cycleThinking: () => {},
			},
			terminal,
		);
		screens.push(screen);
		unsubs.push(presentation.view.subscribe(() => screen.apply(presentation.view.current())));
		screen.start();
		screen.apply(presentation.view.current());
	}
	check(
		"two native Unix attachments share one SDK process",
		host.runtime.control.identities().length === 2 &&
			host.runtime.control.identities().every((id) => id.pid === process.pid),
	);
	check(
		"private session directories differ",
		presentations[0]!.view.current().session.directory !== presentations[1]!.view.current().session.directory,
	);
	faux.setResponses([fauxAssistantMessage([fauxText("native-stream-visible ".repeat(16))])]);
	terminals[0]!.sendInput("a-input");
	terminals[0]!.sendInput("\r");
	await waitFor(
		() => JSON.stringify(live(0)?.generation?.message ?? null).includes("native-stream-visible"),
		"native partial over subscribed Unix transport",
	);
	await waitFor(
		async () =>
			(await terminals[0]!.flushAndGetViewport()).join("\n").includes("native-stream-visible") &&
			live(0)?.run !== undefined,
		"rendered native partial before settlement",
	);
	check(
		"existing TUI paints subscribed partial before settlement",
		(await terminals[0]!.flushAndGetViewport()).join("\n").includes("native-stream-visible") &&
			live(0)?.run !== undefined,
	);
	await waitFor(
		() => live(0)?.run === undefined && text(0).includes("native-stream-visible"),
		"native stream settlement",
	);
	check(
		"sibling view does not receive A transcript",
		!text(1).includes("a-input") && !text(1).includes("native-stream-visible"),
	);
	const path = join(root, "a", "native-tool.txt");
	writeFileSync(path, "native-tool-visible\n");
	faux.appendResponses([
		fauxAssistantMessage([fauxToolCall("read", { path }, { id: "native-read" })], { stopReason: "toolUse" }),
		(request) => {
			assert.ok(
				request.messages.some(
					(m) =>
						m.role === "toolResult" && !m.isError && JSON.stringify(m.content).includes("native-tool-visible"),
				),
			);
			return fauxAssistantMessage("native-tool-answer");
		},
	]);
	await presentations[0]!.controller.submit("native-tool-input", "steer");
	await waitFor(
		() => live(0)?.run === undefined && text(0).includes("native-tool-answer"),
		"registered native tool completion",
	);
	check(
		"native tool/result crosses typed subscription",
		presentations[0]!.view
			.current()
			.conversation.entries.some(
				(e) => e.kind === "pi.tool-result" && JSON.stringify(e.model).includes("native-tool-visible"),
			),
	);
	const entered = Promise.withResolvers<void>();
	let aborted = false;
	faux.appendResponses([
		async (_request, options) => {
			entered.resolve();
			await new Promise<void>((_resolve, reject) =>
				options!.signal!.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(options!.signal!.reason);
					},
					{ once: true },
				),
			);
			return fauxAssistantMessage("must-not-complete");
		},
	]);
	await presentations[0]!.controller.submit("cancel-native-task", "steer");
	await entered.promise;
	const siblingEntered = Promise.withResolvers<void>();
	const siblingRelease = Promise.withResolvers<void>();
	let siblingAborted = false;
	siblingFaux.appendResponses([
		async (request, options) => {
			assert.ok(!JSON.stringify(request.messages).includes("native-tool-input"));
			options?.signal?.addEventListener(
				"abort",
				() => {
					siblingAborted = true;
				},
				{ once: true },
			);
			siblingEntered.resolve();
			await siblingRelease.promise;
			return fauxAssistantMessage("native-sibling-completed");
		},
	]);
	await presentations[1]!.controller.submit("sibling-private-input", "steer");
	await siblingEntered.promise;
	const aTarget = clients[0]!.attachment!;
	await assert.rejects(() =>
		clients[1]!.request(aTarget, { serviceId: "pi.durable-presentation", member: "abort", args: [] }),
	);
	check("foreign presentation cannot invoke A attachment", !aborted && live(0)?.run !== undefined);
	terminals[0]!.sendInput("\x1b");
	await waitFor(() => aborted && live(0)?.run === undefined, "editor Escape aborts actual native task");
	check(
		"editor cancellation reaches actual task, not presentation marker",
		aborted && !text(0).includes("must-not-complete") && !siblingAborted && live(1)?.run !== undefined,
	);
	const siblingSurvivedAbort = !siblingAborted && live(1)?.run !== undefined;
	siblingRelease.resolve();
	await waitFor(
		() => live(1)?.run === undefined && text(1).includes("native-sibling-completed"),
		"native sibling completion",
	);
	check(
		"isolated sibling provider completes after A-only abort",
		siblingSurvivedAbort && !text(0).includes("sibling-private-input"),
	);
	const binding = record("a");
	const oldTarget = clients[0]!.attachment!;
	await presentations[0]!.close();
	await clients[0]!.request({ serverId }, { serviceId: "pi.session-management", member: "detach", args: [] });
	await assert.rejects(() =>
		clients[0]!.request(oldTarget, { serviceId: "pi.durable-presentation", member: "abort", args: [] }),
	);
	check("stale presentation attachment rejected", true);
	check("detached native session parks", (await host.parkWhenQuiescent("a")) === "parked");
	assert.ok(globalThis.gc, "run with --expose-gc");
	let reclaimed = false;
	for (let n = 0; n < 20 && !reclaimed; n++) {
		await new Promise((resolve) => setImmediate(resolve));
		globalThis.gc();
		reclaimed = released.length === 1 && released[0]!.deref() === undefined;
	}
	check("released typed native presentation does not retain parked SDK graph", reclaimed);
	const reopened = await attachSession(clients[0]!, "a");
	presentations[0] = await openDurablePresentation(reopened.transport);
	check(
		"reopen retains actual native storage binding and history",
		record("a") === binding && text(0).includes("native-tool-answer"),
	);
	await assert.rejects(() => attachSession(clients[1]!, "foreign-private-id"));
	check("unknown private session not created", host.runtime.control.identities().length === 2);
	await assert.rejects(() => presentations[0]!.controller.switchConversation(-1 as never));
	check("invalid native conversation rejected", true);
} finally {
	for (const unsub of unsubs) unsub();
	for (const screen of screens) screen.stop();
	await Promise.allSettled(presentations.map((p) => p.close()));
	await Promise.allSettled(clients.map((c) => c.dispose()));
	await host.close();
	rmSync(root, { recursive: true, force: true });
}
check("native shutdown releases every session", host.runtime.control.identities().length === 0);
console.log(
	`NATIVE-THIN: ${checks} PASS; SDK+Unix+rendered-xterm test; faux provider, no production serve, RAM ratio UNPROVEN`,
);
