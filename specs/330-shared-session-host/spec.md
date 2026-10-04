# Spec 330 — in-process shared session host (default OFF)

## Problem

Per-seat pi processes cost a private baseline each (~46–90 MiB; fleet 43 GiB).
A-marginal measurement (p3, `MS-RESEARCH-A-marginal-2026-10-02.md`) shows one
shared isolate hosting N sessions costs a **74.4–87.2 MiB floor once** plus a
per-session marginal of **0.292 MiB (minimal) / 1.230 MiB (E-class compressed)
/ 4.995 MiB (worked live state)** — 306 worked sessions ≈ 1.62 GiB vs 18.6 GiB
worker-isolated. Thin presentations are mandatory (per-presentation TUI ≈ 53
MiB is the binding constraint).

## Capability (what this slice delivers)

1. **One real in-process session host** — a host entry that constructs and
   runs N durable sessions inside a single Node process (one V8 isolate),
   using the existing `packages/server` protocol (`RoutedServerServiceHost`,
   `SessionDirectory`/`SessionManagement` application-owned,
   `RoutedSessionHandle.attachClient()`, unix transport).
2. **Thin clients** — `packages/client` attachments to hosted sessions
   (presentation-scoped), no per-presentation runtime.
3. **Default OFF** — the host is opt-in (explicit flag/env); normal pi
   startup is byte-identical when off.
4. **Executable synthetic-provider multi-session canary** — boots the host,
   creates ≥3 sessions, attaches ≥2 thin clients, runs scripted turns on a
   synthetic/faux provider (zero paid calls), asserts session isolation
   (separate transcripts, no cross-session state), and prints measured
   values only (p3's printer discipline).

## Constraints

- Behavior-identical when off; privacy/model constraints preserved; repository
  gates unchanged; no fleet activation until measured; no session/model resets
  in tooling; preserve PR4 and other WIP; ordinary PR only.

## Acceptance (static/offline)

- `npm run check` green; relevant offline suites green (server, client,
  durable, coding-agent harness).
- Canopy: the canary runs offline (synthetic provider), asserts isolation +
  attachment semantics (idempotent attach, attachmentId routing), exits 0.
- Isolation/recovery falsifiers (p9 contract): host kill-9 leaves session
  state resumable (durable resume), and a lost connection releases
  attachment only after admitted calls settle (server protocol semantics).
- Memory measurement hooks (p3 contract): the canary emits per-session and
  total PSS+SwapPss via `tools/mem-probe` when present (informational;
  no savings claim is booked by this slice alone).
