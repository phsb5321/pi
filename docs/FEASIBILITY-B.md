# FEASIBILITY — B: thin/shared TUI renderer (native · shared-process · windowing-first)

**B VERDICT: GO on B3 only (render-depth windowing first = S11, windowing-
only per the class-label answer). NO-GO B1 (native renderer). B2
(shared-process TUI over PTYs) NO-GO at program scope — CONDITIONAL-GO as
track A's TUI attach model behind the `packages/server` RFC.**

Fork-only doc (memory-sound program), 01/10/2026 20:4x BRT, owner w28:pB (R2).
Track B per `docs/FEASIBILITY-BRIEF.md` (Pedro directive: the ~40 MiB/seat
stack is NOT ENOUGH — structural tier); p2 compiles `docs/FEASIBILITY.md`.
Never PR this file upstream. Binding rules apply at claim time: every
implementation claim ships the `docs/PROGRAM-RULES.md` trio (mem-probe
table idle+mid, kill-9 conformance, matrix row); bars per the class-point
rule (exposure-controlled gate runs set points; single runs never); plan
rule 1 (behavior-identical) and the proxy-number lesson (only acceptance-run
and MS-10-class numbers are citable).

Measurement window note: no seats launched for this doc — all numbers are
existing measured classes (growth ledger run-1..3 two-seat convergence,
MS-04 census, and R1's read-only class-label probe). Derived fleet figures
are labeled ESTIMATED. The calm window went to G4 (p6) first; B3's
windowing measurement waits its turn (same gate).

**Class-label ANSWERED (R1, 20:0x — supersedes the brief's premise,
`evidence/MS-20/s11/ARTIFACT1-class-label-probe-2026-10-01.md`):** the
"13.5 MiB render stack" does NOT exist as a stack class — thread stacks are
≈ 0.25 MiB resident (10 × 8 MiB VMA+guard, 8–24 kB Rss each). The 13.5 is
**glibc malloc arenas + brk** (64 MiB-aligned grow-up standalone maps,
outside any cage; the worked seat's two 6–7 MB rows sum 13.0) — ONE class
with the ledger's +10.5–15.2 brk line (p8's "worker-stack + glibc brk"
split = one class, two surfaces), i.e. the **≈ 23.6 MiB non-heap class that
belongs to track C (allocator) / S10**, not to any TUI-renderer option.
Consequences folded here: S11 = **windowing-only** (depth caps demoted —
"iterative paint moves stack to heap"); Row B (p4) worker-reuse design
point 3 does NOT move this class (flagged to p4).

**Attack surface for B, re-based:** UI render caches ≈ **15 MiB/seat**
(p3 object-growth +15.79 ↔ p8 replay ≈ +14.5, convergent ±1.3; aged
strong-root exclusive ≈ 12.5 in the cache-eviction design map) — this is
the ONLY TUI-renderer-addressable class. **Fleet (306 seats, MS-04 @
43.08 GiB):** bound = 15 × 306 ≈ **4.4 GiB**; worked/aged-cohort weighted
(183 seats aged ≥ 1 d at class, 88 fresh ≈ 0) ≈ **2.7 GiB**; realistic
addressable band **ESTIMATED 1.5–2.7 GiB**. It is ONE pot shared with
S9/S10 — levers stack, ceilings do not sum. (The brief's ~28.5 MiB/seat
B premise survives only as B-cache + C-arena combined; C's capture is
documented in `FEASIBILITY-process-baseline.md` §C.)

---

## B1 — Native renderer

Rewrite the render pipeline (differential rendering, layout, terminal
protocols) in a native module; render buffers leave V8.

| field | |
|---|---|
| **Measured ceiling** | The cache class (12.5–15 MiB/seat) minus what S9/S10/S11 already capture; with the stack class refuted, the native-stack win is **0**. **Marginal ESTIMATED 0–5 MiB/seat → fleet 0–1.5 GiB** (V8 string overhead out of render buffers is the only native-unique residue). No arm exists; nothing native-specific is measured. |
| **Effort + risk** | **XL** — `packages/tui` is 19,167 LOC (incl. 731-LOC `terminal-image.ts` kitty/iTerm protocols) plus the interactive component tree it drives. 3–6+ person-months. Risk **L**: the parity hard gate demands byte-identical frames at equal logical content across TWO implementations (381-probe-class suite), on the platform matrix (Windows/ConPTY — see upstream #10256 — Termux, kitty graphics). Custom components and `EditorFactory` editors stay JS, so V8 stays resident and the biggest native win evaporates. |
| **Matrix row** | **forbidden** as a core swap (breaking rows: Component tree, `EditorFactory`, verbatim animation frames, key-release semantics — plugin code observes all of them). An opt-in native buffer backend behind the identical API is **needs-restart** at best and needs a G-ruling. |
| **Upstream PR shape** | **U0-adjacent** (native dep + platform matrix = core bloat against the "pi's core is minimal" philosophy) — banned by the plan's U0 rule. RFC-only if ever (opt-in renderer package). **No PR.** |
| **Dependencies** | Platform matrix, prebuild/Nix packaging, parity harness re-implementation, JS runtime retained for extensions (caps the win). |
| **GO/NO-GO** | **NO-GO.** The class it uniquely addressed is refuted; the remaining marginal ceiling (0–5) cannot pay XL effort + L risk with breaking-class plugin exposure. |

## B2 — Shared-process TUI over PTYs

One TUI host process renders many sessions (tmux-like); per-seat TUI state
collapses into one process; session processes speak PTY/IPC.

| field | |
|---|---|
| **Measured ceiling** | TUI-unique value: cross-pane dedup of identical rendered content (the shared-content secondary class, +3.2–7.1 joint-cut) → **ESTIMATED 0–3 MiB/seat**. The former "stack amortization ≈ 4 GiB" line is re-classed by ARTIFACT1: the 13.5 is allocator arenas, and arenas DO amortize under process consolidation — but that capture belongs to **track A (shared runtime) + track C (allocator knobs, the cheaper route to the same bytes)**, not to the TUI side. The structural prize remains out of B scope: module-graph sharing (D class, ~21 code + 11.6 source MiB/seat — cross-ref `FEASIBILITY-process-baseline.md` §D). |
| **Effort + risk** | **L** (1–3 person-months) — `Terminal` is already an abstraction (`packages/tui/src/terminal.ts`) and upstream ships `packages/server` (experimental: Session routing, multi-presentation attachment, worker retirement) + `experimental/client-tui.ts` (805 LOC presentation TUI on pi-tui + chord facets): adoption, not invention. Risk **L**: process model change, crash isolation, kill-9 conformance (rule 2) must be redesigned (kill -9 one session vs the shared host), input-event protocol (TuiMouseEvent capture/focus semantics + `isKeyRelease` across a process boundary). |
| **Matrix row** | Host-mode = **needs-restart** (new observable surface: the input/presentation protocol). Presentation attachment = **opt-in-hook** (components cross a boundary; `dispose()`/lifecycle must proxy). Editor replacement via `EditorFactory` across processes = **breaking** unless the factory runs host-side in the same JS realm as the TUI. |
| **Upstream PR shape** | **U2 — RFC first** (rfc.earendil.com per CONTRIBUTING FAQ), then PRs into the experimental `packages/server` / `client-tui` surface, never a core swap. Appetite unproven: the embedding ask (earendil-works/pi#8747, daemon-backed multi-session host) was rejected after triage (`no-action`, 27/08→01/09). The `packages/server` README direction (presentation attachments, host-decided worker retirement) is the sanctioned path. |
| **Dependencies** | **Track A (p1: shared runtime via `packages/server` multi-presentation attach) owns the process substrate — B2's TUI attach model is conditional on A's GO.** Then: `packages/server` + `session-backends` + `chord` stabilization; input-event protocol design; conformance redesign; upstream RFC + maintainer buy-in; M3 fleet-pilot shape (herdr already multiplexes panes — the seat model changes). |
| **GO/NO-GO** | **NO-GO at program scope (M2/M3). CONDITIONAL-GO as the packages/server adopt-upstream track** — re-open at RFC level, riding track A's shared runtime (B2 is its TUI attach model, not a standalone build); chase the D-class sharing prize through server adoption, not a bespoke PTY TUI. |

## B3 — Render-depth windowing first

Bound retained render state: window what gets rendered-and-retained, cap the
pure memoization caches (per-component `cachedLines`, `utils.ts:52 widthCache`,
`tui-main-screen.ts:114-137` capture copies). = the S11 lever (owner R2),
now **windowing-only** per ARTIFACT1 (depth caps demoted).

| field | |
|---|---|
| **Measured ceiling** | The cache class 12.5–15 MiB/seat (strong-root exclusive 12.5; growth-attributable 15.8/14.5 convergent) — shared pot with S9 (S9 frees at settled points; B3 caps what gets BUILT and the mid-turn peak, plus rebuild churn) → marginal over S9 alone **ESTIMATED 3–8 MiB/seat**. No stack line (class refuted). Fleet ≈ **2–2.7 GiB class** (attribution-shared with S9/S10). |
| **Effort + risk** | **S–M** (days per limit). Risk **S–M**: the hard part is solved-in-design — the re-render-storm constraint (naive cache-dropping re-renders the whole transcript every frame; `scrollContentLines` re-fills dropped caches) is answered by **blankness-preserving stub/memo windowing** (`evidence/MS-20/s11/S11-DESIGN-INPUT-2026-10-01.md`: tiny `{height, blanknessBitset}` memos + `dropRenderedLines()` stubs that keep the `layout.ts:353-368` image-peek boundary scan-identical; slices S11a/S11b). Any limit that changes what renders is out of scope by the S11 row. |
| **Matrix row** | **invisible** (evidence-gated: rendered-frame byte-identity + held-reference probes on `captureRenderState`/`restoreRenderState`; stubs are scan-identical sentinels, no API exposes cache internals). |
| **Upstream PR shape** | **U3 straight PRs** — the exact shape offered in earendil-works/pi#10308 ("small minimal-diff PRs with before/after PSS+SwapPss tables"); gate = `lgtm` on that issue (S1 PR holds on it). One limit per PR (S11a memo/stub infrastructure, S11b windowing pass). |
| **Dependencies** | Class label **DONE** (ARTIFACT1 — B3 scope = windowing-only); S9 landing (shared surface vocabulary for the evict/rebuild conformance case); p6's §3 matrix row before any claim; calm-window measurement (post-G4). |
| **GO/NO-GO** | **GO** — design-ready (S11-DESIGN-INPUT), U3, invisible row, and literally "windowing first": land B3 now (S11, in flight), keep B1 dead, keep B2 parked behind the A/RFC gate. |

---

## Plugin-visible? — keybinding/TUI extension surface at risk

Verified extension-facing surfaces (all live on `upstream/main`):

1. **Component tree + editor replacement** — `core/extensions/types.ts`:
   `EditorFactory` via `ctx.ui.setEditorComponent((tui, theme,
   keybindings) => …)` (full custom editor), header/footer/content
   Component factories (`Component & { dispose?() }`), widgets
   ("aboveEditor"), **animation frames "rendered verbatim"**.
2. **Keybindings** — `KeybindingsManager`/`AppKeybinding` exported through
   the extension API (`core/extensions/index.ts`); `core/keybindings.ts`
   `KEYBINDINGS` composes `TUI_KEYBINDINGS`; AGENTS.md rule: never hardcode
   key checks, everything stays in the defaults tables. Key-release events
   (`isKeyRelease`, `packages/tui/src/keys.ts`) and mouse dispatch
   (capture/focus/handled semantics, `tui.ts`) are part of that contract.
3. **Theme** — `Theme`/`EditorTheme`/`getAllThemes()` in the same API.
4. **Terminal protocols** — kitty/iTerm image paths (`terminal-image.ts`),
   read/write tool renderers (`core/tools/renderers/`), `replaceable`
   builtin tools (the #10174 warning surface).
5. **Capture/restore** — `captureRenderState`/`restoreRenderState`
   (`tui-main-screen.ts`, `interactive-mode.ts`) — the S10 held-reference
   probe surface.

At-risk map: **B1** breaks 1–5 wholesale unless re-implemented byte-exact
(verbatim frames cannot be "approximated") → forbidden. **B2** moves 1–2–3–5
across a process boundary (new protocol surface → needs-restart; editor
factories must stay host-side or become breaking). **B3** touches none of
them — caches are memoization behind identical accessors, and the stubs are
scan-identical sentinels → invisible, gated on byte-identity + held-reference
evidence.

## Shared conclusion

Re-based on ARTIFACT1: B's TUI-addressable class is the **≈ 15 MiB/seat UI
cache class (ESTIMATED 1.5–2.7 GiB fleet, bound 4.4)** — the brief's 13.5
"render stack" is allocator arenas + brk and routes to track C (with track A
amortizing it later). A thin/shared renderer buys at best a marginal slice
of the cache pot at breaking-class risk (B1) or RFC-class process change
(B2). **B verdict: GO on B3 only (windowing-first = S11, design-ready);
NO-GO B1; B2 parked as track A's TUI attach model behind the packages/server
RFC.** Structural-tier follow-through lives in C (allocator knobs — the
cheapest route to the 23.6 non-heap class), D (module-graph), and A
(shared runtime). Binding gate for every claim stays the PROGRAM-RULES trio
with class-point bars and no measurement during swap-full or G4 windows.
