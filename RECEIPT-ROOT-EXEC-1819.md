# RECEIPT — ROOT-EXEC-1819 (p9, 05/10/2026 19:1x BRT)

ONE retained source slice: the native fixture turn-wait/event receiver bug.

## What was wrong
`message_update` fires ONLY when the partial changes (packages/durable/src/harness/events.ts:233-234), so a coalesced/short turn emits `message_start` + terminal `message_end` with NO intermediate `message_update`. The old receiver waited for `message_update` alone and could never settle such a turn (the "Condition was not reached" fixture crash).

## The correction (minimum)
- `test/history-reclaim-receiver.ts` — the pure receiver predicates: `sawTerminal` (the terminal `message_end`, which the contract guarantees), `sawIntermediateDeltas`, `deltasPrecedeTerminal`.
- `test/history-reclaim-overlay.ts` — the battery turn-wait now settles via `sawTerminal(batches.flat())`; the streaming check asserts delta delivery AND ordering (`deltasPrecedeTerminal`) before the settled text appears.

## ONE deterministic offline event fixture/check
`test/history-reclaim-receiver-check.ts` — pure event arrays, no harness/network/provider. It FAILS the old logic explicitly and proves the new receiver.

## Actual check output
```
PASS old logic (message_update-only) FAILS the terminal-only fixture (the bug)
PASS new receiver settles the terminal-only fixture via the terminal event
PASS new receiver settles the streamed fixture via the terminal event
PASS new receiver reports no intermediate deltas on the terminal-only fixture
PASS new receiver proves deltas precede the terminal on the streamed fixture
RECEIVER CHECK: ALL PASS (deterministic offline fixture; the old message_update-only logic is proven broken and the terminal-event receiver proven correct)
check-exit=0
```
PARSE-OK via `module.stripTypeScriptTypes` on all three files.

## Changed paths + exact source head
- `test/history-reclaim-receiver.ts` (new), `test/history-reclaim-receiver-check.ts` (new), `test/history-reclaim-overlay.ts` (the turn-wait correction).
- **Exact source head: `941ab709a0594da64caf34ff8cd1171a1c141b9b`** (branch `1206-history-overlay`, pushed + `git ls-remote` VERIFIED; on top of the integrated `4f5f5366b`). Prior heads stay identifiable: `fca1f95b7` (the receiver + check), `f77050d80`/`4372459e` (the earlier batteries), frozen `4372459e8`+`8475` artifacts.

## Scope
My 1714 battery fixes were found already integrated on the branch (typed predicates, REQUIRED_CASES 13) during the rebase; my commit replayed empty and was skipped — no duplicate work. No p4 presentation-snapshot/async-SQLite repairs, no pD thin-presentation slice, no other owner's WIP touched. No native run here (the genuine native acceptance keeps its own gates with p4 as the sole source-bound verification owner). No paid fixtures, no provider/client/key changes, no host/admission changes.

Native activation 0/6 is not claimed as a prerequisite result; ordinary public-source coding only. `100x`/live/RAM remain UNPROVEN.
