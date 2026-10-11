# Tasks — 1942-statusline-anim

- [x] T1 Correct the measured state: re-count P5-ANIM-SOURCE2 with braille-only spinner glyphs
      (the probe's `|/-\` regex inflates counts from ordinary text). Idle-zero contract already
      held; the active spinner rate is the real cost.
- [x] T2 Seam: NEW `status-line/animation-policy.ts` (frames + 2 Hz rate + policy docs);
      rejected alternatives named in `plan.md`.
- [x] T3 Wire: `status-indicator.ts` resolves indicators through the policy; `loader.ts` additive
      `renderVerbatim` option (default keeps every existing behavior).
- [x] T4 Pins: `status-line-animation.test.ts` (5) + `status-line-counters.test.ts` (2); pre-existing
      status-indicator/footer/interactive-mode-status suites green (35 tests across the five files).
- [x] T5 Measure on the P5 lineage: `evidence/P6-ANIM-BASE1` vs `evidence/P6-ANIM-POLICY1`
      (spinner frames 21→4, active PTY −44/−43 %, idle 0 both) + `ANIMATION-TABLE.md`.
- [x] T6 LOC ledger + PROGRAM-RULES rows (`plan.md`).
- [ ] T7 Commit, push, PR → memory-sound, merge.
- [ ] T8 Registry entry + checkpoint.
