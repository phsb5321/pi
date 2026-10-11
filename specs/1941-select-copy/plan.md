# Plan — 1941-select-copy: windowed-selection copy equality

Slice: select+copy done right (ms-ux, 10/10/2026). Spec source:
vault `Memory-Sound Program/TUI-Differentiators-2026-10-10.md` §1 (accepted 19:38 BRT).
Base: `origin/memory-sound` (a5547b85d). PR target: `memory-sound` (all program PRs #1–#13 base there;
the fork pins under test exist only in this lineage — "worktree from origin/main" noted as a
base-branch conflict in the checkpoint, resolved in favor of the only viable base).

## Problem (measured, not inferred)

The S11 render windowing (`packages/tui/src/components/render-memo.ts` + the eviction pass in
`packages/tui/src/layout.ts`, commit d6cec9ff8) drops rendered lines for boxes fully outside
`clip ± (viewport + 64)` and answers later renders of the same text/width with blankness-preserving
**stub rows** (`""` / `"\u0000"`). The S11 commit claims "re-entry re-renders from source
byte-identically"; measured on the product's mount shape (`setLayoutRoot`, interactive-mode.ts:879):

- red pin run (`evidence/red-pin-run.txt`): a selection over three painted rows —
  `child 0 line a/b/c` — copied `'\n\n'` (three empty rows) once the windowing had evicted those
  boxes and one repaint had passed. Exactly-the-highlighted-glyphs semantics violated: the copy
  silently returned nothing.
- direct-frame probe (`evidence/evict-probe2.mjs`): after eviction, a re-entering box's frame rows
  are stub rows; the copy/search/word-segmentation path (`scrollContentLines`) carries them too.
- the stub rows are correct for their designed consumer (per-frame paint must not re-render far
  content — no re-render storm) and wrong for every byte-reading consumer.

## Design — seam first

**NEW `packages/tui/src/selection-window.ts`** (the seam): `resolveSelectionSourceLines(frame,
scrollView, startRow, endRow)` resolves the real content lines for a row range through the
windowing. Real rows pass through untouched (fast path); a range containing stub rows is
materialized once per frame from source (invalidate the memo down the component tree, render the
content at the frame's content width, cache per frame content array in a WeakMap). Copy and
selection anchoring are user-triggered one-shots, so at most one real re-render happens per copy;
the re-stored memo makes the next paint byte-identical, and the windowing re-evicts on the next
paint pass.

**Core edit (named seam alternative rejected):** `packages/tui/src/tui-alt-screen.ts` +10/−4 —
1 import + 2 call sites (`getSelectionSourceLine`, `getActiveSelectionText`) now resolve through
the seam. *Rejected alternative:* mapping offsets inside `text.ts`/`markdown.ts` or making
`RenderMemo.hit()` always re-render — both deepen the HIGH-exposure twice-bumped core files /
reintroduce the per-frame re-render storm S11 exists to prevent. No text/markdown/layout/
render-memo lines change in this slice.

## Acceptance rows (docs/PROGRAM-RULES.md)

| gate | row |
|---|---|
| behavior-identical | upstream selection suite unchanged and green (45 selection/copy cases in `tui-alt-screen.test.ts`; full `packages/tui` 1041 tests / 0 fail). Copy-on-select, OSC 52 fallback, injected `copySelection`, word/line granularity, `copyOnSelect` policy: all pinned by pre-existing tests. New behavior only where the old path returned empty/stub bytes. |
| kill-9 vs clean-exit | invisible: the seam keeps no session state (a WeakMap keyed by per-frame arrays, GC'd with the frame); no timers, listeners, or buffers survive a frame. Transcript/restore surface untouched. |
| plugin compatibility | **invisible** row: no new hooks, no signature changes, no timing assumptions; extensions cannot observe the seam (it runs inside the TUI's private selection path). |
| memory | bounded-delta: +255 new lines (100 seam + 155 pins), +6 net in one core file. Seam cache ≤ one frame's content-line array per frame (WeakMap). Harness RSS red 59.4 MB → green 61.8 MB peak (test process; below run-to-run noise). Full MS-04-format mem-probe table = p6 verification item (research seat may not spawn fleet seats). |

## Pin tests (behavior-pinned; must fail if the fork behavior regresses)

`packages/tui/test/selection-window.test.ts` — 4 cases driving the product mount shape
(`setLayoutRoot`): (1) windowed-selection copy equality (the spec's pin: copied bytes == the glyphs
painted at highlight time, after eviction + repaint), (2) same equality across scroll-away +
scroll-back + repaint, (3) word granularity resolved from real glyphs on a windowed row,
(4) fullscreen copy policy (no copy on select when disabled; explicit copy still exact).
Red evidence: 3/4 failed before the seam (`evidence/red-pin-run.txt`, actual `'\n\n'`).

## LOC ledger

| file | kind | +/− |
|---|---|---|
| `packages/tui/src/selection-window.ts` | NEW (seam) | +100 |
| `packages/tui/test/selection-window.test.ts` | NEW (pins) | +155 |
| `packages/tui/src/tui-alt-screen.ts` | core (2 call sites + import) | +10 / −4 |
| **total** | | +265 / −4 |

Net simplification: all windowing knowledge stays in one new file; zero edits to the four
HIGH-exposure registry files (`interactive-mode.ts`, `tool-execution.ts`, `text.ts`, `markdown.ts`).
U3 slop lane: no non-overlapping slop found in the touched files — the census's rows #9/#10 sit in
the dokku seat's lane (interactive-mode/tool-execution/text/markdown comment cluster) and are
deliberately not touched here.

## U-rank

**U3** — generic, behavior-preserving (restores the documented S11 contract "re-entry re-renders
from source byte-identically" on the copy path), minimal diff. Straight-PR shape for
`earendil-works/pi` after the `lgtm` gate; no upstream PR from this slice.
