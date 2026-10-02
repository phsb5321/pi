# FEASIBILITY — E: session state off-heap / compressed (durable path)

Fork-only doc (memory-sound program), 01/10/2026 21:3x BRT, owner w28:p8
(assigned by p2 21:21; brief had named p6). Never PR this file upstream.
Binding rules apply at claim time: every implementation claim ships the
`docs/PROGRAM-RULES.md` trio (mem-probe table idle+mid, kill-9 conformance,
matrix row); bars per the class-point rule. Class labels per R1 ARTIFACT1:
the replay-delta non-heap remainder is the **glibc arena/brk class**
(10.5–15.2 MiB/seat; thread stacks ≈ 0.25 MiB) — the earlier "stack class"
label is refuted and is NOT part of this row.

---

## Attack

Stop retaining the whole conversation as decoded JS objects in the V8 heap:
**window + compress + spill** the session state through the upstream durable
path (`packages/durable` Package 20 compaction + overflow), materializing
messages on read. Two mechanisms, one facade:

1. **Compressed spill for old entries** — decoded message objects for entries
   outside the working window are dropped; the canonical bytes live once in
   the Session writer (already on disk) or an in-RAM lz4/zstd blob
   (`node:zlib` deflate/gzip built-in; lz4-class libs for latency). Read path
   decodes on demand into the same object shapes.
2. **Off-heap backing for buffers** — image/tool buffers already sit in
   `external`/ArrayBuffer (flat across the replay arms, +0.0 MiB); string
   prose is the compressible class. Off-heap alone frees V8 heap, not RSS —
   **compression is the RSS lever**, off-heap is the GC-pressure lever.

Evidence base (all cited rows measured on this host):

| datum | value | source |
|---|---|---|
| worked-session growth (+45.8 MiB/10.5 h class) | live heap +22.3 (UI caches 15.06 / shared message content 3.2 / engine 2.2–3.4 / H3 0.2) + non-heap 23.6 (arena/brk per R1) | growth ledger + run-3 split, `MS-21-growth-ledger/close-2026-10-01.md` |
| conversation-shaped content per 706-entry seat | ≈ 8–10 MiB self-bytes (prose+json+wrappers, shared classes) | replay analysis, p3 object pass |
| long-lived fleet cohort (88 seats, 0.5–5.1 d) | P50 167 MiB total vs fresh 62–99 | MS-03 |
| JSONL on disk | 2.9 MiB / 706 entries | replay fixture |
| external/arrayBuffers | 0 Δ across replay arms | run-3 `memoryUsage` |

## Field table

| field | |
|---|---|
| **Measured ceiling** | Compressible class = conversation-shaped state (prose/json/entry JSON), 8–10 MiB per heavy seat and 1–5 MiB per light seat. At typical text compression 3–6× (lz4/zstd-class; **ratio unmeasured on pi transcripts — first acceptance gate item**): save ≈ 6–8 MiB/heavy + 1–4 MiB/light. Fleet (88 long-lived + 218 young): **≈ 1.2–3.5 GiB**, and the **growth-curve cap** prevents recurrence of the +45.8 MiB/10.5 h class on worked seats (value grows with fleet workload). Ceiling rounded to the compiled row's **1–4 GiB + cap**. If measured ratio < 2× or decode CPU > ~2% of a turn, ceiling drops below 1 GiB → NO-GO. |
| **Effort + risk** | Effort **M** (storage windowing + decode-on-read + conformance). Risk **M**: (1) **restore correctness** — branch/leaf semantics are already load-bearing (MS-22: `resetLeaf()`/branch-only navigation not persisted; tip reopen works) and kill-9 byte-identical restore is a RULE-2 artifact; (2) identity/aliasing — decoded-on-read must pin exposed objects (§11 contract #4); (3) CPU latency on scroll/read paths; (4) interplay with eviction (double-free of decoded state must not lose the canonical bytes). |
| **Matrix row** | **invisible** when only backing storage changes (same API, same objects, identity pinned while exposed; §11 candidate #4). Becomes **opt-in hook** the moment decoded state is evicted while plugins may hold references — then `onQuiesce`/`onResume` (§11 proposal) is the contract. Not forbidden. |
| **Upstream PR shape** | Mechanics are U3 (transparent windowed storage behind the Session/JSONL surface); the spill policy default is U2 (maintainer input on when/how far to window). Shape: U3 PRs for compressed backing + windowed read path in `packages/agent` harness storage; U2 issue for the default policy; fork carries fleet tuning. The candidate is already in the plan's backlog ("Stop retaining whole session JSONL in RAM — windowed/spilled reads via durable compaction+overflow (Package 20)"). |
| **Dependencies** | `packages/durable` Package 20 (compaction + overflow — landed upstream); S9/S10 windowing shares the pot with B3/S11 (render side) — E is the state side, no ownership overlap; idle-eviction family (row A eviction pairing) for the full growth cap; kill-9 conformance harness (`packages/agent/src/harness/session/testing/conformance/`) with a transcript-compression case; measured compression ratio + decode-CPU gate (first acceptance item); mem-probe tables per rules. |
| **GO/NO-GO** | **CONDITIONAL-GO** (order #5 in the compiled sequence: after F2 adoption, before A). Conditions: (1) measured ratio ≥ 2× on real pi transcripts (owned fixtures only — G-03 discipline extends: private payload stays on-host); (2) kill-9 byte-identical conformance passes with compressed state (same transcript, same restored plugin-visible state); (3) decode CPU bounded mid-turn (memory table's mid-turn column must not regress by more than the measured noise S); (4) matrix row accepted as **invisible** (or **opt-in hook** with the quiesce contract if decoded-state eviction ships). |

## Why now (and why it is not B3/S11 or C)

- **B3/S11 windowing** removes render-side retention (the 15.06 MiB UI-cache
  class); **C** removes the arena/brk class (3.1–4.5 GiB compiled). E removes
  the **state** class and is the only lever that **caps the growth curve**:
  windowed+spilled conversation stops the 706-entry trajectory regardless of
  render implementation. The three compound; none substitutes.
- The upstream durable path already exists (Package 20 compaction+overflow;
  Session writers own canonical bytes) — E is adoption + policy, not new
  machinery, which is why its U-rank splits U3/U2 that way.

## Shared conclusion

E is the growth-curve cap with a modest immediate ceiling (1–4 GiB) and the
strongest conformance story of the tier (the byte-identical kill-9 artifact is
already the program's rule-2 gate). GO it at position #5 — behind the cheap
env/pin wins, ahead of the shared-runtime bet — provided the compression ratio
and decode-CPU gates measure in. If the ratio fails, E shrinks to a U3
windowed-read-only slice and the cap is partially delivered by B3/S11 anyway.
