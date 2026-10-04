/** Small native Chord endpoint test. This fixture is not SDK, TTY, provider or RAM acceptance. */
import assert from "node:assert/strict";
import {
	createServiceSubscribeCall,
	createServiceUnsubscribeCall,
	parseServiceSubscriptionSnapshot,
	type RemoteServiceTransport,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
	attachDurablePresentation,
	openDurablePresentation,
} from "../src/experimental/durable/presentation-service.ts";
import type { DurableView } from "../src/experimental/durable/runtime.ts";

const context = BACKGROUND_CONTEXT;
let view: DurableView = {
	session: { id: "fixture-a", cwd: "/fixture-a", directory: "/fixture-a/store" },
	conversation: { conversation: { id: 1 as ConversationId }, entries: [], docs: {} },
	conversations: [],
	models: [],
	notices: [],
};
const listeners = new Set<() => void>();
const calls: Array<{ member: string; args?: unknown[] }> = [];
const attachment = attachDurablePresentation(
	{
		current: () => view,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	},
	async (call) => {
		calls.push(call);
	},
);
let sequence = 0;
const transport: RemoteServiceTransport = {
	invoke: (call, callContext) => attachment.invokeService(call, () => {}, callContext),
	async subscribe(serviceId, mode, listener, callContext) {
		const id = `fixture-${++sequence}`;
		const result = await attachment.invokeService(
			createServiceSubscribeCall(id, serviceId, mode),
			(_id, update, updateContext) => listener(update, updateContext),
			callContext,
		);
		return {
			snapshot: parseServiceSubscriptionSnapshot(result),
			activate() {},
			close: () => attachment.invokeService(createServiceUnsubscribeCall(id), () => {}, callContext).then(() => {}),
		};
	},
};
const client = await openDurablePresentation(transport);
assert.equal(client.view.current().session.id, "fixture-a");
let received = 0;
const unsub = client.view.subscribe(() => received++);
view = { ...view, notices: [{ id: 1, level: "info", message: "native-state-update" }] };
for (const listener of listeners) listener();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(client.view.current().notices[0]?.message, "native-state-update");
assert.ok(received > 0);
await client.controller.submit("input", "steer");
await client.controller.abort();
await client.controller.compact(undefined);
assert.deepEqual(calls, [
	{ member: "submit", args: ["input", "steer"] },
	{ member: "abort", args: [] },
	{ member: "compact", args: [] },
]);
await assert.rejects(() => client.controller.switchConversation(-1 as never));
assert.equal(calls.length, 3);
unsub();
await client.close();
await client.close();
assert.throws(() => client.view.current());
await assert.rejects(() => client.controller.abort());
await attachment.release(context);
await attachment.release(context);
assert.equal(listeners.size, 0);
await assert.rejects(() =>
	transport.invoke({ serviceId: "pi.durable-presentation", member: "abort", args: [] }, context),
);
console.log(
	"PRESENTATION-CONTRACT: native state hydration/update/dispatch/invalid-id/close/release PASS; no SDK/provider/RAM claim",
);
