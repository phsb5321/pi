# Scrollbar paint reuse

Problem: `paintScrollbar` repeatedly segments the same immutable visible rows to replace one cell. A one-line scroll reuses almost the whole viewport, but previously reparsed every row.

Plan: reuse a painted row only when input text, column, terminal width, background-preservation mode and exact styled glyph match. Keep only rows from the last painted viewport, weakly owned by the ScrollView. Preserve the existing uncached replacement function for misses.

Acceptance:
- Same deterministic real TuiAltScreen + Markdown scroll trace before/after, at least 20 samples, >=30% lower median CPU.
- Byte-identical terminal-write hashes per scrollbar mode.
- An unchanged-overlay-frame regression must fail on baseline and pass with the cache.
- ANSI, hyperlinks, wide/combining graphemes, style/geometry/content changes match cold painting.
- Root `npm run check` and targeted layout/alternate-screen tests pass.

Run:
```sh
node --test packages/tui/test/scrollbar-paint-cache.test.ts packages/tui/test/layout.test.ts packages/tui/test/tui-alt-screen.test.ts
npm run check
# Benchmark harness is durable evidence, not duplicated production/test fixtures.
EVIDENCE="$HOME/Documents/Notes/1. Projects/Memory-Sound Program/loop/evidence/p2N-scrollbar-2026-10-30"
cp "$EVIDENCE/harness/scrollbar-paint-bench.ts" packages/tui/test/
bash "$EVIDENCE/harness/p2n-paired-scrollbar.sh" "$PWD" "$EVIDENCE/recomputed" "$EVIDENCE/layout.baseline.ts"
python3 "$EVIDENCE/harness/p2n-scrollbar-summary.py" "$EVIDENCE/recomputed"
```

Baseline: memory-sound @ 1429d44ac86393d0f8356fbe2f1c1e3f7d90aad0. For a controlled comparison, run the same benchmark with only `packages/tui/src/layout.ts` restored from that SHA in an isolated clone. Never swap shared checkout files.

Durable report: `1. Projects/Memory-Sound Program/loop/report-p2N-2026-10-30.md`; raw paired runs and reproducer beside it under `evidence/p2N-scrollbar-2026-10-30/`.

This measures the renderer, not model/tool CPU or physical terminal latency. No deployment/fleet activation or acceptance-ledger mutation is part of this patch. p2E owns the exact-head Forgejo build-check-test gate and merge.
