# Plan — 1942-statusline-anim: status-line animation policy (idle => zero, active throttled)

Slice: the animation variant (ms-ux, 10/10/2026, landed 11/10 01:0x BRT). Spec source: vault
`Memory-Sound Program/TUI-Differentiators-2026-10-10.md` §2 (accepted 19:38 BRT). Base:
`origin/memory-sound` (88e2d4210 = #16). One line of base-branch context in the checkpoint.

## Corrected measurement state (important)

The accepted deliverable read "idle paints 35 spinner frames in 12 s on a source seat" from
P5-ANIM-SOURCE2. Recounting that run's capture with braille-only spinner glyphs shows the
instrument's spinner regex (`⠋…⣷|/-\`) counts ordinary text (any `-`, `/`, `|`): the whole
capture contains **21 real braille frames, all in `── ⠙ Working ───` busy paints, 0 spark
glyphs**. The corrected state: the idle ⇒ zero-animation contract already holds on source runs
(P6 baseline idle bucket = 0 bytes); the real cost is the ACTIVE spinner rate (Loader default
80 ms = 12.5 Hz ticks) and its redraw bytes. This slice ships the active-side variant and pins
the idle contract so neither can regress.

## The variant (P2 throttling contract)

**2 Hz spinner + on-change values + idle zero-tick.** NEW
`packages/coding-agent/src/modes/interactive/status-line/animation-policy.ts` owns the animation
(frames + rate + policy); `status-indicator.ts` resolves every busy indicator through it.
Values (counters, labels, sparkline readouts) keep updating the moment their data changes —
only decoration slows. `LoaderIndicatorOptions` gains an additive optional
`renderVerbatim?: boolean` so interval-only customization keeps the themed (color-function)
spinner; every existing caller's behavior is unchanged (the flag defaults to the old rule).

**Rejected seam alternative (named per the maintenance bar):** pre-colored frame strings in the
policy (zero tui edits) — rejected because indicator color functions are dynamic (the editor
border color tracks the thinking level) and pre-coloring freezes them; and gating the spinner
inside `interactive-mode.ts` — rejected as another HIGH-exposure core edit.

## Measured (P5-ANIM lineage, footprint-probe.py, same phases/flags, 11/10 01:0x BRT)

| metric | baseline (80 ms) | variant (2 Hz policy) | delta |
|---|---|---|---|
| braille spinner frames, whole run | 21 | **4** | **−81 %** |
| mid_turn PTY bytes / B·s⁻¹ | 8 099 / 426 | 4 503 / 237 | −44 % |
| tool_turn PTY bytes / B·s⁻¹ | 7 540 / 397 | 4 293 / 226 | −43 % |
| mid_turn / tool_turn ANSI escapes | 363 / 341 | 228 / 221 | −37 % / −35 % |
| idle PTY bytes (both runs) | 0 | 0 | idle ⇒ zero animation held |
| spark glyphs | 0 | 0 | readout dormant, unchanged |
| idle + tail CPU % | 0.00 | 0.00 | unchanged |
| whole-run PTY bytes | 15 951 | 11 293 | −29 % |

Evidence: `evidence/P6-ANIM-BASE1/`, `evidence/P6-ANIM-POLICY1/` (table.json, result.json,
pty-capture.bin per run) + `evidence/ANIMATION-TABLE.md`. Instrument caveat recorded there: the
probe's spinner counter is ASCII-inflated; counts above are braille-only recomputed from the
captures.

## Acceptance rows (docs/PROGRAM-RULES.md)

| gate | row |
|---|---|
| behavior-identical | spinner glyphs/colors/labels byte-identical (pin: policy render == default Loader render); counters exact (formatTokens + footer golden); sparkline readout passthrough byte-identical; extension `WorkingIndicatorOptions` seam stays authoritative (pin). Pre-existing suites green (status-indicator, footer-width, interactive-mode-status). |
| kill-9 vs clean-exit | invisible: one interval owned by the indicator, disposed with it; no session state, no new timers beyond the animation tick that already existed. |
| plugin compatibility | **opt-in hook** (existing `setWorkingIndicator(options)` unchanged; explicit frames/intervalMs still win). Additive optional `renderVerbatim` field — no signature change. One documented nuance: an extension passing only `intervalMs` now gets the themed spinner (previously raw) — no shipped extension does this. |
| memory | +240 new lines (seam + 2 pins files), +11/−2 core (loader.ts +3/−1, status-indicator.ts +8/−1). No new allocations per frame (frames resolved once per indicator). |

## Pin tests (behavior-pinned)

`packages/coding-agent/test/status-line-animation.test.ts` (5): byte-identical spinner render,
policy frame rate, **idle => zero ticks (zero timers while stopped)**, values-update-immediately,
extension seam authoritative. `packages/coding-agent/test/status-line-counters.test.ts` (2):
formatTokens exact, footer counters + sparkline passthrough golden.

## LOC ledger

| file | kind | +/− |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/status-line/animation-policy.ts` | NEW seam | +57 |
| `packages/coding-agent/test/status-line-animation.test.ts` | NEW pins | +104 |
| `packages/coding-agent/test/status-line-counters.test.ts` | NEW pins | +79 |
| `packages/tui/src/components/loader.ts` | upstream, additive option | +3/−1 |
| `packages/coding-agent/src/modes/interactive/components/status-indicator.ts` | wire-through | +8/−1 |

Zero edits to the HIGH registry rows (`interactive-mode.ts`, `tool-execution.ts`, `text.ts`,
`markdown.ts`). U3 slop in touched files: none taken — the census rows in this neighborhood are
the dokku seat's lane (PR #15, coordinated on #16's thread).

## U-rank

**U3** — generic, behavior-preserving except the deliberate frame-rate change (measured above),
minimal diff, upstreamable straight-PR shape after the `lgtm` gate (no upstream PR from here).
The `renderVerbatim` additive option is the U2-maintainer part if upstream wants the semantics
documented in their options contract.
