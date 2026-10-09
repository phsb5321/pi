# COMPOSITION-1241 — re-freeze (PORT-PI-1241/1220, p9)

**Head: `b3cd356c035fab1303421e90d4eb0e6ddcf52752`** (branch `1206-history-overlay`, pushed + `ls-remote` VERIFIED 04/10/2026 ~13:3x BRT). Parent chain: `b3cd356c0` → `28bdcefbb` (the `33bc7b1dc` wrapper cherry-pick) → `79f9f6013` (the first overlay) → `93219cd84` (COMPOSITION-1206 freeze) → `237427f1e`. Previous freeze: `COMPOSITION-1206.md` (immutable as history).

## This revision fixes both 1241 blockers (p9 ownership)

1. **`contract-fixture.ts` committed alongside the parity suite** — the suite exited 1 on the composed head (`ERR_MODULE_NOT_FOUND packages/server/test/contract-fixture.ts`): the test was committed, its fixture was not (it was untracked in my worktree). Fixed here; the fixture is my file.
2. **Wrapper-wide await for the async reclaim proof** (domain note `evidence/MS-20/residency-1241/DOMAIN-NOTE-hydrate-async.md`): `HydrateSession.releaseResidency/resumeResidency` widened to `() => void | Promise<void>` and **awaited** — `await releaseResidency()` in `park()`, `await resumeResidency()` in `ensureHydrated()`, `await park()` at the `rh:park` seam member, `ParkableEngine.park(): Promise<void>`. Fired-and-forgotten release/resume is not async reclaim proof; the adapter's internal gate compensation can come out once this lands.

## Digests (sha256-16, this head)

```
2c0ab1ed6a2ebb70  packages/server/src/retained-history.ts
40ec621ed5d85e5d  packages/server/test/in-process-retained-history.ts
db87509a20d279ec  packages/server/test/contract-fixture.ts
05a97d2f851dc170  test/history-reclaim-overlay.ts
```

## Battery target (the NOT-PROVEN list)

`test/history-reclaim-overlay.ts` — real streaming / real tool / real cancel-of-active-turn / real restart / real release-resume / real parked-history-reclaim, on the composed candidate's REAL store (openDurable per-session SQLite). Release-resume is wired to the SDK's real paths (`close` = the real `location.release()`; re-open = the real `harness.resume()`). No paid calls; the model is never required to answer (user entries land in the durable store before any turn resolves).

## Test status (honest)

- **On `ms/composition-1241 @ 693a0180`** (the composition owner's admitted Nix.Server scope): their residency acceptance + real-SDK acceptance **BOTH ALL PASS** (provider-free, repeated hydration 3x3 park/reclaim/awaited-resume, native continuation, restart). My parity suite **failed there** on the missing fixture — the exact failure this revision fixes (reproduction pinned: `evidence/MS-20/composition-build-1241/RECEIPT.md`).
- **This revision's parity suite + six-target battery**: the composed re-run on the built slot is the acceptance step (the local desktop build is barred by the one-build-owner rule; deps here are hydrated via `npm ci --ignore-scripts`). Run: `node --experimental-strip-types test/in-process-retained-history.ts` and `node --experimental-strip-types test/history-reclaim-overlay.ts` from `packages/server` / the repo root respectively.

## Landing workflow (unchanged)

Tested PR → normal merge → staged default-OFF pilot; rollback = `git revert` of the overlay commits (DEFAULT-OFF throughout; nothing is live-activated). **Live activation NOT authorized.** Composition/build ownership stays with p4; this manifest documents the source head + digests only.

## Claims (binding)

Case-labeled only; no claim exceeds the battery's case labels. `100x` and real parked-history fleet reclaim remain **UNPROVEN** until matched total-tree N1/8/32 — HELD behind admitted W3 containment (tmux sibling-scope escape under p3/infra).
