/**
 * history-reclaim-receiver-check — ONE deterministic offline event fixture
 * proving the retained turn-wait fix (ROOT-EXEC-1819). No harness, no
 * network, no provider: pure event arrays. The OLD logic (waiting for
 * `message_update` alone) never settles the terminal-only fixture; the NEW
 * receiver does. Run: node --experimental-strip-types
 * test/history-reclaim-receiver-check.ts
 */
import { deltasPrecedeTerminal, sawIntermediateDeltas, sawTerminal } from "./history-reclaim-receiver.ts";

let failures = 0;
function check(label: string, condition: boolean): void {
	if (condition) {
		process.stdout.write(`PASS ${label}\n`);
		return;
	}
	failures += 1;
	process.stderr.write(`FAIL ${label}\n`);
}

// Fixture A: a coalesced/short turn — message_start and the terminal
// message_end, with NO intermediate message_update (the contract allows and
// guarantees exactly this shape).
const terminalOnly = [
	{ type: "run_start", changes: [] },
	{ type: "turn_start", changes: [] },
	{ type: "message_start", changes: [] },
	{ type: "message_end", changes: [] },
	{ type: "turn_end", changes: [] },
	{ type: "run_end", changes: [] },
];

// Fixture B: a streamed turn — deltas delivered before the terminal.
const deltasThenTerminal = [
	{ type: "message_start", changes: [] },
	{ type: "message_update", changes: [{ type: "text_delta" }] },
	{ type: "message_update", changes: [{ type: "text_delta" }] },
	{ type: "message_end", changes: [] },
];

// OLD logic: the message_update-only predicate. It never settles Fixture A.
const oldSettled = terminalOnly.some((event) => event.type === "message_update");
check("old logic (message_update-only) FAILS the terminal-only fixture (the bug)", oldSettled === false);

// NEW receiver: the terminal event settles both fixtures.
check("new receiver settles the terminal-only fixture via the terminal event", sawTerminal(terminalOnly) === true);
check("new receiver settles the streamed fixture via the terminal event", sawTerminal(deltasThenTerminal) === true);
check("new receiver reports no intermediate deltas on the terminal-only fixture", sawIntermediateDeltas(terminalOnly) === false);
check("new receiver proves deltas precede the terminal on the streamed fixture", deltasPrecedeTerminal(deltasThenTerminal) === true);

if (failures > 0) {
	process.stderr.write(`RECEIVER CHECK: ${failures} FAILURE(S)\n`);
	process.exit(3);
}
process.stdout.write("RECEIVER CHECK: ALL PASS (deterministic offline fixture; the old message_update-only logic is proven broken and the terminal-event receiver proven correct)\n");
