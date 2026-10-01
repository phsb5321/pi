# memory-sound — execution plan

Owner: orchestrator (w28:p2). Charter: `MEMORY-SOUND.md` (measured problem,
method, milestones). This file is the operational plan that supersedes all
earlier per-seat briefs where they conflict. Fork-only document: never PR this
file upstream.

## Objective (Pedro, 30/09/2026)

Ship pi's behavior unchanged at a fraction of the resident memory. Every
change must be upstreamable in principle; the fork exists to carry pace and
fleet wiring, not divergent behavior. Two hard rules:

1. **Behaviorally identical.** `memory-sound` at any commit must behave like
   `upstream/main` at its base. Any diff that changes observable behavior
   (CLI flags, defaults, prompts, tool semantics, output) is rejected unless
   the change itself has been accepted upstream.
2. **No claim without a table.** Every memory claim ships a PSS+SwapPss
   before/after table from `tools/mem-probe` (the only accepted instrument).
   No table, no merge. Mid-turn and idle. Raw pid lists written to a file —
   a number without its pid list is not evidence.

## Upstream-ability ranking (U-rank) — every work item gets one

| Rank | Meaning | Rule |
|---|---|---|
| **U3** | Generic, behavior-preserving, minimal-diff, core-clean. Straight PR. | Default target |
| **U2** | Generic but needs maintainer buy-in (defaults, architecture adoption). | PR after issue + `lgtm` |
| **U1** | Fleet wiring only (config, build flags, packaging). Fork carries it; candidate for docs upstream. | Fork-only, cheap |
| **U0** | Would fork behavior or bloat core. | Banned — do not build |

Work is ranked before it is scheduled: higher U-rank and lower effort first.
U0 items are closed on sight, whatever their memory win.

### Candidate backlog (provisional ranks — p5 re-ranks after M1)

| Candidate | Lever (charter §) | Prov. U | Notes |
|---|---|---|---|
| Lazy-load per-seat baseline (extension bundle, skills, prompts, MCP machinery, TUI buffers loaded on demand / shared when identical) | 3 | **U3** | Many small independent PRs; each must stand alone |
| Stop retaining whole session JSONL in RAM; windowed/spilled reads via `durable` compaction+overflow (Package 20) | 2 | **U3** | Rides upstream momentum |
| Idle eviction (serialize idle session to disk, free heap, restore on wake) | 2 | **U2–U3** | Policy default needs maintainer input; mechanics may be U3 |
| Heap cap / GC ergonomics for idle seats (`--max-old-space-size`-class, if behavior-neutral) | 3 | **U2** | Needs evidence it doesn't change behavior under load |
| One runtime, many sessions via `packages/server` adoption | 1 | **U2** | Biggest structural win; adoption not invention. Fleet pilot first (M3) |
| Fleet packaging (single shared install, prebuilt bundle pinning) | — | **U1** | Fork wiring; Nix-side |

## Deliverables = PRs against earendil-works/pi from phsb5321/pi

- Fork integration branch: `memory-sound` (= `upstream/main` + charter + plan
  + accepted wins). This shared checkout stays on it.
- Every code deliverable gets its own worktree + branch `ms/<slug>` cut from
  `upstream/main`, containing ONLY that deliverable. Push to fork, PR to
  upstream. Never PR the integration branch itself.
- After the PR merges upstream (or passes p6's acceptance + parity locally),
  it is merged into `memory-sound` and the fleet rebase is routine.
- Commit conventions per repo `AGENTS.md` (`feat/fix/docs(pkg): …`). `npm run
  check` + `./test.sh` must pass before any PR is opened.

### Upstream contributor gate (CONTRIBUTING.md) — tracked by p5

New-contributor issues/PRs are auto-closed; PRs require prior maintainer
`lgtm`. Therefore, in order: (1) p5 verifies phsb5321's standing on
earendil-works/pi (`gh` — prior issues, any `lgtm`/`lgtmi`); (2) draft ONE
concise quality issue: idle pi seat costs 181.5 MiB PSS+SwapPss ×215 seats on
one host, with the M0 table, offering measured fixes. Issue text is addressed
to humans → **[pending] Pedro: approve exact text before posting**. No PR
before the gate is earned; until then, deliverables stack up as clean `ms/*`
branches on the fork.

## Tree discipline (all seats share this checkout)

- Only p4 (eng) and p2 (orchestrator) commit to `memory-sound` in this tree.
- p4 owns `tools/` and build outputs. p3/p8/p1 are read-only here; evidence
  goes to `$PI_SCRATCH_DIR` or the vault, never to this tree.
- Deliverable work happens in per-deliverable worktrees (`git worktree add
  ../pi-upstream-ms-<slug> -b ms/<slug> upstream/main`), owned by the seat
  doing the work. One worktree per outstanding deliverable.
- `git status` must be clean of strangers' files before any commit.

## Roles

| Seat | Role | Owns |
|---|---|---|
| p1 | eng (audit) | Fleet-wide baseline audit: PSS+SwapPss per seat per herdr session, totals + distribution, raw pid lists filed |
| p2 | orchestrator | This plan, milestone gates, integration branch, PR flow |
| p3 | research (profiling) | M1 heap snapshot; top-3 buckets with MiB; maps each to lever + U-rank |
| p4 | eng (build+probe) | Build, `tools/mem-probe`, M0 reproduction, deliverable worktrees |
| p5 | PO | Backlog with U-ranks + acceptance criteria as memory tables; upstream-gate tracker; merge blockers |
| p6 | tester | Acceptance protocol: table format, parity gates, "no table no merge" enforcement |
| p7 | Plane | Tracker project + items mirroring the backlog; each item carries U-rank and PR URL once opened |
| p8 | research (repo) | Upstream-code map: session storage paths, durable/server/telemetry surfaces, boot graph — where each lever lands |

## Milestones — entry/exit gates (orchestrator signs each exit)

**M0 — build & reproduce** (p4 + p1)
- Exit: monorepo builds (`npm run build`, `npm run check` green); one idle
  seat launched from this fork; `tools/mem-probe` **reconciles with the
  MS-04 census on age-matched cohorts**: a fresh (same-day) fork seat within
  ±15% of the 30/09 census cohort (~99 MiB idle) AND a long-lived seat
  within ±15% of the side-projects cohort (177.5–181.5 MiB); p1's fleet
  audit table committed as evidence (done — MS-04). No behavioral deltas
  (diff vs upstream/main = docs + tools only). Variant column must record
  the pi wrapper identity/generation (NixOS switched generations 08:07,
  08:23, 13:33 on 30/09 — wrapper cohort is a live confound).

**M1 — where the heap goes** (p3, p8 support)
- Exit: heap snapshot of an idle seat; top-3 application heap buckets named
  with MiB and % of app heap (app heap = total − bare-runtime baseline);
  each bucket mapped to a candidate lever with a U-rank and effort estimate;
  p5's backlog re-ranked from that data.
- **Differential method (added after MS-04):** snapshot one long-lived idle
  seat (started 27/09, P90-class ≈246 MiB) vs one fresh idle seat (30/09,
  ≈99 MiB) — the delta isolates what grows with age and likely names the M2
  lever directly. Both snapshots must record wrapper identity to cut the
  NixOS-generation confound.

**M2 — first structural win** (p4 builds; p6 accepts; p2 gates)
- Entry: orchestrator picks the lever from M1 data (cheapest MiB per effort ×
  U-rank). Exit: implemented on an `ms/<slug>` branch off upstream/main;
  `npm run check` + `./test.sh` green; p6's parity + memory protocol passed;
  before/after table; PR opened (if gate earned) or branch parked with
  changelog-ready summary; merged into `memory-sound` after acceptance.

**M3 — fleet pilot** (p1 leads probing)
- One herdr session (this one, `side-projects` w28) switched to the fork
  build for a working day; per-seat before/after table; no behavioral
  regressions reported by any seat; then fleet rollout decision + Nix wiring
  (U1) as a separate change.

## Memory table format (the only accepted evidence)

```
| variant (commit/branch) | probe | n seats | idle PSS MiB | idle SwapPss MiB |
mid-turn PSS+SwapPss MiB | Δ vs baseline |
```

- Same host, same probe version, same session shape (idle = ≥5 min after last
  turn; mid-turn = captured during a tool-executing turn).
- Both idle AND mid-turn unless the change explicitly targets one.
- SwapPss reported separately and summed; heavy-swap hosts noted.
- Every table cites its pid-list file path.

## Coordination cadence

- Seats report: one message to orchestrator pane (w28:p2) + update their
  Plane item; durable state goes to the vault save-state
  (`1. Projects/Memory-Sound Program/`), not into this repo.
- Orchestrator gates milestone exits in this file's `## Log` section below.

## Log

- 2026-09-30 — plan written; objective update (upstream-first, deliverables
  as PRs) folded in; seats re-briefed by pointer to this file.
- 2026-09-30 — Plane home = project FLEET (milestones #34–37, backlog
  1:1 with the candidate table #38–43); dedicated board rejected — revisit
  only past >30 active MS items or state collision. Orchestrator has no
  Plane writer mapping; gate receipts route via p7.
- 2026-09-30 14:47 — MS-04 census accepted as M0 fleet evidence (306 seats,
  idle mean 139.7 MiB, 43.08 GiB total). Charter erratum added; M0 gate made
  cohort-aware (fresh-seat target ≈99 MiB, not 181.5); M1 gains the
  differential old-vs-fresh snapshot; variant column must carry wrapper
  identity. M0 stays open pending p4's build + probe reconciliation.
- 2026-09-30 — **Acceptance protocol v1 ADOPTED as the M2 gate** (p6,
  vault `ACCEPTANCE-PROTOCOL.md`) with one blocking amendment: C6 baseline
  validity uses age-matched MS-04 census bands (fresh ≈99.1 MiB) until p4's
  M0 reference number lands, then the M0 reference wins — never the 29/09
  181.5 cohort number (fresh cohorts false-fail against it). Plane items
  re-key to p5's MS-IDs (external-id = MS-ID from BACKLOG.md; ms/<slug>
  branch names unchanged). #34 carries the MS-04 evidence receipt; M0 exit
  gate receipt (repo-gate / memory-sound-m0-gate-<date>) goes to p7 when
  p4's reconciliation closes.
- 2026-09-30 16:05 — **MS-10 accepted** (p3): top-3 buckets named + mapped
  to levers; live heap is not the mass (fresh→P90 delta = live +34.2 /
  slack +33.3 / SwapPss +71.9 / native +17); raw snapshots preserved gz +
  sha256 in evidence/M1-differential/raw/. Caveat (p6 C1): M1 anchor pids
  came from p3 scratch script — bucket analysis stands (heap snapshots are
  its instrument), PSS anchors re-anchored with the accepted instrument
  before any M2 table cites them. **M1 exit = pending MS-12 only.**
- 2026-09-30 16:05 — **MS-02 verdict BLOCKED** (p6): untracked deliverable
  (no sha), no evidence bundle, §7 deviations (no condition label / C4
  proofs; fail-closed violated). Path-to-PASS at evidence/MS-02/ACCEPTANCE.md.
- 2026-09-30 16:10 — **M2 lever pick (orchestrator, per plan entry rule):
  MS-20 lazy-load baseline, first slice.** Cheapest MiB/effort × U-rank:
  source-as-text 11.6 MiB/seat age-invariant (only pure per-seat baseline
  waste bucket), U3, minimal-diff PR shape. Order after it: MS-21 (entry-
  structure growth +11-13 MiB/3d, version-independent) then MS-22 (slack +
  SwapPss mass). Wrapper 0.85.1→0.99.x stays U1/measure-first (live-heap
  delta +17 but fresh-PSS near-parity). Ratify at MS-12.
- 2026-09-30 — p7 receipt-id convention ack'd: receipt tuples are
  project-unique; per-item suffixes `deliverables-2026-09-30-<MS-ID>`;
  anchor id unchanged. Approved.
- 2026-09-30 16:25 — p6 "pristine upstream check red" finding adjudicated
  as worktree artifact (upstream CI build-check-test success @a9424cd;
  lockfile identical b29db89..a9424cd; shared tsc exit 0). Root cause:
  acceptance worktrees must run `npm run build` before check (workspace
  dist/*.d.ts). Protocol gets precondition B0; M0 gates unchanged. Also:
  upstream released 0.99.2 (955cc66) — memory-sound rebase onto new
  upstream/main scheduled at the next quiet point; ms/ branches always cut
  from current upstream/main. mem-verify delivered (ms/mem-verify@fdc7c10,
  self-check PASS on MS-04 data, negative controls FAIL as expected; parked
  pre-lgtm, no PR).
- 2026-09-30 16:35 — **M1 EXIT SIGNED.** Criteria: top-3 buckets named +
  MiB ✓ (MS-10); levers mapped with U-rank + effort ✓; backlog re-ranked ✓
  (MS-12 re-rank v3); differential method ✓. MS-12 v3 **ratifies** the M2
  pick (MS-20 first). MS-20 landing map accepted (p8: 538 boot-graph
  files, per-dep sizing, proxy numbers — MS-10 heap is arbiter). p6
  erratum + protocol B0 (hydrate+build before check) confirmed. M2 is now
  open: p4 implements ms/lazy-load-baseline after MS-03; p5 specs slice
  acceptance tables; first M2 acceptance run on the fixed probe.
- 2026-09-30 21:50 — **G1/S1 verdict BLOCKED + ARBITRATION** (spec clause:
  MS-10 is arbiter). Measured grammar-residency class ceiling = 7.0 MiB
  (p6: A-nocode − B-nocode), corroborated by M1 buckets (source 6.7 +
  grammars 1.0). Proxy-derived bars void: **G1 grammar-class bar re-set
  15 → 5 MiB idle P50** (≈70 % of measured ceiling, spec convention);
  declared ~33 MiB claim RETRACTED (bundle-chunk isolation proxy, not
  seat PSS). S = measured at gate time per §5 (provisional 10 void on
  this class); if measured S > new bar, S1 rides a bundle. Finding 2
  accepted: B-code ≈ A-code ⇒ catalog over-trigger suspected (one-time
  full-catalog load on rare alias) — p9 must make NO path load the full
  catalog, then re-declare. Finding 3: C6-corrected cohort re-run after
  bar + fix. LESSON: proxy numbers (isolated RSS, chunk smoke, per-dep
  sizing) systematically OVERSTATE seat-PSS wins; only acceptance-run
  and MS-10 numbers are citable.
