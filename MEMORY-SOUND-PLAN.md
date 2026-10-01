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
- 2026-10-01 13:10 — **Push-outage amendment (provisional binding).** Under
  the host-wide GitHub auth outage (no valid token; [pending] Pedro PAT),
  acceptance runs MAY bind to a LOCAL sha as PROVISIONAL-PUSH-HOLD: the
  verdict activates by one-line provenance addendum once the identical
  sha is push-verified; sha drift voids it (existing supersession rule).
  Owner freezes the branch at the bound sha while provisional. Drives:
  ms/21-bundle@a0a883aa4 (s1+s2+s3 merged clean + type-import cleanup;
  full test.sh green in quiet window, Sqlite timeouts = load artifacts
  confirmed) — p6's frozen-frame session AUTHORIZED to start now against
  the local bundle, exploiting the quiet window; captures + aging run
  while the PAT is pending.
- 2026-10-01 13:50 — **M1 HOLDER-ATTRIBUTION ERRATUM** (p8 runtime probe
  at a0a883aa4, positive controls JsonlStorage=2/IMS=3 detected when
  planted, so the probe detects when present): normal CLI constructs
  SessionManager=1/AgentSession=1 but **JsonlStorage=0/InMemoryStorage-
  State=0**; all 5 re-parsed M1 snapshots show ZERO harness store
  instances. p3's classifier measured string bytes then STATICALLY named
  holders — the ~24 MiB H1-H4 attribution is UNSUPPORTED (byte totals
  stand as content classes; holder NAMES void). Consequently s1/s2 do
  not act on the CLI path and s3 removes transient copies only.
  **FIFTH METHOD RULE: attribution requires retainer evidence (GC-root
  chains), never co-location heuristics.** Same-seat growth (+45.8 MiB/
  10.5 h) remains valid (instrument-level). S1's merged 9.7 MiB win is
  unaffected (module-loading mechanism, end-to-end measured). MS-21
  redesign input = retainer analysis of the growth strings (p8 primary,
  p3 cross-check). The frozen-frame session RUNS as the memory-level
  arbiter of this finding.
- 2026-10-01 01:20 — **M0 EXIT SIGNED** (gate repo-gate/
  memory-sound-m0-gate-2026-10-01). Criteria: build+check green @
  749ab56dd (MS-01, p6 B1 cross-confirm); fork seat launched + probed
  (DEMO + MS-03); probe reconciliation vs MS-04 census — long-lived n=88
  mean 181.4 in band (swap-full composition marked); fresh = paired
  same-seat +2.3% at census-time conditions (n=86/87 proof-OK) + 69-min
  instrument drift +1.8/+0.0; static fresh band mechanically
  time-invalidated (cohort aged 10.5 h: 10/86 in band vs 69/86 at census)
  — paired design supersedes it; synthetic recipe floor 81.4 recorded
  informational, not re-based; MS-04 audit complete; no behavioral
  deltas (docs+tools-only fork diff; S1 separately parity-proven).
  Instrument binding: mem-probe v1.2.0 @ 749ab56dd. Also: +45.8 MiB per
  10.5 h work-time growth (ratio med 1.46) = strongest live evidence for
  session-retention (MS-21).
- 2026-10-01 03:00 — **Boot-frame session + peaks re-acceptance.** Session
  valid (60 proof-OK rows, interleaved n=6, D1 495/495). All boot deltas
  ≤6 MiB vs S_measured 12.4 → existing no-win rule decides: **boot-frame
  rows are informational-only** (G3 bar proxy-contradicted — third proxy
  lesson: static-graph shrink ≠ boot PSS win; recorded, bar moot because
  Δ < S gates nothing at any bar). MS-20's gate now rests on the G4
  interactive bundle (bar re-derives at gate time) + S5/S7 + the /llama
  first-command option; if G4 is thin, program weight shifts to MS-21/22
  per the S4a re-rank flag (now measured fact). v1.2.2 peaks RE-ACCEPTED
  @40f950a80 (argmax-exact, in-window ts, tolerant receipts, 2.0s sampler
  in-row) — MS-21 label path unblocked. Instrument matrix: idle/mid-turn
  v1.2.0@749ab56dd · boot v1.2.1 rows byte-preserved · peaks v1.2.2@
- 2026-10-01 17:25 — **THE +45.8 MiB GROWTH IS EXPLAINED** (p8 G-03
  history-replay, provider-free, matched pair at a0a883aa4): work-content
  retention, not wall-age (706-entry worked session = +43.5 MiB settled
  vs 16-entry; wall-age at fixed history FLAT over 27 min). Exclusive
  ledger (heap delta +21.98): **UI render caches +15.06 (68%)** + shared
  message content +6.76 (30%) + H3 +0.16 + T3 +0. Residual ~21.5 = V8
  slack + non-heap (to p3). IMPLICATION: cache-eviction is double-
  vindicated (68% of growth AND the aged-seat mass); accumulation is
  per-rendered-work, so eviction at settled points caps the growth curve.
  Deviations disclosed honestly (run-1 snapshot-order inflation discarded
  with receipt — the probe-before-snapshot rule, reinforced). G-03
  compliance verified (payload on-host, provider-free).
- 2026-10-01 17:30 — **R2 DECISION EXECUTED: upstream issue POSTED** —
  earendil-works/pi#10308 (17:17 BRT, phsb5321; auto-closed untriaged =
  the normal gate cycle per measured base rates: Sept n=947 -> 76.3%
  no-action / 9.1% reopened / 13.9% completed; gate grants 122 lifetime,
  6 in Sept, all in the #9033 shape). Text = p5 draft re-optimized
  (#9033 lgtm-winning shape; voided holder phrasing dropped per the M1
  erratum; bare-node re-measured). STRIKE CORRECTION: "one strike spent"
  was a conservative internal reading — no-action is not enforced blocking
  (label on 2933 issues; repeated no-action filers never blocked). S1 PR
  opens ONLY on lgtm in command position. Follow-through (R2 owns): if
  untriaged past 08/10 -> ONE Discord message; no-action -> never repost.
- 2026-10-01 17:35 — **GROWTH LEDGER CLOSED (two-seat convergence)** (p3
  object-growth × p8 replay, independent): heap +21.98 = UI render caches
  +15.8 + shared message content +7.1 + H3 0.17 + T3 0; residual ~21.5
  NAMED = V8 committed slack + non-heap (churn candidate: T2 getEntries()
  copy churn session-manager.ts:1520 — s3 reframed as slack-targeting);
  honest remainder 1-3 MiB (2-6%): +6.0 MiB structural/extension state
  with no exclusive holder. Wall-age flat confirmed (history-driven).
  Optimization stack now measured-backed: (1) cache eviction (68% of
  heap growth + aged mass), (2) slack class via copy-churn removal +
  heap caps, (3) shared message content secondary. Controls 4/4 (3
  instrument traps caught); engine-substrate taxonomy note open to p8.
- 2026-10-01 18:30 — **LEDGER FINAL (run-3 correction)**: residual is NOT
  V8 slack in the replay frame (slack +0.2 flat) — it is non-heap anon:
  worker-stack ~13.5 (render depth) + glibc brk ~10.5-15.2; p3's +33.3
  slack label is valid for the 3-day age/work frame only. FINAL: ~15 UI
  caches + 3.2 shared + 2.2-3.4 engine (other-or-unselected) + 0.2 H3 +
  23.6 non-heap + 6.0 real-seat line (partly overlapping) -> remainder
  1-3 MiB (2-6%). NEW LEVER: TUI render-depth/windowing (the 13.5 stack
  class). S3 consequence (adjudicated): copy->scan cannot move the idle
  needle — its frame is mid-turn burst + age-work slack series. ALSO:
  R1 swap-reclaim EXECUTED (scoped /tmp purge: SwapFree 68kB->6.74 GiB,
  /tmp 24->12 GiB; per-entry proofs); G4 gate run BLOCKED-ON-ENVIRONMENT
  (18:10-18:18 PSI storms from reclaim churn killed the cohort; pressure
  gate correctly forbade relaunch; resume = calm window, recipe ready);
  S1 PR-PREP ready (ms/pr-hljs@bc2d8dc1c lineage clean, parity
  byte-identical; NOT opened — lgtm gate stands).

## Endgame (Pedro 01/10 19:0x — program-level, binding)

1. **ADOPTION** — once a measured Δ lands, the fleet runs OUR patched build
   locally as its pinned pi runtime. Mechanism: NixOS piVersion plumbing
   (the 0.85.1→0.99.0 bumps prove the swap path) — point the pin at the
   fork build. **Gate: Δ row + conformance green** (p6 verifies; p1
   verifies post-adopt band movement). Owner: **R3 (deploy track)** —
   folded into the NixOS#2536 deploy decision; first adoption target =
   the merged wins (S1 + S5 + S4b2 class) once the pin plumbing lands.
2. **SYNC DISCIPLINE** — the fork tracks upstream continuously: rebase/
   merge upstream/main regularly (upstream ships fast — 0.99.0→0.99.1 in
   days); PR-only-new-content stays rule 4 (divergence shrinks to unlanded
   PRs only); **every upstream version bump is re-measured with mem-probe
   before fleet adoption.** Owner: **p1 (sync + re-measurement cadence)**.

- 2026-10-01 19:10 — S11 (TUI render-depth) ownership reconciled.
  AMENDED 19:2x: **R2 owns S11 execution** (ratified — it produced the
  kickoff 2x2 discriminator and has gate-timer capacity; supersedes the
  p9-after-S9 placeholder and my earlier p9 line). p9 stays on S9 (Row A,
  source-complete). p3 keeps the stack-class LABELING research (feeds
  R2's 2x2). p5 folds the spec row (U3 if pure-memoization caps hold, U2
  if windowing is plugin-visible). Sequence unchanged: S11 lands after
  S9. Upstream PR check: zero phsb5321 PRs on earendil-works/pi — lgtm
  gate intact.

- 2026-10-01 19:2x — **UPSTREAM v1.0.0 RELEASED (a13d35a74, git-only) —
  sync-discipline execution (Pedro):** (1) fork syncs onto upstream/main
  v1.0.0, memory-sound delta stays minimal (rule 4: divergence = unlanded
  PRs + fleet wiring only) — p1 sync duty, integration-branch merges;
  (2) **REBASELINE** — pi 1.0 changed memory-relevant behavior (shrink
  codemode prompt, fullscreen TUI default, durable Package 21) so the
  MS-04 table is STALE for 1.0: p3 + p4 re-run the mem-probe baseline +
  conformance on the 1.0 build (staged behind the G4 calm window — the
  calm protocol stands); (3) S1 PR reframe onto the v1.0.0 base (p4);
  (4) **fleet pin moves 0.99.0 -> 1.0.0 VIA OUR FORK BUILD** (npm lacks
  1.0; git source is the only route = exactly the ADOPTION plan above,
  R3 owns the pin flip, gate: Delta row + conformance green).
