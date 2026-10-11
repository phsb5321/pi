# Tasks — 1941-select-copy

- [x] T1 Measure the S11 stub contract on the product mount shape (red pin run + direct-frame
      probe; evidence in `evidence/`).
- [x] T2 Red pin tests: windowed-selection copy equality + cross-scroll equality + word
      granularity + fullscreen copy policy (`packages/tui/test/selection-window.test.ts`).
      Red: 3/4 fail, copy returns `'\n\n'` instead of highlighted glyphs.
- [x] T3 Seam: `packages/tui/src/selection-window.ts` (`resolveSelectionSourceLines`) —
      materialize evicted ranges from source, fast path for real rows, per-frame WeakMap cache.
- [x] T4 Core call sites in `packages/tui/src/tui-alt-screen.ts` (+10/−4):
      `getSelectionSourceLine`, `getActiveSelectionText`. Rejected seam alternative recorded in
      `plan.md`.
- [x] T5 Checks: pin suite green 4/4; full `packages/tui` 1041 tests / 0 fail;
      `tsc -p packages/tui/tsconfig.build.json --noEmit` clean; biome clean on the 3 touched
      files. (`npm run check` full-repo: only pre-existing `packages/coding-agent/test` model-id
      baseline errors remain — untouched by this diff; CI runs the authoritative full check.)
- [x] T6 LOC ledger + PROGRAM-RULES rows in `plan.md`.
- [ ] T7 Push `1941-select-copy`, PR → `memory-sound`, detached CI waiter, merge on green.
- [ ] T8 Fork-surface registry entry (checkpoint + register).
