import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { takeCoverage } from "node:v8";
import lockfile from "proper-lockfile";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from "msqa/ai";
import { getCapabilities, getCellDimensions, getKeybindings, isKittyProtocolActive, setCapabilities,
	setCellDimensions, setKeybindings, setKittyProtocolActive, TerminalContext,
	KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "msqa/tui";
import { AuthStorage } from "msqa/auth";
import { ModelRuntime } from "msqa/models";
import { createSharedTtyHost } from "msqa/host";
import { initTheme, setTerminalColorScheme, theme } from "msqa/theme";

const evidence = process.env.MSQA_DATA;
const sockets = process.env.MSQA_SOCKET_ROOT;
assert(evidence && sockets);
const log = (name, record) => appendFileSync(join(evidence, `${name}.jsonl`), `${JSON.stringify(record)}\n`);
// Reuse existing T5 heterogeneous TerminalContext assertions, including real
// async propagation rather than replacing the terminal implementation.
const a = new TerminalContext({ TERM: "xterm-256color" });
const b = new TerminalContext({ TERM: "xterm-direct", COLORTERM: "truecolor" });
for (const [surface, kitty, image, cell, name, key] of [[a, true, "kitty", 8, "dark", "tab"], [b, false, null, 10, "light", "enter"]]) {
	surface.run(() => {
		setKittyProtocolActive(kitty); setCapabilities({ images: image, trueColor: kitty, hyperlinks: kitty });
		setCellDimensions({ widthPx: cell, heightPx: cell * 2 });
		setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": key }));
		initTheme(name); setTerminalColorScheme(name);
	});
}
await Promise.all([a.run(async () => {
	await Promise.resolve(); assert.equal(isKittyProtocolActive(), true); assert.equal(getCapabilities().images, "kitty");
	assert.equal(getCellDimensions().widthPx, 8); assert(getKeybindings().matches("\t", "tui.input.submit")); assert.equal(theme.name, "dark");
}), b.run(async () => {
	await Promise.resolve(); assert.equal(isKittyProtocolActive(), false); assert.equal(getCapabilities().images, null);
	assert.equal(getCellDimensions().widthPx, 10); assert(getKeybindings().matches("\r", "tui.input.submit")); assert.equal(theme.name, "light");
})]);
log("checks", { check: "actual-terminal-context-async-isolation", passed: true });
const requests = new Map();
const response = (request, options) => {
	const user = request.messages.findLast((message) => message.role === "user");
	const text = typeof user?.content === "string" ? user.content : user?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert(text && /QA[AB]/.test(text), "Actual model request must carry own user marker");
	const id = text.includes("QAA") ? "pane-one" : "pane-two";
	const own = id === "pane-one" ? "QAA" : "QAB";
	const foreign = own === "QAA" ? "QAB" : "QAA";
	assert(!JSON.stringify(request.messages).includes(foreign), "Foreign native history in actual faux request");
	requests.set(id, request.messages);
	log("requests", { id, marker: own, text, messages: request.messages, sessionId: options?.sessionId });
	if (text.includes("tool-proof") && request.messages.at(-1)?.role !== "toolResult") {
		return fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'one-effect\\n' >> tool-proof.txt; printf 'native-tool-result'" }), { stopReason: "toolUse" });
	}
	if (text.includes("cancel-proof")) {
		options?.signal?.addEventListener("abort", () => log("checks", { check: "native-provider-abort-signal", passed: true, id }), { once: true });
		return fauxAssistantMessage(`${own} STREAM_START ${"streaming-ongoing ".repeat(1000)} STREAM_END`);
	}
	// Native progress.partialIntervalMs defaults to 100ms. Keep this response
	// live across that actual throttle so a pre-final rich frame is observable.
	return fauxAssistantMessage(`${own} STREAM_START first-part ${"steady-delta ".repeat(96)} middle-part last-part STREAM_END`);
};
const faux = fauxProvider({ provider: "msqa-native", tokensPerSecond: 400, tokenSize: { min: 1, max: 1 } });
faux.setResponses(Array.from({ length: 20 }, () => response));
const models = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsStore: new InMemoryModelsStore(),
	modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
models.registerNativeProvider(faux.provider);
await models.refresh({ allowNetwork: false });
const states = new Map();
const terminalReads = new Map();
const host = await createSharedTtyHost({ controlSocket: join(sockets, "tty.sock"), sessionSocket: join(sockets, "session.sock"),
	sessions: ["pane-one", "pane-two"], policy: { maxSessions: 2 },
	hydrate: { root: join(evidence, "sessions"), modelRuntime: models,
		onState(id, state) {
			states.set(id, state);
			log("residency", { id, released: state.released, resumed: state.resumed, live: state.live, openedRetained: state.openedRetained });
		} },
	model: { provider: faux.provider.id, modelId: faux.getModel().id }, onSurface(event) {
		log("events", event);
		if (event.type === "ready") {
			terminalReads.set(event.tty, AsyncResource.bind(() => ({ sessionId: event.sessionId,
				kitty: isKittyProtocolActive(), capabilities: getCapabilities(), cell: getCellDimensions(), theme: theme.name })));
		} else if (event.type === "closed") terminalReads.delete(event.tty);
	},
});
const commands = createServer((socket) => {
	let buffered = "";
	socket.on("data", async (chunk) => {
		buffered += chunk.toString();
		if (!buffered.includes("\n")) return;
		const command = JSON.parse(buffered.split("\n")[0]);
		try {
			if (command.action === "coverage") {
				assert(process.env.NODE_V8_COVERAGE, "Coverage collection not explicitly admitted");
				takeCoverage();
				socket.end('{"ok":true}\n');
			} else if (command.action === "terminals") {
				socket.end(`${JSON.stringify({ ok: true, terminals: [...terminalReads].map(([tty, read]) => ({ tty, ...read() })) })}\n`);
			} else if (command.action === "snapshot") {
				const result = {};
				for (const [id, state] of states) {
					const opened = state.openedRef?.deref();
					result[id] = opened ? opened.view.current() : { parked: true };
				}
				socket.end(`${JSON.stringify({ ok: true, views: result, identities: host.runtime.control.identities() })}\n`);
			} else if (command.action === "writer") {
				const resident = JSON.parse(readFileSync(join(evidence, "sessions", "pane-one.resident.json"), "utf8"));
				assert(await lockfile.check(resident.directory, { realpath: false }), "Actual native writer lock is held");
				await assert.rejects(lockfile.lock(resident.directory, { realpath: false, retries: 0 }), /already being held|ELOCKED|locked/i);
				log("checks", { check: "actual-native-second-writer-refused", passed: true, directory: resident.directory });
				socket.end('{"ok":true}\n');
			} else if (command.action === "park") {
				socket.end(`${JSON.stringify({ ok: true, outcome: await host.parkWhenQuiescent(command.id) })}\n`);
			} else throw new Error("Unknown QA command");
		} catch (error) { socket.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`); }
	});
});
await new Promise((resolve) => commands.listen(join(sockets, "qa.sock"), resolve));
writeFileSync(join(evidence, "ready.json"), JSON.stringify({ hostPid: process.pid, sourceMode: !process.env.MSQA_ARTIFACT_RECEIPT }));
await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
await new Promise((resolve) => commands.close(resolve));
await host.close();
assert.equal(host.runtime.control.identities().length, 0);
log("checks", { check: "native-host-normal-teardown", passed: true });
