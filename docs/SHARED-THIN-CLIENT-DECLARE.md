# DECLARE — thin-client slice (T3/T5 client leg), 04/10/2026 11:0x BRT (w28:pD)

Branch `ms/shared-session-host` — DECLARE-CHECKLIST line 1: push + `ls-remote` VERIFY (see run log in the seat's report). Ordinary PR body below; **MS-05 gate note: parks behind the MS-05 upstream gate until `lgtm` — no upstream PR opened from this declare.**

## PR body (ordinary)

`feat(client,coding-agent): thin-client leg for the shared-host canary`

- `packages/client/src/client-attach.ts` — headless attach driver over the
  existing `Client`/protocol stack: `attachSession`/`attachSessions` (one
  connection per hosted session, per the one-route-per-connection server
  contract), `createClientServiceTransport`-backed per-attachment service
  transports, `detach` semantics, `requireSessionTarget`.
- `packages/client/src/thin-client.ts` — the real `ThinClient` leg on p4's
  published factory shape (`(sessionId, invoke) => ThinClient`): serialized
  submits (transcript order = submit order), idempotent close with drain +
  post-close rejection, observe payload validation; `createSessionInvoke`
  bridges a chord transport into the factory's `invoke` shape. Members stay
  `submit`/`observe` exactly as the landed engine serves them — **no seam
  adjustment**.
- `shared-host-canary.ts` — surgical plug only: call site uses
  `createThinClient` from `@earendil-works/pi-client` (declared dep);
  `syntheticThinClient` remains the labeled exported provider stand-in on
  the same seam.
- Tests: `client-attach-contract.test.ts` (6 cases — two-session attach +
  echo/state isolation round-trips, idempotent attach incl. racing
  duplicates, **stale-route rejection**, detach semantics, route switch) and
  `thin-client.test.ts` (5 cases — round-trip, concurrency ordering, close
  semantics, payload validation, wire-bridge shape).

**Default OFF** (nothing constructs these outside tests or the explicit
canary/entry), synthetic provider only, **zero paid calls**, no model or
provider graph in the client path. **Measured honesty: this slice makes no
memory-savings claims** (the canary prints measured mem-probe values only).

## Five-artifact discipline (applicable set)

| artifact | status |
|---|---|
| memory measurement | **APPLICABLE — filed**: canary `mem-probe v1.2.2` measured print, whole process = 46.4 MiB PSS + 0.0 SwapPss (3 engines, 4 presentations through the real leg; advisory idle row, proof-BAD = session-less process as documented in the canary). No estimates, no savings claims. Whole-client inventory for p3: `docs/SHARED-CLIENT-PROCESS-INVENTORY.md` (005 worktree). |
| conformance (server semantics) | **APPLICABLE — green**: attach idempotency (re-attach + racing duplicates, exactly one `attachment` publish) + stale-route rejection (superseded `attachmentId` refused) per T5; mirrored from `SessionRouter.attachClientNow` contract. |
| kill-9 / recovery | **N/A client-side with rationale**: the leg holds no durable state (transient invoke wrapper; `close` = presentation teardown); host-side kill-9 → durable resume is T5's falsifier lane (p4/p2). |
| golden-frame probe | **N/A**: no TUI render surface in this slice. |
| identity / custom-component probes | **N/A**: no eviction, capture/restore, or component surface in this slice. |

## Results (desktop job slots, 04/10)

- `test/client-attach-contract.test.ts` **6/6** (11:02)
- `test/thin-client.test.ts` **5/5** (03:01) · `test/client.test.ts` **15/15** (regression)
- `shared-host-canary.ts` **ALL PASS** with the real leg (3 engines / 1 pid,
  4 presentations, isolation asserts, measured print, exit 0) — 03:03.

Known environment note: vitest runs of ≥3 forked files hit this desktop
slot's worker-teardown timeout; every suite is green individually and the
offhost lane (root) runs the full matrix per MANIFEST acceptance commands.
