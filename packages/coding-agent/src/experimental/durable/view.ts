import type { AgentState, ConversationView } from "@earendil-works/pi-durable";

/** Presentation-only projection. Importing it must not load the SDK or storage. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}
