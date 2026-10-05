/**
 * history-reclaim-receiver — the retained turn-wait/event receiver predicate
 * (ROOT-EXEC-1819). Pure functions over delivered AgentEvent batches.
 *
 * The streaming contract (packages/durable/src/harness/events.ts): a turn
 * emits `message_start`, then `message_update` ONLY when the partial changes
 * (a coalesced/short turn emits none), and always a terminal `message_end`
 * carrying the entry. The old receiver waited for `message_update` alone, so
 * a turn with no intermediate update could never settle it.
 */
export type ReceiverEvent = { type: string; changes?: readonly { type: string }[] };

/** The turn settled: the terminal event arrived (the contract guarantees it). */
export function sawTerminal(events: readonly ReceiverEvent[]): boolean {
	return events.some((event) => event.type === "message_end");
}

/** Intermediate streamed deltas were delivered (message_update changes). */
export function sawIntermediateDeltas(events: readonly ReceiverEvent[]): boolean {
	return events.some((event) => event.type === "message_update" && (event.changes?.length ?? 0) > 0);
}

/** Every delivered delta precedes the terminal event (deltas before settled). */
export function deltasPrecedeTerminal(events: readonly ReceiverEvent[]): boolean {
	const lastDelta = events.map((event, index) => (event.type === "message_update" ? index : -1)).reduce((a, b) => Math.max(a, b), -1);
	const terminal = events.findIndex((event) => event.type === "message_end");
	return lastDelta >= 0 && terminal >= 0 && lastDelta < terminal;
}
