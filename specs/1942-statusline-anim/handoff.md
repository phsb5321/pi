# Handoff — 1942-statusline-anim (status-line animation policy)

11/10/2026 01:1x BRT · ms-ux · one speckit slice, one PR.

**What landed:** the status-line animation policy behind NEW
`packages/coding-agent/src/modes/interactive/status-line/animation-policy.ts` (frames + 2 Hz
policy + the idle contract), resolved by every busy indicator via `status-indicator.ts` (+8/−1);
`packages/tui/src/components/loader.ts` gains the additive `renderVerbatim?: boolean` option
(+3/−1) so interval-only customization keeps the themed spinner. Measured on the P5 lineage:
spinner frames 21→4 (−81 %), active PTY bytes −44/−43 %, idle 0 = contract held
(`evidence/ANIMATION-TABLE.md`, raw runs beside it).

**Pins (behavior-pinned, must fail on regression):** `test/status-line-animation.test.ts` (5:
byte-identical spinner render, policy rate, idle => zero timers, values-update-immediately,
extension seam authoritative) + `test/status-line-counters.test.ts` (2: formatTokens exact,
footer counters + sparkline readout passthrough golden). Pre-existing suites green: status-
indicator, footer-width, interactive-mode-status (35 tests across the five files) and the full
`packages/tui` suite.

**Correction recorded:** P5-ANIM-SOURCE2's "idle 35 spinner frames" was an instrument artifact
(the probe's spinner regex counts ASCII `|/-\` in text); see `evidence/ANIMATION-TABLE.md`.
The instrument's spinner counter in the shared 1615 harness should switch to braille-only —
registered as a follow-up row for the harness owner (w28:pH lane), not edited here.

**Registry entry (fork-surface):** `packages/coding-agent/src/modes/interactive/status-line/animation-policy.ts`
| status-line animation policy (idle ⇒ zero, 2 Hz active frames, values-update-on-change)
| NEW file, merge-safe | pins: `test/status-line-animation.test.ts` (5),
`test/status-line-counters.test.ts` (2) | owner: ms-ux. Secondary rows: `loader.ts`
(additive `renderVerbatim` option, upstreamable U3) and `status-indicator.ts` (wire-through,
pins cover it) — both non-registry core files with pins.

**Follow-ups (tracked, not in this slice):** (1) the extraction of footer counters behind the
same `status-line/` seam (the deliverable's U1 shape) — now unblocked and pin-covered;
(2) harness spinner-counter fix (above); (3) the slice-1 follow-ups (paint re-entry of stub
rows; `refreshSearch` over stub rows).
