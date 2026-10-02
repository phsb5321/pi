# WORKING-W2 — Compaction + overflow (Package 20 adoption), 02/10/2026 (pD)

Direction per `docs/WORKING-INSTANCE-BRIEF.md` (plan bf5659c3e): adopt
upstream **Package 20** (`packages/durable` compaction + overflow), tune
thresholds for **300-seat fleets**, measure the worked cohort.

## What already exists (the Package 20 ride — no new mechanism)

- `CompactionPolicy` (`packages/durable/src/harness/types.ts:369-379`):
  `reserveTokens: 16384`, `keepRecentTokens: 20000`,
  `backgroundTokens: 32768` (defaults `harness/agent.ts:27-29`).
- Threshold + overflow compaction: generation blocks to compact above
  `contextWindow - reserveTokens`; overflow forces a blocking compaction
  (`harness/generation.ts:479-497`); background compaction starts
  `backgroundTokens` below the threshold.
- `selectCut`/`summarizedMessages` (`harness/compaction.ts:253-305`): keeps
  `keepRecentTokens` verbatim, summarizes the cut-away prefix.
- LiveDoc checkpoints whenever idle (`harness/live.ts:74-75`); in-flight
  tool output already bounded (`harness/truncate.ts:11-12`: 2000 lines /
  50 KB, `droppedBytes/droppedLines` recorded).

**The gap:** compaction bounds what the *model* sees; working interactive
seats still keep the *whole session* in RAM (T1 whole-file read + parsed
objects 1-1.5× file bytes, MS-22 cost model). The adoption is memory-side:
release summarized-away entries from RAM and read the tail via
windowed/spilled reads (MS-21's windowing model: skeleton-always +
full-entry window).

## Measured ceiling — worked cohort (02/10, pD)

Baseline rows (plan): mid-turn **185.6 MiB** (fleet) / **244.2**
(home-projects) / **+45.8** growth class. G4 worked cohort (n=6, 2.1 MB
493-entry seed, mem-probe v1.2.2): mid-turn PSS+SwapPss **125.2** baseline /
**120.1** bundle (sampled mid max 128.1/124.1; true peak capture lands with
W4 — `peak_at` is dead code today).

Corpus measurement (30 worked sessions sampled of 443 ≥200 KB on this host,
903 files total; metrics only):
- Retained content: p50 **5.8 MiB**/seat, p90 **46.6**, max 304.0
  (≈1–1.5× file bytes — MS-22 consistent).
- Tool-result payload share: p50 **5.0 MiB = 86 %** of retained (p90 95 %).
- Conversation content: p50 1.4 MiB, p90 2.9.
- **Compactable class** (retained − keep window): p50 **5.7 MiB**/seat,
  p90 **46.5** → 300-seat fleet **1.7 GiB (p50) / 13.6 GiB (p90)**
  attackable vs the **≤4 GiB bar** (p90 fleet is 3.4× over the bar without
  this tier).

Post-adoption target: keep window (20 k tokens ≈ 80 KiB) + summary + capped
tool previews + byte-sized full-entry window ⇒ **~2–4 MiB/seat** conversation
state ⇒ 300-seat fleet **0.6–1.2 GiB** (fits the bar with the other tiers).

## Threshold tuning for 300-seat fleets

| knob | upstream default | fleet proposal | why |
|---|---|---|---|
| `keepRecentTokens` | 20000 | **8192–16384** | keep window is per-seat resident; 20 k tokens × 300 seats ≈ 24 MiB of verbatim tail alone |
| `backgroundTokens` | 32768 | **16384** (compact earlier under fleet load) | burst contention: 300 seats crossing threshold together |
| `reserveTokens` | 16384 | keep | answer headroom is correctness, not memory |
| MS-21 entry window | 300 entries | **byte-sized (≈512 KiB) + 300-entry cap** | entry counts mis-price tool-heavy sessions (86 % tool bytes) |

Compaction trigger timing is the overflow spike guard: blocking compaction
on a 100+ MiB turn payload is a peak event (see W5) — background compaction
earlier is also peak shaping (W4 interlock).

## Effort / risk

**Effort M** (2 slices: windowed/spilled read path; compaction-triggered
RAM release of summarized-away entries). Risk: none to behavior — JSONL
path unchanged ⇒ kill−9 byte-identical by construction (FEASIBILITY-E
standard); summarization semantics are existing upstream policy, not
changed here. Storage-conformance harness class exists.

## Plugin matrix row

**invisible** (substrate behind the existing Storage/session interfaces —
same surface, different substrate). Evidence gate: `storage-conformance`
suite + kill−9 parity + held-reference identity probe (S3 standard).

## PR shape

**U3** on the Package 20 rail, two reviewable slices behind existing
interfaces (separate PRs per slice). Rides upstream momentum (`packages/durable`
is upstream's own home for this). Changelog per package, parks behind MS-05
until `lgtm`.

## GO/NO-GO

**GO** — the mechanism exists upstream, the ceiling is measured (5.7/46.5
MiB/seat; 1.7–13.6 GiB fleet), the bar math needs it at p90. NO-GO for any
lossy variant of the release path (byte-identical resume is the gate).
