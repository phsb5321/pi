# R3 feasibility — D: module-graph elimination (bundle tree-shake + V8 snapshot)

Owner w28:p5 (C+D), 01/10/2026 20:4x BRT. Fork-only, never PR upstream.
Format per `FEASIBILITY-BRIEF.md`. Binding rules apply at claim time;
bars per class-point rule.

**Copy-on-write answer: the evaluated module graph is NOT CoW.** It is
per-process V8-heap state (private anonymous memory) — every seat evaluates
its own copy. Only file-backed pages share: the bundle's source text on
disk and `NODE_COMPILE_CACHE` entries (mmap'd, read-only-shareable). V8
startup snapshots do not change this: each process deserializes its own
copy (research §1; MS-28 parked on exactly this).

## Measured ceiling

- Attackable classes (MEASURED inputs): code objects **~21.0 MiB/seat**
  (M1 differential, P90, engine side) + the module-eval share of the
  source-as-text bucket (**11.6 MiB**, age-invariant, already targeted by
  the MS-20 lazy-load slices).
- Tree-shake captures the dead fraction of both: **ESTIMATED 5–10 MiB/seat
  → fleet ≈ 1.5–3 GiB** (306 seats).
- V8-snapshot half: **~0 MiB RAM** (derived, high confidence — per-process
  deserialization; the win is warm-start latency only).

## Effort + risk

- Tree-shake: **M** — audit dynamic-import/`createRequire` barriers (the
  sanctioned lazy pattern keeps every require target reachable; shake wins
  come from genuinely unused deps/exports). Risk **M**: side-effectful
  module init must survive; lazy sites can silently re-grow graphs →
  guard with `check-entry-graphs` budget ratchets in-PR.
- V8 snapshot: **M–H** (CJS prelude restructure), risk M — parked.

## Plugin compatibility matrix row

**invisible** — same surface, strictly less dead code; output-identical.
Evidence-gated on rendered-output parity + kill-9 conformance. Any
availability-timing change on the extension loader surface escalates to
needs-restart + G-ruling.

## Upstream PR shape

- Tree-shake: **U3** straight PRs — one shake region per PR (minimal-diff,
  behavior-identical) + `check-entry-graphs` budget updates. Ideal
  follow-up to MS-20 S2 (barrel decoupling removes the biggest shake
  barrier).
- V8 snapshot: **U2** (architecture; issue + `lgtm` first) — parked.

## Dependencies

- esbuild config audit (no explicit tree-shaking setting in
  `scripts/build-coding-agent-bundle.mjs` today — esbuild ESM default
  applies, so the low-hanging dead code may already be gone; the audit
  confirms what remains).
- `check-entry-graphs` budgets as the regression ratchet.
- Sequence after MS-20 S2 lands (avoid double-churn on the same graphs).

## GO/NO-GO

- **CONDITIONAL-GO — tree-shaking** (U3, sequenced after MS-20 S2 and the
  S9/S10 cache work settles; ship only with parity + conformance + budget
  ratchets).
- **NO-GO — V8 startup snapshot for RAM** (MS-28 stays parked; re-open
  only for wake-latency, never as a residency claim).
