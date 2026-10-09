# R3 feasibility brief — structural tier (01/10/2026, Pedro directive)

The current stack (~40 MiB/seat) is NOT ENOUGH. Analyze feasibility per direction.
Each owner writes `docs/FEASIBILITY-<DIR>.md`, p2 compiles `docs/FEASIBILITY.md`.
Required per file: measured ceiling (MiB/seat + fleet GiB), effort+risk, plugin
compatibility matrix row (invisible / opt-in hook / needs restart / forbidden),
upstream PR shape, dependencies, GO/NO-GO.

- **A (p1) shared runtime** — one node process, N sessions via `packages/server`
  multi-presentation attach. Plugin API under sharing, crash blast radius, TUI
  attach model. Use p3's marginal-RSS number when it lands.
- **C+D (p5) process baseline** — C: allocator (mimalloc/jemalloc/
  MALLOC_ARENA_MAX=1) vs measured 10.5-15.2 MiB glibc brk/seat (run it if quick);
  D: module-graph elimination (bundle tree-shake + V8 snapshot; copy-on-write?).
- **E (p6) off-heap/compressed conversation state** — the +45.8 MiB worked-session
  class; kill-9 byte-identical conformance; upstream durable path.
- **B (pB) thin/shared TUI** — 13.5 MiB render stack + ~15 MiB UI caches/seat:
  native renderer, shared-process TUI over PTYs, render-depth windowing first.
- **F (pC) immutable data + adoption** — one copy of prompts/skill catalogs/
  syntax tables; plus how the fleet runs our patched build as the pinned pi
  runtime (Nix pin swap before npm publishes 1.0) and the upstream sync burden.
