# Memory reference table — MS-04 fleet baseline (30/09/2026)

**This is the reference table the memory-sound program is measured against.**
Every memory claim ships a before/after delta citing this file's rows. Format
per `MEMORY-SOUND-PLAN.md` §Memory table format (the only accepted evidence).
Fork-only evidence document — never PR this file upstream.

- **Sample:** 30/09/2026 14:47:35 BRT · host `desktop` · kernel 6.12.108
- **Cohort:** full census — every `/proc` pid with `comm == pi` at one instant,
  306/306 matched (4 idle <5 min, 4 done/unknown, 1 pane-mismatch recorded
  separately; none dropped). pearson + platform hold 0 pi seats.
- **Instrument:** `/proc/<pid>/smaps_rollup` (Pss + SwapPss, never summed RSS),
  joined to per-session `herdr api snapshot` agent status. Probe v2 pinned at
  `1. Projects/Memory-Sound Program/evidence/MS-04/probe-v2.py` (vault).
- **Definitions:** idle = agent status `idle` AND last session write ≥5 min;
  mid-turn = agent status `working` (tool-executing turn). smaps→snapshot skew
  ≤2 s. SwapPss reported separately and summed; **heavy-swap host** (48 GiB
  swap, 35 GiB committed at sample time).

## The table (per-seat mean MiB; baseline row per plan)

| variant (commit/branch) | probe | n seats | idle PSS MiB | idle SwapPss MiB | mid-turn PSS+SwapPss MiB | Δ vs baseline |
|---|---|---|---:|---:|---:|---|
| side-projects | smaps_rollup v2 | 113 (91 idle / 20 mid) | 141.9 | 35.6 | 180.7 | 0 (baseline) |
| delicasa | smaps_rollup v2 | 87 (86 idle / 0 mid) | 95.0 | 0.0 | — | 0 (baseline) |
| home | smaps_rollup v2 | 46 (45 idle / 1 mid) | 120.5 | 36.5 | 165.5 | 0 (baseline) |
| home-projects | smaps_rollup v2 | 48 (40 idle / 2 mid) | 104.6 | 32.8 | 244.2 | 0 (baseline) |
| study | smaps_rollup v2 | 11 (11 idle / 0 mid) | 74.5 | 41.4 | — | 0 (baseline) |
| swarm | smaps_rollup v2 | 1 (1 idle / 0 mid) | 29.2 | 74.5 | — | 0 (baseline) |
| **FLEET** | smaps_rollup v2 | **306 (274 / 23)** | **115.1** | **24.5** | **185.6** | 0 (baseline) |

idle PSS+SwapPss (sum) column: side-projects 177.5 · delicasa 95.0 ·
home 157.0 · home-projects 137.4 · study 116.0 · swarm 103.7 ·
**FLEET 139.7 MiB/seat**.

## Per-session totals + distribution (PSS+SwapPss)

| session | n | total GiB | idle GiB (n) | mid-turn GiB (n) | idle P50/P90 MiB | mid P50/P90 MiB |
|---|---:|---:|---:|---:|---|---|
| side-projects | 113 | 19.58 | 15.78 (91) | 3.53 (20) | 155.7 / 246.1 | 150.6 / 252.6 |
| delicasa | 87 | 8.06 | 7.98 (86) | — | 93.6 / 106.5 | — |
| home | 46 | 7.06 | 6.90 (45) | 0.16 (1) | 148.0 / 217.7 | 165.5 / 165.5 |
| home-projects | 48 | 7.03 | 5.37 (40) | 0.48 (2) | 117.2 / 174.8 | 244.2 / 283.5 |
| study | 11 | 1.25 | 1.25 (11) | — | 109.3 / 129.5 | — |
| swarm | 1 | 0.10 | 0.10 (1) | — | 103.7 / 103.7 | — |
| **FLEET** | **306** | **43.08** | **37.37 (274)** | **4.17 (23)** | **129.2 / 206.2** | **151.3 / 281.4** |

Fleet split: PSS 35.68 GiB + SwapPss 7.40 GiB (swap share 17.2 %).
Distribution (all seats, MiB/seat): p10 90.6 · p50 136.2 · p90 216.3 ·
max 588.6. Histogram: 50-75:1 · 75-100:76 · 100-125:61 · 125-150:58 ·
150-200:71 · 200-300:28 · 300-500:9 · >500:1 (bimodal).

## Age bands (use for age-matched deltas; see plan log 30/09)

Idle mean by seat start-day (observation): started 27/09 → 173.5 MiB (n=77) ·
29/09 → 146.5 (n=106) · 30/09 → 99.1 (n=88). The cohort-aware M0 targets from
the plan log use these bands: **fresh same-day seat ≈99 MiB**,
**long-lived side-projects cohort 177.5–181.5 MiB**. Attribution of the growth
to seat age (vs wrapper generation — desktop switched NixOS at 08:07 / 08:23 /
13:33 the same day) is unresolved and belongs to M1's heap snapshot.

## Evidence (raw pid lists, cited per plan)

- `~/Documents/Notes/1. Projects/Memory-Sound Program/evidence/MS-04/cohort-pids.txt` — 306 pids at sample instant
- `~/Documents/Notes/1. Projects/Memory-Sound Program/evidence/MS-04/per-pid.jsonl` — per-pid PSS/SwapPss/RSS, session, pane, state, start_epoch, last-write age
- `~/Documents/Notes/1. Projects/Memory-Sound Program/evidence/MS-04/summary.json` — machine-readable tables
- `~/Documents/Notes/1. Projects/Memory-Sound Program/evidence/MS-04/probe-v2.py` — pinned instrument
- Secondary all-fleet instant (14:44, unclassified): `~/Documents/Notes/1. Projects/Herdr Fleet Coordination/evidence/2026-09-30-pss-baseline/`

Method discipline (from `Fleet memory cohort measurement — 2026-09-19`):
cohort defined at one instant with the pid list written to a file; `start_epoch`
captured at sample time (`ps -e` etimes — without `-e` the sweep silently sees
only the caller's terminal); environ read is whitelisted (HERDR_SESSION,
HERDR_PANE_ID only — no secrets leave /proc); snapshot join keyed
(session, pane_id) because short pane ids collide across sessions.
