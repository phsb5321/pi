# Shared-process worker slice — opt-in, bounded, retiring (004-shared-process)

Fork-only slice (memory-sound track A, FINISH-0310-1644). Implements the
smallest deployable **opt-in** step of the shared-runtime direction from
`docs/FEASIBILITY-A.md` on top of the existing experimental
`packages/server` / `packages/protocol` support — no server, router,
protocol, durable, TUI, or coding-agent change.

## What it is

`createSharedProcessHost(inner, policy)` decorates an application's
`ServerHost` (the seam the upstream server already calls for every hosted
Session) so sessions are admitted as bounded shared-process workers:

| guarantee | mechanism |
|---|---|
| **opt-in only** | composition at the host boundary; nothing in the server changes behavior unless the application passes its host through the decorator. Zero process/thread spawns, zero signals — **occupied seats are unreachable by construction**. |
| **bounded** | explicit hard `maxWorkers` cap (required; no implicit default), enforced with pre-await reservations (pending opens hold their slot; concurrent same-session opens share one inner open). Policy values are validated (positive finite integer `maxWorkers`, finite `retireAfterIdleMs >= 0`, and `isHarnessIdle` is REQUIRED whenever retirement is enabled — harness idleness is host knowledge, never assumed). Invalid: `SharedProcessPolicyError`. Over capacity: `SharedProcessCapacityError`, `onWorkerRefused` hook. Capacity is released only on successful close or actual termination — a rejected close keeps the slot held (no live-worker + replacement overshoot). |
| **isolated** | one `WorkerSlot` per session; contexts pass through verbatim (never pooled across sessions — privacy: per-session credential contexts cannot cross); identity `{sessionId, generation, openedAt, model:"in-process"}` per worker (`generation` = globally monotonic open sequence — bounded memory, no per-id ABA) for mechanical cohort grouping. |
| **retirement** | retire when: zero presentation demand, zero in-flight service ops, zero in-flight attaches (race guard), and the host's `isHarnessIdle(identity)` predicate is true — the "host decides when zero presentation demand and worker-local Harness activity permit worker retirement" line of the server README, made executable. Window = `retireAfterIdleMs` (0/omitted = upstream's never-retire). Opt-in `onBeforeRetire`/`onAfterRetire` hooks (plugin-break catalog: worker retirement hooks); hook/close failures surface on `onError` and are never unhandled rejections. |
| **crash parity** | `terminated` passes through byte-identical to the upstream contract: a Promise that **resolves with the Error** on unexpected termination, and resolves `undefined` on expected close (explicit close AND retirement). A terminated session's slot is released immediately; other slots are untouched. Once a close has begun, `attachClient` fails closed (`SharedProcessClosingError`) — a client never receives a closing worker; an attach that lands BEFORE the close commit still cancels a pending retire. |

## Plugin matrix row (per FEASIBILITY-A)

**needs-restart** — same plugin surface, different substrate: extension
code running in a shared process can observe process-global state
(`globalThis`, module registry, `process.*`). No API break. The retirement
hooks above are the row's upgrade path (opt-in hook) together with
per-conversation extension isolation — that is a separate row + G-ruling.

## Parity claims (the executable regression)

`test/shared-process.test.ts` (vitest) pins, not asserts-by-hand (12 cases):

1. opt-in composition + cap enforcement + refusal hook + no spawn surface;
2. isolation: per-session lease routing and strict context separation;
3. retirement: idle worker retired within the bounded window (retirement
   schedules at open), attached/harness-busy workers never retire, expected
   close resolves `terminated` with `undefined`;
4. crash parity: unexpected termination **resolves** `terminated` with the
   Error, frees only that slot, reopen opens a fresh inner handle;
5. explicit close = expected close + slot returned to capacity;
6. cap held under concurrent delayed opens (pre-await reservation);
7. concurrent same-session opens share one inner open; failed pending opens
   clean up their reservation (capacity returns);
8. policy guards: Infinity/NaN/fraction/negative rejected
   (`SharedProcessPolicyError`); retirement without `isHarnessIdle` refused;
   `retireAfterIdleMs` above Node's 2^31-1 timer limit rejected (no
   surprise 1ms clamp retirement); 2147483647 accepted;
9. attach-during-retirement race aborts the retire; hook failures reach
   `onError` (never unhandled rejections) and the worker stays usable;
10. deferred-close race: attach after the close commit is fail-closed
    (`SharedProcessClosingError`), attach before it cancels the retire;
11. capacity held when close rejects; freed only on success or actual
    termination;
12. busy→idle re-arm: a busy harness at timer fire (entry gate) or after
    the hook (post-hook recheck) re-arms one bounded idle timer and retires
    once the harness goes idle — even with zero attachment events.

## Integration (opt-in)

```ts
import { createSharedProcessHost } from "@earendil-works/pi-server";

const host = createSharedProcessHost(applicationHost, {
  maxWorkers: 8,
  retireAfterIdleMs: 5 * 60_000,
  isHarnessIdle: (identity) => application.harnessIsIdle(identity.sessionId),
});
// host is a drop-in ServerHost: create the Server exactly as before.
```

No occupied-seat replacement and no fleet-wide restart: existing seats
keep their processes. The decorator bounds handles opened by the supplied
host; it does not change that host's process/thread topology. Actual shared
execution still requires an application host that implements it and a
separate real-process parity and memory canary.

## Out of scope (by design, per tracks)

- pD TUI/coding-agent attach client (presentation side).
- p9/root durable W1 (Session/Harness internals).
- Fleet supervisor/sharding/Nix pin (U1, fleet side — root coordinates).
- Per-session process env semantics (`PI_*` per process today) — the
  identity record above is the worker-side seam; the env contract stays
  on the wrapper.

## Delivery acceptance — 03/10/2026

Root re-froze v4 and corrected only formatting, an unused constant, test callback
return shapes and scope documentation. The offline monorepo build and all static
checks pass. The full offline suite passes5,565 tests with911 intentional skips;
12 focused cases cover this adapter. This is library source acceptance, not
production multi-session sharing or demonstrated fleet memory savings.

The fork's hosted workflows are currently blocked before execution by its
account billing state. Publication does not imply green hosted CI, merge,
runtime adoption, or permission to replace occupied sessions.
