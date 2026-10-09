import {
	type Context,
	createRemoteServiceBinding,
	createRemoteServiceEndpoint,
	defineService,
	RemoteServiceProvider,
	type RemoteServiceTransport,
	type ReplicatedState,
	replicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { RoutedSessionAttachment } from "@earendil-works/pi-server";
import type { DurableController, DurableView, DurableViewSource } from "./runtime.ts";

/** Native presentation DTO and commands; no Harness, credentials or runtime crosses the boundary. */
export interface DurablePresentation {
	readonly state: ReplicatedState<DurableView>;
	submit(text: string, whenBusy: "steer" | "followUp", context: Context): Promise<void>;
	compact(instructions: string | null, context: Context): Promise<void>;
	abort(context: Context): Promise<void>;
	cycleThinking(context: Context): Promise<void>;
	setModel(model: ModelRef, context: Context): Promise<void>;
	toggleTasks(context: Context): Promise<void>;
	switchConversation(id: ConversationId, context: Context): Promise<void>;
}

export const DurablePresentation = defineService<DurablePresentation>("pi.durable-presentation");

/** One native subscription endpoint per presentation; release drops every reference to the SDK. */
export function attachDurablePresentation(
	view: DurableViewSource,
	invoke: (call: { member: string; args?: unknown[] }) => Promise<unknown>,
): RoutedSessionAttachment {
	const state = replicatedState<DurableView>(view.current());
	let dispatch: typeof invoke | undefined = invoke;
	let source: DurableViewSource | undefined = view;
	const call = async (member: string, args: unknown[] = []): Promise<void> => {
		if (!dispatch) throw new Error("Durable presentation is released");
		await dispatch({ member, args });
	};
	let unsubscribe: (() => void) | undefined = source.subscribe(() => {
		if (source) state.replace(BACKGROUND_CONTEXT, source.current());
	});
	const provider = new RemoteServiceProvider([DurablePresentation]);
	provider.provide(DurablePresentation, {
		state,
		submit: (text, whenBusy) => call("submit", [text, whenBusy]),
		compact: (instructions) => call("compact", instructions === null ? [] : [instructions]),
		abort: () => call("abort"),
		cycleThinking: () => call("cycleThinking"),
		setModel: (model) => call("setModel", [model]),
		toggleTasks: () => call("toggleTasks"),
		switchConversation: (id) => {
			if (!Number.isSafeInteger(id) || id < 1)
				return Promise.reject(new TypeError("Expected a native conversation id"));
			return call("switchConversation", [id]);
		},
	});
	const endpoint = createRemoteServiceEndpoint(provider);
	return {
		invokeService: (call, publish, context) => endpoint.invoke(call, publish, context),
		release() {
			if (!dispatch) return;
			dispatch = undefined;
			source = undefined;
			unsubscribe?.();
			unsubscribe = undefined;
			endpoint.dispose();
			provider.dispose();
		},
	};
}

/** Thin native consumer of the existing routed transport, ready for runDurableTui(). */
export async function openDurablePresentation(transport: RemoteServiceTransport): Promise<{
	view: DurableViewSource;
	controller: DurableController;
	close(): Promise<void>;
}> {
	let closed = false;
	const assertAccess = (): void => {
		if (closed) throw new Error("Durable presentation is closed");
	};
	const binding = createRemoteServiceBinding({
		services: [DurablePresentation],
		transport,
		bound: true,
		assertAccess,
	});
	const remote = binding.use(DurablePresentation);
	try {
		await binding.ready(BACKGROUND_CONTEXT);
	} catch (error) {
		await binding.dispose(BACKGROUND_CONTEXT);
		throw error;
	}
	return {
		view: {
			current() {
				assertAccess();
				const view = remote.state.value;
				if (!view) throw new Error("Durable presentation is not hydrated");
				return view;
			},
			subscribe: (listener) => remote.state.subscribe(() => listener()),
		},
		controller: {
			submit: async (text, whenBusy) => remote.submit(text, whenBusy, BACKGROUND_CONTEXT),
			compact: async (instructions) => remote.compact(instructions ?? null, BACKGROUND_CONTEXT),
			abort: async () => remote.abort(BACKGROUND_CONTEXT),
			cycleThinking: async () => remote.cycleThinking(BACKGROUND_CONTEXT),
			setModel: async (model) => remote.setModel(model, BACKGROUND_CONTEXT),
			toggleTasks: async () => remote.toggleTasks(BACKGROUND_CONTEXT),
			switchConversation: async (id) => remote.switchConversation(id, BACKGROUND_CONTEXT),
		},
		async close() {
			if (closed) return;
			closed = true;
			await binding.dispose(BACKGROUND_CONTEXT);
		},
	};
}
