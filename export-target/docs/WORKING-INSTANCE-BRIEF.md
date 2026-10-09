# W-track — working-instance memory (02/10/2026, Pedro directive)

Pedro: "I am talking about working instances as well - too many performance
gains to have." The idle track (A/C/D) is NOT the whole program. Working seats
sit at 185.6 MiB mid-turn (fleet), 244.2 (home-projects), and the growth ledger
names the class: work-content retention +45.8 MiB, UI caches 68% of heap
growth, residual = peaks + stranding. S11 was an honest negative on worked
seats (±0.4-2.0 = noise) - the worked cohort needs its OWN attack.

## What a working seat actually pays (measured classes)

1. **Retained conversation content** — the +43.5 MiB settled growth on a
   706-entry worked session; shared message content 3.2 MiB class; full-history
   resend (`mode=Full`) re-materializes everything per turn.
2. **Mid-turn peaks + stranding** — MS-04-v2 residual; GC-lag refuted but
   22 MiB committed slack shrinkable via heap caps; peaks are what swap hits.
3. **Working render caches** — S9/S11 win is one-turn-cohort only; worked-seat
   eviction at settled points did not move the needle. Mid-turn shape unknown.
4. **Tool/MCP payload retention** — tool results, previews, codemode artifacts
   kept in session objects.
5. **Extension/agent runtime state** during active work.

## Directions to analyze and implement

- **W1 context retention**: compressed/off-heap message content WHILE working
  (E is this - raise priority to working-instance #1). Lossless only; kill-9
  byte-identical.
- **W2 compaction + overflow**: upstream Package 20 is literally this - adopt
  it, tune thresholds for 300-seat fleets, measure the worked cohort.
- **W3 mid-turn cache policy**: eviction during a turn (not just settled
  points), preview caps (upstream capped codemode/MCP previews - extend).
- **W4 peak shaping**: heap caps + arena caps sized for turn bursts; stranding
  reclaim after turns (T2 getEntries() copy churn named as target).
- **W5 resend/compaction mode**: full-history resend -> delta/windowed resend
  where the transport allows; measure per-turn cost.
- **W6 A-shared-runtime active-session cost**: the marginal cost of a WORKING
  session in the shared isolate (the 5-15 MiB bracket is idle; worked bracket
  unknown).

## Deliverables (same binding rules)

`docs/WORKING-W<N>.md` per direction: measured ceiling on the WORKED cohort
(mid-turn PSS+SwapPss + peaks), effort, matrix row, PR shape, GO/NO-GO.
Baseline row: MS-04 mid-turn 185.6 / home-projects 244.2 / +45.8 growth class.
