# R3 feasibility — C: allocator (mimalloc / jemalloc / MALLOC_ARENA_MAX=1)

Owner w28:p5 (C+D), 01/10/2026 20:4x BRT. Fork-only, never PR upstream.
Format per `FEASIBILITY-BRIEF.md`. Binding rules apply at claim time
(table idle+mid, kill-9 conformance, matrix row); bars per class-point rule.

## Measured ceiling

- **10.5–15.2 MiB/seat glibc brk** (MEASURED — ledger run-3, the arena/brk
  class behind native allocations) → **fleet ≈ 3.1–4.5 GiB** (306-seat
  census). This is the whole attackable class; each arm captures a fraction
  (packer allocators return aggressively; `MALLOC_ARENA_MAX=1` caps arena
  count at the source of the growth).
- **Arm deltas: NOT YET MEASURED.** Two quick A/B attempts (2 seats/arm ×
  3 arms, 90 s settle) aborted over the 10-min budget — the box crawled
  (PSI/swap-full window; seeds alone exceed it). Recipe-ready harness
  (below) runs in ~7 min once calm. G4 has first claim on the next window
  per the calm-window protocol.

## Effort + risk

- `MALLOC_ARENA_MAX=1`: **S** (one env line in the fleet wrapper, U1) +
  **M** evidence. Preload arms: S wiring + M evidence.
- Risk **L–M**: allocator swap is behavior-invisible by contract but
  changes fragmentation/latency profiles; the arena cap can add lock
  contention under tool bursts → measure mid-turn latency alongside memory.

## Plugin compatibility matrix row

**invisible** — allocator substrate; plugin code cannot observe the malloc
implementation. Escalation: none expected; a native-allocator regression
surfacing in plugin land would be a bug, not a surface change.

## Upstream PR shape

U1 fleet wiring (env knob / preload recipe) — **no code PR**. Optional U2
perf-docs note carrying the measured table (issue first). The upstream
product is unchipped either way; this is fleet baseline work.

## Dependencies

- `MALLOC_ARENA_MAX=1`: **none** (glibc knob).
- jemalloc: **available in-store** —
  `/nix/store/7830mkmrlim6br3ndl9ldxf48xhycc0p-jemalloc-5.3.1/lib/libjemalloc.so.2`
  (LD_PRELOAD-able today). mimalloc: not present (nixpkgs has it if wanted).

## Experiment recipe (run in the next calm window; ~7 min)

3 arms × n=2 seeded interactive seats (default / `MALLOC_ARENA_MAX=1` /
`LD_PRELOAD=<jemalloc.so.2>`), serial arms, 90 s settle, per-seat
smaps_rollup PSS+SwapPss + `[heap]` Size/Pss from smaps (the brk readout
this attack is about). Harness logic (kept inline for durability):
seed via `node cli.js -p seed`, launch `--continue` under the arm's env in
tmux, grab `[heap]` + totals, kill arm, next. Claim-grade tables (C4 idle
+ mid-turn, n≥3, exposure-controlled) follow at the gate run.

## GO/NO-GO

- **GO — `MALLOC_ARENA_MAX=1`** (zero-dep, S effort, one-line revert,
  invisible row): adopt behind the binding gate — measured Δ table +
  conformance green (the arm A/B first; claim-grade table at gate).
- **CONDITIONAL-GO — jemalloc/mimalloc preload arms** (lib is in-store;
  data required before adoption).
- **NO-GO** to adopting any arm without its measured Δ table, and no
  experiment launches before the calm window (G4 first).
