# MANIFEST — 004-shared-process (frozen exact files for root Mac build/test)

**v4 — third review round (root, 03/10 18:17).** v3 froze 11/11 green on
Mac; two lifecycle gaps + one stale TSDoc line closed. Regression is now
12 cases. Fix log:

### v4 fix log (root's findings → fixes)

| finding | fix |
|---|---|
| busy `isHarnessIdle` at timer fire or post-hook returns without rescheduling → never retires after the harness goes idle | both bail points now call `scheduleRetirement(slot)` (one bounded idle timer re-arms; case 12 covers entry-gate AND post-hook paths deterministically) |
| `retireAfterIdleMs` > 2^31-1 accepted; Node clamps to 1ms (surprise immediate retirement) | `validatePolicy` rejects `> 2147483647` with `SharedProcessPolicyError`; 2147483647 accepted (guards case extended) |
| stale API TSDoc "Default: always idle" | `isHarnessIdle` TSDoc now states REQUIRED when retirement is enabled, unused otherwise |

v2/v3 entries below remain accurate.

### v3 fix log (root's findings → fixes)

| finding | fix |
|---|---|
| attach admitted during `handle.close` await (client gets a closing worker) | `closeBegun` flag set at the close commit; `attachClient` **fails closed** (`SharedProcessClosingError`, uniform rejected promise) once close begins — attach BEFORE the commit still cancels a retire via the post-hook recheck |
| deferred-close race untested | new case 10: gated inner `close()`; attach after the commit rejects; close completion releases the slot (expected close) |
| `isHarnessIdle` not rechecked after `await onBeforeRetire` | post-hook recheck now gates on `isBusy(slot) \|\| !isHarnessIdle(slot.identity)` |
| sync attach failure never rescheduled the idle timer | the sync catch path now calls `scheduleRetirement(slot)` |
| `close` finally released capacity even on rejection (live worker + replacement > cap) | release ONLY after successful close or actual `terminated` settlement (case 11: rejected close holds capacity; termination frees it) |
| `isHarnessIdle` default-true unsafe with retirement enabled | `validatePolicy` REQUIRES `isHarnessIdle` when `retireAfterIdleMs > 0` (host knowledge, never assumed) — `SharedProcessPolicyError` otherwise |
| `generations` map unbounded (every ever-seen id) | global monotonic `generationCounter` — bounded memory, no per-id ABA; identity.generation = open sequence |

v2 entries below remain accurate.

**v2 — review fixes after root's first freeze (03/10 17:5x BRT).** Re-freeze
the four files below (identical paths; content updated). v1 test run was
RED 2/5 (`/tmp/pi-shared-focused.log`) + source review found a cap race.
All findings fixed; the regression is now 9 cases.

### v2 fix log (root's findings → fixes)

| finding | fix |
|---|---|
| idle worker never schedules initial retirement | `openOne` now calls `scheduleRetirement(slot)` at admission (retirement-from-open is the covered case) |
| crash test expected rejection; upstream `terminated` resolves `Error \| undefined` | tests + docs corrected to RESOLVE semantics; the decorator always passed the inner promise through (semantics preserved) |
| cap race: `slots.size` checked before `await inner.openSession` | pre-await **reservation**: `pendingOpens` map is both the reservation and the same-session share; the capacity check and the reservation insert run with no intervening await; failure cleanup via `pending.then(cleanup, cleanup)` so a failed open returns capacity |
| policy values unguarded (Infinity/NaN/fraction) | `validatePolicy`: `maxWorkers` positive finite integer, `retireAfterIdleMs` finite ≥ 0 → else `SharedProcessPolicyError` (fail-fast) |
| attachment-vs-retirement race | `slot.attaching` counter incremented synchronously at `attachClient` entry (decremented on lease-or-failure); `attemptRetire` gates on it and re-checks after every await (hook interleave included) |
| timer exceptions → unhandled rejections | timer path: `attemptRetire(...).catch(...)` → `policy.onError`; the worker stays hosted and usable |
| (my rewrite regression, caught in self-review) | `isHarnessIdle` gate restored in `attemptRetire` |

New regression cases (6–9): concurrent delayed opens hold the cap;
same-session concurrent opens share one inner open + failed-open cleanup;
policy guards; attach-during-retirement race + `onError` handling.

Branch: `004-shared-process` (cut from `origin/memory-sound` @ `ab9c9fa6`).
Authored 03/10/2026 17:0x–17:3x BRT by w28:p4 via native read/edit/write only
(no local shell — desktop admission was pressure-refused at 16:47).

## Files to freeze onto the full checkout (exact content = worktree content)

| file | state | purpose |
|---|---|---|
| `packages/server/src/shared-process.ts` | NEW | the slice: `createSharedProcessHost` worker decorator (opt-in, bounded, retiring, crash-parity) |
| `packages/server/src/index.ts` | MODIFIED | adds `export * from "./shared-process.ts";` (4 original export lines preserved verbatim) |
| `packages/server/test/shared-process.test.ts` | NEW | executable regression (5 cases: opt-in+cap, isolation+context privacy, retirement window/hooks/harness-predicate, crash parity + generation, expected close) |
| `docs/SHARED-PROCESS-SLICE.md` | NEW | parity claims, plugin matrix row (needs-restart per FEASIBILITY-A), integration snippet, out-of-scope list |

## Mac build/test sequence (from the frozen full tree)

```bash
npm install --ignore-scripts
npm run build                       # or scoped: npm --prefix packages/server run build
npm run check                       # biome + tsc + entry-graphs etc.
node node_modules/vitest/dist/cli.js --run --root packages/server test/shared-process.test.ts
./test.sh                           # full non-e2e suite
```

Expected: check clean (erasable TS only, top-level imports, no `any` in the
slice); the 12 regression cases pass; no other package is touched (diff =
4 files above; `packages/server` only).

## Contract review notes (for the reviewer)

- No server/router/protocol/durable/TUI/coding-agent change: the decorator
  composes over the existing `ServerHost`/`RoutedSessionHandle`/
  `RoutedSessionAttachment` seams (`packages/server/src/types.ts`) — the
  seam answer to p9 W1 / pD W is: **zero seam changes**; both tracks keep
  their surfaces.
- Retirement close uses `BACKGROUND_CONTEXT` (the router's own pattern);
  `terminated` passes the inner promise through byte-identical (crash
  parity by construction).
- `retireAfterIdleMs` omitted/0 = upstream never-retire behavior (opt-in).
- Default `maxWorkers` 16 = FEASIBILITY-A shard cap.
- The worktree contains no `packages/server/package.json` (sparse); the
  frozen tree's existing one needs NO change (no new deps; test reuses the
  package's existing vitest devDep).

## Program-claims discipline (docs/PROGRAM-RULES.md)

This slice makes no memory claim yet — no mem-probe table is required to
land it (D4: tables attach at the M2-style acceptance run). The canary
deployment (root-side) is where the trio (mem-probe table idle+mid,
kill-9 conformance, matrix row) attaches; the matrix row is already
recorded in `docs/SHARED-PROCESS-SLICE.md` (needs-restart).

## Owner handoff

- w28:p4 (this author): slice complete; next action = answer review
  questions + (post-Mac-green) the canary pairing with pD's attach client.
- root: freeze → build/check/test → ordinary PR merge flow (no
  admin/force/main push; nothing here needs it).
- p9 W1 (durable): no touch — confirmed no durable file in the manifest.
- pD (TUI/coding-agent tail): no touch — the presentation side composes
  over the same host seam later (`pi --attach`-class).
