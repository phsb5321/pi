# Handoff — 1941-select-copy (windowed-selection copy equality)

10/10/2026 22:5x BRT · ms-ux · one speckit slice, one PR.

**What landed:** the selection-window seam (`packages/tui/src/selection-window.ts`) resolves the
real content lines behind a mouse selection through the S11 render windowing; `tui-alt-screen.ts`
routes `getSelectionSourceLine` and `getActiveSelectionText` through it (+10/−4 core). Four
behavior-pinned tests in `packages/tui/test/selection-window.test.ts` fail without the seam
(copied `'\n\n'` for highlighted `child 0 line a/b/c`) and pass with it.

**Evidence:** `evidence/red-pin-run.txt` (pre-fix, 3/4 fail with actual bytes),
`evidence/green-pin-run.txt` (post-fix 4/4), `evidence/evict-probe2.mjs` +
`evidence/stub-mechanism.mjs` (the mechanism probes: stubs after eviction in the `setLayoutRoot`
mount shape; zero `dropRenderedLines` in the `addChild` shape because the tree collapses to one
leaf box — why the bug hides in naive tests).

**Known adjacent defects NOT in this slice (tracked rows):**
1. Paint re-entry: a re-entering box paints stub rows (blank) until its memo re-renders —
   `evidence/evict-probe2.mjs` frame rows `"\u0000"`. Belongs to the render/windowing lane;
   owner: ms-ux follow-up slice (fix belongs in the eviction/`RenderMemo` contract, not in
   selection).
2. `refreshSearch` searches `scrollContentLines` incl. stub rows (missed matches in evicted
   ranges) — same seam can be reused (`resolveSelectionSourceLines`), one call-site change.
3. Baseline-red `npm run check` errors in `packages/coding-agent/test` (model-id literal types)
   are pre-existing on this base and untouched here.

**Registry entry (fork-surface):** `packages/tui/src/selection-window.ts` | windowed-selection
copy equality (S11 x mouse selection) | NEW file, merge-safe | pins:
`packages/tui/test/selection-window.test.ts` (4) | owner: ms-ux.
`tui-alt-screen.ts` stays an upstream file with a +10/−4 upstreamable U3 diff (no new fork row).
