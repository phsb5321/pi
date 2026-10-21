import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	createServiceSubscribeCall, createServiceUnsubscribeCall, createServiceStateDecoder,
	parseWireServiceSubscriptionSnapshot, parseWireServiceProviderUpdate,
} from "msqa/chord";
import { BACKGROUND_CONTEXT } from "msqa/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from "msqa/ai";
import { AuthStorage } from "msqa/auth";
import { ModelRuntime } from "msqa/models";
import { createSharedHostResidency } from "msqa/residency";
import { openDurablePresentation } from "msqa/presentation-service";
import { openThinDurablePresentation } from "msqa/thin-presentation-service";
import { createThinPresentation } from "msqa/thin-presentation";

const context = BACKGROUND_CONTEXT;
const root = process.env.MSQA_DATA_ROOT;
assert(root, "Use the identity-checking artifact-loader.ts preload");
assert(typeof globalThis.gc === "function", "Use --expose-gc for the actual reclaim oracle");
const PACKED = 306;
const marker = (index) => `MSQA[${String(index).padStart(3, "0")}]`;
const requests = new Map();
const textOf = (message) => typeof message.content === "string" ? message.content :
	message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const answer = (index) => `${marker(index)} answer-first answer-middle answer-last`;
const idle = (native) => {
	const live = native.view.current().conversation.docs["pi.live"];
	assert(live && typeof live === "object", "Actual pi.live document is required");
	return live.run === undefined && (live.compactions?.length ?? 0) === 0;
};

async function until(predicate, label, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert(Date.now() < deadline, `Timeout: ${label}`);
		await delay(10);
	}
}

// Only byte/service plumbing is adapted. The engine, native SDK/store, endpoint,
// replica decoder and controller below are the compiled product implementations.
async function present(handle, bounded = false) {
	const attachment = await handle.attachClient(context);
	const listeners = new Map();
	const publish = (id, value) => listeners.get(id)?.(value);
	const invoke = (call, ctx = context) => attachment.invokeService(call, publish, ctx);
	const transport = {
		invoke,
		async subscribe(serviceId, mode, listener, ctx) {
			const id = `qa-sub-${listeners.size}`;
			const decoder = createServiceStateDecoder();
			let active = false;
			const queued = [];
			const receive = (value) => {
				if (!active) queued.push(value);
				else listener(decoder.decodeUpdate(parseWireServiceProviderUpdate(value)), context);
			};
			listeners.set(id, receive);
			const raw = await invoke(createServiceSubscribeCall(id, serviceId, mode), ctx);
			const snapshot = decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(raw));
			return { snapshot,
				activate() { active = true; for (const value of queued.splice(0)) receive(value); },
				async close() { listeners.delete(id); await invoke(createServiceUnsubscribeCall(id), ctx); },
			};
		},
	};
	const native = bounded ? await openThinDurablePresentation(transport) : await openDurablePresentation(transport);
	return { ...native, attachment, async release() { await native.close(); await attachment.release(context); } };
}

function scriptedProvider(providerId) {
	const faux = fauxProvider({ provider: providerId, tokensPerSecond: 1000, tokenSize: { min: 1, max: 1 } });
	const response = (request) => {
		const lastUser = request.messages.findLast((message) => message.role === "user");
		assert(lastUser, "Native request contains actual user message");
		const input = textOf(lastUser);
		const match = input.match(/^MSQA\[(\d{3})\]/);
		assert(match, "Native request carries own exact marker");
		const index = Number(match[1]);
		assert.equal(providerId, index % 2 ? "msqa-odd" : "msqa-even", "Provider isolation");
		for (const foreign of JSON.stringify(request.messages).matchAll(/MSQA\[(\d{3})\]/g)) {
			assert.equal(Number(foreign[1]), index, "Foreign history in actual model request");
		}
		requests.set(index, structuredClone(request.messages));
		if (input.includes("tool-proof") && request.messages.at(-1)?.role !== "toolResult") {
			return fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'one-effect\\n' >> tool-proof.txt" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(input.includes("cancel-proof") ? `${marker(index)} ${"unfinished-stream ".repeat(1000)}` : answer(index));
	};
	faux.setResponses(Array.from({ length: PACKED * 5 }, () => response));
	return faux;
}

test("exact composed native packed behavior (not RAM, wire replay, CI or live acceptance)", { timeout: 480000 }, async (t) => {
	const providers = [scriptedProvider("msqa-even"), scriptedProvider("msqa-odd")];
	const models = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}),
		modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	for (const faux of providers) models.registerNativeProvider(faux.provider);
	await models.refresh({ allowNetwork: false });
	const states = new Map();
	const host = await createSharedHostResidency({ policy: { maxSessions: PACKED }, maxConcurrentHydrations: 4,
		hydrate: { root, modelRuntime: models, onState: (id, state) => states.set(id, state) } });
	t.after(async () => { await host.close(); models.dispose(); });
	const sessions = [];
	for (let index = 0; index < PACKED; index++) {
		const id = `s${index}`;
		mkdirSync(join(root, id), { recursive: true });
		const handle = await host.runtime.host.openSession({ id }, context);
		const native = await present(handle);
		const faux = providers[index % 2];
		await native.controller.setModel({ provider: faux.provider.id, modelId: faux.getModel().id });
		const snapshots = [];
		const thinSnapshots = [];
		const nativeThin = await present(handle, true);
		const unsubscribeThin = nativeThin.subscribe(() => thinSnapshots.push(nativeThin.current()));
		const unsubscribe = native.view.subscribe(() => snapshots.push(native.view.current()));
		const original = native.view.current().session;
		await native.controller.submit(`${marker(index)} history-proof`, "followUp");
		await until(() => JSON.stringify(native.view.current().conversation.entries).includes(answer(index)), `${id} actual completion`);
		assert(snapshots.some((view) => {
			const serialized = JSON.stringify(view);
			return serialized.includes("answer-first") && !serialized.includes("answer-last");
		}), `${id}: live intermediate STREAM snapshot required, not final-only`);
		assert(thinSnapshots.some((view) => view.lines.join("\n").includes("answer-first") && !view.lines.join("\n").includes("answer-last")), `${id}: actual bounded DTO must stream before final`);
		await until(() => idle(native), `${id} native idle`);
		unsubscribe();
		unsubscribeThin();
		const thin = createThinPresentation({ surfaceId: id, pollMs: 0, create: () => ({
			sessionId: id, submit: (text) => nativeThin.submit(text),
			observe: async () => nativeThin.current().lines,
			close: async () => { await nativeThin.release(); await native.release(); },
		}) });
		assert.equal(thin.status().painted, false);
		thin.component.render(80);
		await until(() => thin.status().attached, `${id} real paint attachment`);
		await thin.refresh();
		const frame = thin.component.render(80).join("\n");
		assert(frame.includes(marker(index)), `${id}: missing native presentation marker`);
		for (const foreign of frame.matchAll(/MSQA\[(\d{3})\]/g)) assert.equal(Number(foreign[1]), index, "Foreign frame");
		assert.equal(await host.parkWhenQuiescent(id), "refused-not-quiescent");
		await thin.exit();
		thin.dispose();
		assert.equal(await host.parkWhenQuiescent(id), "parked");
		assert.equal(states.get(id)?.openedRetained, false, "Native engine reference dropped");
		assert.equal(states.get(id)?.live, false, "Native residency released");
		assert(!readdirSync(original.directory).some((name) => name.endsWith(".lock")), "Native store lock released");
		const db = new DatabaseSync(join(original.directory, "session.sqlite"), { readOnly: true });
		try { assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); } finally { db.close(); }
		sessions.push({ id, handle, original });
	}
	assert.equal(host.runtime.control.identities().length, PACKED);
	assert(host.runtime.control.identities().every((identity) => identity.pid === process.pid), "Single runtime process");
	for (let index = 0; index < PACKED; index++) {
		const { id, handle, original } = sessions[index];
		let native = await present(handle);
		assert.equal(native.view.current().session.id, original.id, "Reopen retains actual native id");
		assert.equal(native.view.current().session.directory, original.directory, "Reopen retains same store");
		await native.controller.submit(`${marker(index)} recall-proof`, "followUp");
		await until(() => textOf(requests.get(index)?.findLast((message) => message.role === "user") ?? { content: "" }).includes("recall-proof"), `${id} resumed request`);
		assert(JSON.stringify(requests.get(index)).includes("history-proof"), "Actual resumed model context has old user history");
		assert(JSON.stringify(requests.get(index)).includes(answer(index)), "Actual resumed model context has old assistant history");
		await until(() => idle(native), `${id} resumed idle`);
		if (index === 0) {
			await native.controller.submit(`${marker(index)} tool-proof`, "followUp");
			await until(() => requests.get(index)?.some((message) => message.role === "toolResult"), "Native tool result consumed");
			assert.equal(readFileSync(join(original.cwd, "tool-proof.txt"), "utf8"), "one-effect\n");
			await until(() => idle(native), "Tool turn idle");
			await native.controller.submit(`${marker(index)} cancel-proof`, "followUp");
			await until(() => JSON.stringify(native.view.current()).includes("unfinished-stream"), "Real native in-flight stream");
			const peer = await present(sessions[1].handle);
			await peer.controller.submit(`${marker(1)} peer-proof`, "followUp");
			await native.release();
			assert.equal(await host.parkWhenQuiescent(id), "refused-active-work", "Detached active native work cannot park");
			await assert.rejects(native.attachment.invokeService({ member: "submit", args: ["stale"] }, async () => undefined, context), /released|closed/i);
			native = await present(handle);
			assert.equal(native.view.current().session.id, original.id, "New attachment retains native identity");
			const cancelLeg = await present(handle, true);
			const cancelSurface = createThinPresentation({ surfaceId: "qa-native-cancel", pollMs: 0,
				abort: () => cancelLeg.abort(), create: () => ({
					sessionId: id, submit: (text) => cancelLeg.submit(text),
					observe: async () => cancelLeg.current().lines, close: () => cancelLeg.release(),
				}) });
			cancelSurface.component.render(80);
			await until(() => cancelSurface.status().attached, "Native cancel surface attached");
			await cancelSurface.abort();
			try {
				await until(() => idle(native), "Presentation must cancel actual native turn, not only set UI flag", 1500);
			} finally {
				await native.controller.abort();
				await cancelSurface.exit();
				cancelSurface.dispose();
			}
			await until(() => idle(native), "Actual cancelled native turn idle");
			assert(JSON.stringify(native.view.current()).includes("aborted"), "Native aborted outcome, not a UI flag");
			await until(() => textOf(requests.get(1)?.findLast((message) => message.role === "user") ?? { content: "" }).includes("peer-proof"), "Peer model turn executes independently");
			await until(() => idle(peer), "Cancelling A must not cancel B");
			assert(!JSON.stringify(peer.view.current()).includes("aborted"), "Peer was not cancelled");
			await peer.release();
			assert.equal(await host.parkWhenQuiescent(sessions[1].id), "parked");
		}
		await native.release();
		await assert.rejects(native.controller.submit(`${marker(index)} stale-write`, "followUp"), /closed|released/i);
		assert.equal(await host.parkWhenQuiescent(id), "parked");
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		await delay(0);
		globalThis.gc();
	}
	for (const { id } of sessions) {
		assert.equal(states.get(id)?.openedRef?.deref(), undefined, `${id}: parked native object must be GC-reclaimable`);
	}
	writeFileSync(join(root, "native-summary.json"), `${JSON.stringify({
		packed: PACKED, resumedWithActualContext: requests.size, sameRuntimePid: process.pid,
		claim: "Focused native assertions only; transport is in-process. Wire writer replay, fault recovery and unsafe-extension fallback still require their matrix oracles. No RAM/CI/live claim.",
	})}\n`);
});
