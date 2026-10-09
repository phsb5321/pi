# Measurement-overhead policy — W-track M1 (02/10/2026)

Owner: coordinator seat. Governs every measurement this program runs.

## The discipline (binding)

1. **Bounded cohorts, staggered.** No sweep touches all seats in one window.
   mem-probe samples a bounded cohort (default ≤10 seats) per run; the cohort
   rotates across windows so coverage is complete over time, not instant.
2. **Caps on every instrument.** Runtime timeout (default 30 s per run), output
   cap (receipt-sized, not raw dumps), CPU/IO niceness (`nice`/`ionice`), and a
   RAM ceiling for the probe process itself. Host job-slot admission applies on
   top (desktop-job-slot.service).
3. **No wave operations.** Forbidden shapes: all-seat smaps sweeps, parallel
   rebuild waves, fleet-wide conformance replays, batch session/process
   termination. Conformance runs one seat at a time; rebuilds are serial.
4. **Receipts and source first.** While the host slot is contested, report from
   git history, receipts and plan docs — not fresh measurement. Exact commits
   beat impressions.
5. **Hypothesis discipline.** "The measurement machinery is the dominant IO
   consumer" is a **hypothesis**, not a finding. It is evidenced only by
   per-job-slot cgroup interval data (pressure.stat `io` deltas attributed to
   the instrument), collected within the caps above. Until then, planning
   treats IO contention as multi-source (fleet work + measurement + host).

## Known timer/sweep inventory (receipts-based, 02/10 19:00)

| source | cadence | notes |
|---|---|---|
| `throttle-lanes.timer` | 15 min | lane meter probe, writes `/run/user/1000/throttle-lanes.json` |
| `anthropic-throttle-proxy-keepalive.timer` | ~seconds | watchdog |
| seat ad-hoc mem-probe sweeps | event-driven | W-track measurement; **this policy caps them** |
| conformance replays (kill-9) | per slice | must run one-at-a-time under this policy |
| rebuild/build waves | per slice | serial only; never fleet-wide |

## Acceptance (measured overhead)

The smallest tested PR must show, on a bounded cohort: probe overhead (wall,
CPU, IO delta) at or under the caps, and zero host pressure-gate refusals
during the run. Evidence goes in the PR receipt, not in prose.

## Desktop & Server Ops inclusion

The `🖥️ Desktop & Server Ops` workspace is part of the durable resource plan:
its jobs (rebuilds, server ops, RAM work) join the stagger schedule and the
caps. Public implementation is coordinated with Infra (`home/w1W:p12`); private
coordination records live in the vault.
