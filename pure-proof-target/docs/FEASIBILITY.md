# FEASIBILITY — compiled go/no-go (01/10 2026, orchestrator)

One table from `FEASIBILITY-{A,B,C,D,F}.md` + R3 structural research
(p8 ranking, p3 decomposition, R1 class-label ARTIFACT1). Fleet = 306
seats / 43.08 GiB (MS-04). Classes re-based on R1: the "13.5 MiB stack
class" is REFUTED — it is glibc arenas+brk (one class with the 10.5-15.2
brk line); thread stacks ≈ 0.25 MiB. E file landed
(FEASIBILITY-E.md: window+compress+spill via durable Package 20).**

## Go/no-go table (fleet GiB ceilings)

| Dir | Verdict | Fleet ceiling | Effort / U | Mechanism | Gate |
|---|---|---:|---|---|---|
| **C allocator** (MALLOC_ARENA_MAX=1 / mimalloc) | **GO** | **3.1–4.5 GiB** | S / U1 (env line) | kills arena/brk class (burst-side per p3; idle-inconclusive) | mid-turn burst A/B first (p3 design filed) |
| **F2 adoption** (fleet pin → fork build) | **GO** | enables all below | S / U1 (pin plumbing exists) | Nix piVersion → fork build; tonight-able | Δ row + conformance green (endgame rule) |
| **B3 windowing** (= S11) | **GO** | 1.5–2.7 GiB realized (bound 4.4; shared pot w/ S9/S10) | M / U3 | blankness-preserving stubs + height memos + clip±M (R1 design; naive cache-drop = re-render storm — forbidden shape) | post-S9; matrix row invisible (internal symbols) |
| **D module-graph** (tree-shake + V8 snapshot) | **CONDITIONAL-GO** | 1.5–3 GiB | M / U2–U3 | bundle trimming + snapshot; proxy-prone (boot lesson) | measure-first before any claim |
| **E conversation state** (off-heap/compressed, durable rail) | **CONDITIONAL-GO** | **7.3–8.8 GiB attackable** (25–30 MiB/seat; compressed 18–25 → 5.4–7.3; p8 bracket floor 1–4 GiB) — targets the +45.8 growth class | M / U2–U3 (Package 20 rail, issue+lgtm) | off-heap lossless backing + compression; kill-9 byte-identical by construction (JSONL path unchanged) | conditions: >=2x compressibility on real worked-session payloads, object-granularity identity probe, decompress latency <= S, **NO-GO any lossy variant** |
| **A shared runtime** (packages/server, N sessions) | **CONDITIONAL-GO — verdict keys on ISOLATION MODEL** | **worker-isolated: 73–88 MiB/seat → savings 15–20 GiB** (bracket MEASURED 21:3x: marginal ~61 MiB flat at K=8/16/24 — barrel recompiles per isolate ~37 MB datum; 22 MiB committed slack shrinkable via heap caps; GC-lag refuted). **in-process shared-isolate: 5–15 MiB/session → 23–32 GiB survives ONLY here** | L / U2 (substrate EXISTS) | one process, N sessions, thin presentations (surrogate 11.5 MiB + render caches) | in-process = needs-restart + blast-radius row (converges p3 MS-24 2.2× loss); server-mode kill-9 conformance pre-pilot; plugin rows catalogued |
| B1 native renderer | **NO-GO** | +6–9 GiB but U0 | XL | breaks extension UI (Component/EditorFactory surface) | forbidden matrix row — needs G-ruling + Pedro sign-off to even consider |
| B2 shared-process TUI over PTYs | **NO-GO at program scope** | — (folded into A's presentation model) | L | TUI attach behind packages/server RFC | conditional as A's attach model only |
| A child-process variant | **NO-GO** | none (≈ standalone) | — | — | — |
| F1 immutable annex standalone | **NO-GO** | ≤ 0.3 GiB | S | one-copy catalogs | folds into F2 build |

## Implementation order (fleet GiB per effort, risk-adjusted)

1. **C allocator** — env-level, 3.1–4.5 GiB; the burst A/B (p3) measures
   it this week; wrapper U1 with F2.
2. **F2 adoption pin** — ships every landed win to the fleet; first
   adoption = S1+S5+S4b2 class; enables the whole program's payoff.
3. **B3 / S11 windowing** — post-S9; U3 PRs; R1's sound shape only.
4. **D module-graph** — measure-first (proxy history demands it).
5. **E session state** — after its FEASIBILITY-E lands; caps the growth
   curve (pairs with Row A eviction).
6. **A shared runtime** — the big one (23–32 GiB) but LAST: the thin-
   presentation bracket must measure first (p3's 2.2× loss is the
   counterweight), then the packages/server RFC path, then the kill-9
   server conformance case.

## Corrections log

- 21:3x bracket (p8): worker floor 6→61 MiB marginal (old K=8=24.1 = partial-import fixture artifact, corrected); Row A fleet ceiling re-keyed by isolation model; GC-lag refuted. If the worker model is kept, the 22 MiB/worker committed slack is the heap-cap recovery lever.

## Ownership (dedup ruling, S11 collision resolved)

- S11 windowing: **p9 implements post-S9** (spec line + surfaces);
  design canon = R1 ARTIFACT1 + R2 kickoff; canonical evidence dir =
  `evidence/MS-20/s11/`; `s11-render-depth/` + R3's kickoff = pointer
  records. p8's claim released to the structural tier.
- p3: Row C staged rig **repurposed to the allocator burst A/B** (its
  filed design); R1's label answer retires the stack-class question.
- p4: **Row B worker-reuse point 3 does NOT move the arena/brk class**
  (R1 consequence) — re-scope that point (it is C's class, not Row B's).
- R3 (decision track): convenes on the structural tier with this table.
- C/F2 wrapper work rides R3's deploy track (Nix pin = one mechanism).
