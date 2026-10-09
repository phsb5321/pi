# FEASIBILITY — A: shared runtime (one node process, N sessions)

Fork-only doc (memory-sound program), 01/10/2026 20:2x BRT, owner w28:p5
(reassigned from p1 per dispatch). Never PR this file upstream. Binding
rules apply at claim time: every implementation claim ships the
`docs/PROGRAM-RULES.md` trio (mem-probe table idle+mid, kill-9 conformance,
matrix row); bars per the class-point rule (exposure-controlled gate runs
set points; single runs never do).

**p3's marginal-RSS number is PENDING** — the ceiling rows below are
formulas with labeled ESTIMATED bounds; the class point lands when p3's
number + a controlled run arrive.

---

## Attack

One node process serves N sessions through `packages/server`
multi-presentation attach (upstream's own experimental architecture:
`RoutedServerServiceHost.attachClient()` per connection,
`RoutedSessionHandle.attachClient()` per presentation, opaque envelope
routing, application-owned `SessionDirectory`/`SessionManagement`,
per-session **worker + Session-writer ownership**). Critically, the
**worker model is host-owned** — server/durable contain no
worker_threads/child-session runtime (the `child_process` spawns in
`durable/src/env/node.ts` are tool-env execution only). The marginal cost
per session is therefore a **design parameter we choose**:

| worker model | marginal/session | verdict |
|---|---|---|
| in-process (sessions share one isolate) | EST. 5–15 MiB (session + conversation state; extensions share module state) | best ceiling |
| worker_threads per session | EST. 15–30 MiB (isolate floor per session) | weaker; better isolation |
| child process per session | ≈ standalone seat | **NO-GO — no win** |

## Field table

| field | |
|---|---|
| **Measured ceiling** | Base = one node + one evaluated app graph, **EST. 60–80 MiB** (bare node 45–60 measured + graph once) + N × m. At N=16, in-process: **≈ 10–30 MiB/seat → fleet 3.06–9.2 GiB** (306 seats) vs 43.08 GiB today and the brief's ~40 MiB/seat current-stack floor. At N=8: ≈ 15–35 MiB/seat → 4.6–10.7 GiB. **Formula, not a point: the class point = base/N + p3's marginal (PENDING).** If marginal ≥ ~25–30 MiB the ceiling loses to the current stack → NO-GO (see verdict). |
| **Effort + risk** | Effort **L** (host binary + TUI attach client + supervisor + per-session isolation audit + conformance rework + probe rework). Risk **H**: (1) **crash blast radius** — one process holds N sessions; a crash kills in-flight turns of all attached sessions (committed state survives via Session writers; kill-9 conformance is the artifact); mitigations: shard cap N≤8–16, supervisor respawn + re-attach, worker isolation if chosen. (2) plugin process-global observability (below). (3) upstream API churn (server is experimental). (4) per-session env/cwd/PI_* conventions are per-process today. |
| **Matrix row** | **needs restart** — same plugin surface, different substrate, but extension code runs in a process shared with other sessions and CAN observe it (globalThis/module-registry state shared, `process.*` shared, env/cwd semantics change). Not forbidden (no API break). Escalation path: per-conversation extension isolation (durable Package 21: extensions and per-conversation agents) could earn **opt-in hook** later; that is a separate row + G-ruling. |
| **Upstream PR shape** | **Strongest PR-ability of the structural tier — it is upstream's own architecture** (adoption, not invention; MS-24's charter line). Shape: U2 issue first (adopt `packages/server` as the coding-agent runtime model), then U3 slices: TUI attach client mode (`pi --attach`-class), host wiring, multi-presentation attach/reattach conformance, worker-retirement + Session-writer ownership hardening. U1 fleet side: supervisor, sharding, Nix pin. |
| **Dependencies** | `packages/durable` (Package 20/21 — landed); `packages/server` + `packages/client` (experimental); host supervisor design; **mem-probe per-session attribution rework** (the seat-tree model breaks when one process holds N sessions — needs harness-receipt attribution); p3's marginal-RSS number (PENDING); p6's multi-presentation kill-9 conformance shape; fleet supervisor + Nix pin (U1); upstream buy-in (U2 issue). |
| **GO/NO-GO** | **CONDITIONAL-GO** as the M3 structural track (does not jump the S9/S11 measured wins). Conditions: (1) p3's marginal lands **≤ ~25 MiB/session** (else the ceiling loses to the current stack → **NO-GO**); (2) the **needs-restart** matrix row is accepted for the fleet (Pedro arbitration) with G-ruling on any extension-surface shift; (3) blast-radius mitigations (shard cap, supervisor respawn + re-attach, kill-9 conformance) land in slice 1; (4) probe attribution rework lands before any claim. |

## TUI attach model

Presentation-scoped attach over a unix socket; a Session may carry multiple
presentations (attach idempotent, stale/mismatched routes rejected,
`attachmentId` routing-only). The TUI becomes a thin client: attach →
render → detach; **presentation loss ≠ session death** — worker retirement
is host-decided at zero presentation demand + quiescent harness. This
composes with the eviction family (MS-22): an idle session can retire its
worker/attachment while the conversation lives in the Session writer.

## Crash blast radius (the operational risk)

Today: crash = 1 seat. Shared: crash = N sessions' in-flight work (data
durable; resume = re-attach). The blast-radius row is why the verdict caps
shard size and demands supervisor respawn + kill-9 conformance in slice 1.
Session writers + `captureRenderState`-class state are exactly the
resume-correctness surfaces the rules' conformance artifact already covers.

## Shared conclusion

Shared runtime is the only structural attack that removes the per-seat
node+graph cost instead of shaving it — and it rides upstream's own
roadmap, so its PR-ability is the strongest in the tier. Its ceiling is
real (10–30 MiB/seat vs the ~40 current-stack floor) but conditional on
p3's marginal number and on surviving the plugin/blast-radius scrutiny as
a **needs-restart** change. Sequence it as M3 behind the measured class
wins; kill it outright if marginal lands ≥ ~25–30 MiB/session.
