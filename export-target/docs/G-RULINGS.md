# G-rulings — recorded gate deviations (per docs/PROGRAM-RULES.md §5)

Format: name, commit@sha, accepted reason, corrective action. Owner: p2.

## G-01 — S1 merged before rules existed (missing §2 conformance + §3 row)

- **Deviation:** `ms/20-hljs-lazy-grammars@832631d` merged `e3715f2` before
  PROGRAM-RULES landed (`f30c43add`): no kill−9/conformance run, no plugin
  matrix row.
- **Accepted reason:** predates the rules (temporal, not evasive). Memory
  table (rule §1) IS satisfied — G1 acceptance run (idle −9.7 MiB PSS+SwapPss,
  381-probe parity, D1).
- **Corrective action:** retroactive §2 conformance suite + §3 matrix row
  (expected `invisible` — pure module-load timing, session storage untouched).
  Status: **CLOSED 01/10 15:5x** — `evidence/MS-20/s1-retro/`: §2 105/105
  green + SIGKILL paths 35 passed/1 skipped; §3 row `invisible` (77-probe
  render parity byte-identical, no surface change).

## G-02 — Synthetic-cohort C6 band deviation (recurring class)

- **Deviation:** synthetic minimal-session A/B seats measure below the MS-04
  fresh census band (84.2–113.9 MiB): G1 runs, S5 table (`4671a885a`),
  S4b2 table (`3237a9748`).
- **Accepted reason:** Δ-claims from same-shape A/B cohorts are
  self-comparable (both arms identical shape; the delta is the claim). The
  ABSOLUTE level is not claimed from these rows.
- **Corrective action / binding rule:** Δ-only rows may use same-shape
  synthetic cohorts (deviation noted per table); any row claiming an
  ABSOLUTE level must use band-corrected cohorts (p6's C6-corrected recipe).
  Status: **ACCEPTED-CLASS** (applies to all future same-shape Δ tables).

## G-03 — History-replay authorization (privacy-scoped)

- **Subject:** MS-21 explanation experiment (history-replay at frozen
  `a0a883aa4`, named by p8 — the +45.8 MiB/10.5h growth is unexplained).
- **Ruling:** AUTHORIZED **provider-free only** — session open + render +
  idle measurement; no model turns; real session payload stays on-host,
  never enters any provider lane; spawn rules (mem-fixture + kill-0 sweep)
  binding. If provider turns prove unavoidable, the run stops and escalates
  to Pedro (privacy gate).
- Status: **ACTIVE**.

## G-04 — MEMORY-OPTIMIZATION-RESEARCH.md addendum stays fork-only

- **Subject:** p8's research addendum (rule-4 tension: fork-only vs upstream).
- **Ruling:** stays **fork-only research** while it carries fleet-measurement
  details. Upstream-worthy distillation travels inside the slice PR bodies
  (which must show understanding per CONTRIBUTING). A generic pi-memory
  docs page (no fleet numbers) is a later candidate PR.
- Status: **ACCEPTED** (deferred re-review at PR time).
