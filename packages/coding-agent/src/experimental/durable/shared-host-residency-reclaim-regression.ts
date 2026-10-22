/**
 * Pi #8/#9 native shared-host regression. Uses production residency and the
 * application's faux ModelRuntime: real streaming, registered read tools,
 * native cancellation, isolated SQLite history, awaited park/reopen and GC.
 * No real provider calls or RAM ratio claim. Optional argv[2] emits four
 * SQLite backups plus copied production ResidentRecords for the history reader.
 * Run: node --expose-gc --experimental-strip-types <this-file> [packet-directory]
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { LiveState, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { InProcessSessionAttachment } from "@earendil-works/pi-server";
import { AuthStorage } from "../../core/auth-storage.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import type { OpenDurableResult } from "./runtime.ts";
import { createSharedHostResidency, type ResidentRecord } from "./shared-host-residency.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "sdk-native-reclaim-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const packetDir = resolve(process.argv[2] ?? join(root, "packet"));
mkdirSync(packetDir, { recursive: true });
let checks = 0;
function check(label: string, value: boolean): void {
	assert.equal(value, true, label);
	checks++;
	console.log(`PASS ${label}`);
}
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((done) => setTimeout(done, 10));
	}
}

const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
const models = await ModelRuntime.create({
	credentials: AuthStorage.inMemory(),
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
models.registerNativeProvider(faux.provider);
await models.refresh({ allowNetwork: false });
const refs = new Map<string, WeakRef<OpenDurableResult>>();
const unsubs = new Map<string, () => void>();
const released: Array<WeakRef<object>> = [];
const frames = new Map<string, number>();
const host = await createSharedHostResidency({
	policy: { maxSessions: 2 },
	hydrate: {
		root,
		modelRuntime: models,
		onState(id, state) {
			if (!state.openedRetained) {
				unsubs.get(id)?.();
				unsubs.delete(id);
				if (state.openedRef) released.push(state.openedRef);
				return;
			}
			assert.ok(state.openedRef);
			const ref = state.openedRef as WeakRef<OpenDurableResult>;
			refs.set(id, ref);
			const opened = ref.deref();
			assert.ok(opened);
			unsubs.set(
				id,
				opened.view.subscribe(() => frames.set(id, (frames.get(id) ?? 0) + 1)),
			);
		},
	},
});
const markers = {
	a: { history: "a-history-native-1754", resume: "a-resume-native-1754" },
	b: { history: "b-history-native-1754", resume: "b-resume-native-1754" },
};
type Lane = keyof typeof markers;
const ids = { a: "native-a", b: "native-b" };
const views = (lane: Lane) => {
	const opened = refs.get(ids[lane])?.deref();
	assert.ok(opened, `missing live engine ${lane}`);
	return opened.view.current();
};
const live = (lane: Lane) => views(lane).conversation.docs["pi.live"] as LiveState | undefined;
const idle = (lane: Lane) => live(lane)?.run === undefined;
const invoke = (attachment: InProcessSessionAttachment, member: string, args: string[] = []) =>
	attachment.invokeService({ serviceId: "pi.durable", member, args }, async () => {}, context);
const handles = {
	a: await host.runtime.host.openSession({ id: ids.a }, context),
	b: await host.runtime.host.openSession({ id: ids.b }, context),
};
let a = await handles.a.attachClient(context);
let b = await handles.b.attachClient(context);
function round(lane: Lane, phase: "history" | "resume"): FauxResponseStep[] {
	const marker = markers[lane][phase];
	const path = join(root, ids[lane], `${marker}.txt`);
	writeFileSync(path, `${marker}\n`);
	return [
		fauxAssistantMessage([fauxToolCall("read", { path }, { id: `${lane}-${phase}-call` })], {
			stopReason: "toolUse",
		}),
		(request) => {
			const result = request.messages.findLast((message) => message.role === "toolResult");
			assert.ok(result?.role === "toolResult");
			assert.equal(result.isError, false);
			const resultText = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
			assert.ok(resultText.includes(marker), "actual tool output missing");
			// Recall is computed from the ACTUAL model request, never canned.
			const old = request.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])))
				.join(" ")
				.match(/[ab]-history-native-1754/)?.[0];
			if (phase === "resume") assert.equal(old, markers[lane].history, "native request lost old history");
			return fauxAssistantMessage([fauxText(`answer ${resultText.trim()} ${old ?? ""}`)]);
		},
	];
}
const binding = (lane: Lane): ResidentRecord =>
	JSON.parse(readFileSync(join(root, `${ids[lane]}.resident.json`), "utf8"));
async function snapshot(lane: Lane, phase: "before" | "after") {
	const record = binding(lane);
	const database = `${phase}-${lane}.sqlite`;
	const resident = `${phase}-${lane}.resident.json`;
	const source = new DatabaseSync(join(record.directory, "session.sqlite"), { readOnly: true });
	try {
		await backup(source, join(packetDir, database));
	} finally {
		source.close();
	}
	copyFileSync(join(root, `${ids[lane]}.resident.json`), join(packetDir, resident));
	return { database, resident };
}
const activeTasks = {} as Record<Lane, TaskId>;
try {
	const second = await handles.a.attachClient(context);
	check("two real presentations registered", host.core.state(host.runtime.control).presentations.get(ids.a) === 2);
	check("attached session refuses park", (await host.parkWhenQuiescent(ids.a)) === "refused-not-quiescent");
	await second.release(context);
	check("real release decrements presentations", host.core.state(host.runtime.control).presentations.get(ids.a) === 1);

	faux.setResponses([fauxAssistantMessage([fauxText("streaming production view ".repeat(32))])]);
	// Use the public service's actual ModelRef argument rather than a string.
	await a.invokeService(
		{ serviceId: "pi.durable", member: "setModel", args: [{ provider: "faux", modelId: "faux-1" }] },
		async () => {},
		context,
	);
	await b.invokeService(
		{ serviceId: "pi.durable", member: "setModel", args: [{ provider: "faux", modelId: "faux-1" }] },
		async () => {},
		context,
	);
	const beforeFrames = frames.get(ids.a) ?? 0;
	await invoke(a, "submit", ["stream through native SDK"]);
	await waitFor(() => {
		const partial = live("a")?.generation?.message;
		return partial !== undefined && (frames.get(ids.a) ?? 0) > beforeFrames + 1;
	}, "delivered native streaming partials");
	check("native view delivers partial frames while turn remains active", !idle("a"));
	await waitFor(() => idle("a"), "stream settlement");

	for (const lane of ["a", "b"] as const) {
		faux.appendResponses(round(lane, "history"));
		await invoke(lane === "a" ? a : b, "submit", [markers[lane].history]);
		await waitFor(
			() =>
				idle(lane) &&
				views(lane).conversation.entries.some(
					(entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes(markers[lane].history),
				),
			`history ${lane}`,
		);
		check(
			`real native tool result ${lane}`,
			views(lane).conversation.entries.some(
				(entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.model).includes(markers[lane].history),
			),
		);
	}

	const holdA = Promise.withResolvers<void>();
	const holdB = Promise.withResolvers<void>();
	let readyA = false;
	let readyB = false;
	let sawAbort = false;
	faux.appendResponses([
		async (_request, options) => {
			readyA = true;
			const signal = options?.signal;
			assert.ok(signal);
			await Promise.race([
				holdA.promise,
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							sawAbort = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
			]);
			return fauxAssistantMessage("must-not-answer");
		},
	]);
	await invoke(a, "submit", ["cancel active native turn"]);
	await waitFor(() => readyA, "A entered native provider");
	faux.appendResponses([
		async () => {
			readyB = true;
			await holdB.promise;
			return fauxAssistantMessage("sibling completed");
		},
	]);
	await invoke(b, "submit", ["complete sibling native turn"]);
	await waitFor(() => readyB, "B entered native provider");
	for (const lane of ["a", "b"] as const) {
		const task = live(lane)?.run?.taskId;
		assert.ok(task);
		activeTasks[lane] = task;
	}
	const before = { a: await snapshot("a", "before"), b: await snapshot("b", "before") };
	await a.release(context);
	check(
		"zero presentations still refuses an ACTIVE native turn",
		(await host.parkWhenQuiescent(ids.a)) === "refused-active-work",
	);
	a = await handles.a.attachClient(context);
	await invoke(a, "abort");
	check("native abort reaches provider and settles only A", sawAbort && idle("a") && !idle("b"));
	holdB.resolve();
	await waitFor(() => idle("b"), "sibling completion");

	const oldBindings = { a: binding("a"), b: binding("b") };
	await a.release(context);
	await b.release(context);
	for (const lane of ["a", "b"] as const)
		check(`awaited native park ${lane}`, (await host.parkWhenQuiescent(ids[lane])) === "parked");
	assert.ok(globalThis.gc, "run with --expose-gc");
	let reclaimed = false;
	for (let n = 0; n < 20 && !reclaimed; n++) {
		await new Promise((done) => setImmediate(done));
		globalThis.gc();
		reclaimed = released.length === 2 && released.every((ref) => ref.deref() === undefined);
	}
	check("both parked native engine graphs are garbage collected", reclaimed);
	a = await handles.a.attachClient(context);
	b = await handles.b.attachClient(context);
	for (const lane of ["a", "b"] as const) {
		check(
			`native resident identity unchanged after reopen ${lane}`,
			JSON.stringify(binding(lane)) === JSON.stringify(oldBindings[lane]),
		);
		faux.appendResponses(round(lane, "resume"));
		await invoke(lane === "a" ? a : b, "submit", [markers[lane].resume]);
		await waitFor(
			() =>
				idle(lane) &&
				views(lane).conversation.entries.some(
					(entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes(markers[lane].resume),
				),
			`resume ${lane}`,
		);
		check(
			`answered continuation recalls actual request history ${lane}`,
			views(lane).conversation.entries.some(
				(entry) =>
					entry.kind === "pi.assistant" &&
					JSON.stringify(entry.model).includes(markers[lane].resume) &&
					JSON.stringify(entry.model).includes(markers[lane].history),
			),
		);
	}
	const after = { a: await snapshot("a", "after"), b: await snapshot("b", "after") };
	for (const lane of ["a", "b"] as const) {
		const storage = await openNodeSqliteStorage(join(packetDir, before[lane].database));
		try {
			check(
				`before backup captured RUNNING native task ${lane}`,
				(await storage.task(activeTasks[lane], context))?.state.status === "running",
			);
		} finally {
			await storage.close(context);
		}
	}
	writeFileSync(
		join(packetDir, "packet.json"),
		`${JSON.stringify({ before, after, markers, active_tasks: activeTasks }, null, 2)}\n`,
	);
	check(
		"one process hosts both actual SDK engines",
		host.runtime.control.identities().every((identity) => identity.pid === process.pid) &&
			host.runtime.control.identities().length === 2,
	);
} finally {
	for (const unsub of unsubs.values()) unsub();
	unsubs.clear();
	await host.close();
}
check("shutdown drops runtime identities", host.runtime.control.identities().length === 0);
await host.close();
console.log(`RESIDENCY-RECLAIM: ${checks} PASS; packet=${join(packetDir, "packet.json")}; RAM/live UNPROVEN`);
