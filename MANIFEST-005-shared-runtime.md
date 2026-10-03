# MANIFEST — 005-shared-runtime (in-process session runtime, track A)

w28:p4, 04/10/2026 01:2x BRT. Worktree `pi-upstream-005-shared-runtime`,
branch `005-shared-runtime` from `origin/main@4e4949299`.

## State of the branch (root completes the git part)

- **PR4 commit `bc2b157f2`** ("feat(server): bound opt-in session host
  admission and retirement") is **cherry-picked and RESOLVED but not yet
  committed**: the pre-commit code-slop gate (full-repo baseline ratchet)
  needs >2 min and the desktop-job-small-slot lease kills at ~114 s.
  **Offload requirement**: run `git -c core.editor=true cherry-pick
  --continue` in this worktree on a full-lane admission or root's Mac.
  Conflict resolution already applied: `packages/server/CHANGELOG.md`
  = origin/main's restructured changelog + the PR4 `### Added` entry.
- New files (untracked, to commit after the pick):
  - `packages/server/src/in-process-runtime.ts`
  - `packages/server/test/in-process-acceptance.ts`
- `node_modules` is a **local link to the shared tree's built
  `packages/chord`** (the shared root node_modules is empty). Root's
  `npm ci` replaces it wholesale — no stub is shipped.

## What this is (and is NOT)

It is the **shared-isolate slice**: many session engines in ONE Node
process. It is NOT the decorator-only shape — the decorator (PR4) is
composed for admission/cap/retirement/races; this adds the engine side:

- **stable per-session identity**: `{sessionId, generation, pid, model:
  "in-process"}` — generation is a GLOBAL monotonic open counter (p9
  falsifier note 04/10: strictly stronger than the earlier per-sessionId
  wording; no-ABA holds for every id).
- **exclusive durable writer ownership**: one engine acquisition per
  session open; `close()`/`shutdown()` release it exactly once; the
  factory contract forbids double ownership;
- **explicit session cap**: `maxSessions` (positive finite integer,
  validated), over-cap = `SharedProcessCapacityError` + `onEngineRefused`;
- **attach/detach**: opaque `invokeService` routing to the engine, release
  idempotent (PR4's demand accounting on top);
- **recoverable shutdown**: `control.shutdown()` closes every engine
  THROUGH the full-stack handles (releasing both the admission slot and
  the writer); reopening the same sessionId recovers with generation+1;
- **DEFAULT OFF**: nothing runs unless an app creates a runtime; the
  library spawns no process, thread, timer, or watcher;
- **no child Node per session**: the factory contract forbids it and the
  runtime rejects any engine whose `identity.pid != process.pid`.

## Narrow interface (pD client + p9 falsifiers consume exactly this)

`InProcessSessionIdentity`, `InProcessSessionEngine`,
`InProcessEngineFactory`, `InProcessRuntimeControl`, and
`createInProcessRuntime(factory, policy) -> { host, control }` —
`host` is a plain `ServerHost` for `packages/server`'s `Server`/router.
p2 integrates it into the application host.

## Actual-host acceptance (runnable, synthetic provider)

`node --experimental-strip-types packages/server/test/in-process-acceptance.ts`
— standalone, no build/deps beyond chord, no paid calls, no real
credential/session fixtures. Result on this host (04/10 01:2x):
**ALL PASS** (shared isolate 1 pid / cap / attach-detach / exclusive
writer / recoverable shutdown / no child process).

**It caught a real bug**: `shutdown()` originally closed engines without
releasing the decorator's admission slots — a recovery open was answered
by a dead slot (factory never ran). Fixed: the runtime tracks full-stack
handles and shutdown closes through them. The synthetic engine also now
resolves `terminated` on expected close (upstream contract).

## Checks for root (offload)

- `npm ci --ignore-scripts` (replaces the node_modules link), `npm run
  build`, `npm run check`, `./test.sh`.
- The acceptance file is standalone-runnable as above (also fine under
  vitest if you wrap it later; it deliberately uses no test framework so
  the actual-host run needs nothing).


## Defect round 2 (root review 04/10 01:34) — verified + fixed

Source-verified, reproduced, and pinned by
`test/in-process-runtime-regressions.ts` (standalone; ALL PASS on-host):

- **R1 duplicate `onEngineOpen`** (verified at :156 + decorator
  `onWorkerOpen`): one open notified twice, the second with the DECORATOR's
  generation (wrong identity). Fixed: single notification point carrying
  the engine identity.
- **R2 identity contract incomplete** (verified: pid-only check): a forged
  sessionId/generation from the factory was silently recorded. Fixed: full
  identity validation (sessionId + generation + pid); mismatches are
  closed-and-rejected like the pid case.
- **R3 shutdown racing an in-flight open** (verified: `handles.set` after
  the await vs `handles.clear()`): the late handle escaped tracking —
  engine + writer leak, slot held. Fixed with a **shutdown epoch** (not a
  flag): an open spanning a shutdown is refused+released; opens after the
  shutdown capture the new epoch and are admitted (recovery preserved).
  (First fix attempt used a boolean flag — it re-admitted in-flight opens
  as soon as an empty shutdown returned; the epoch closes that window.)

Suite state on this host: in-process-runtime-regressions ALL PASS ·
in-process-acceptance ALL PASS · in-process-falsifiers ALL PASS (11/11).
Default OFF unchanged; staged PR4 cherry-pick state untouched; no commits
(run hooks offloaded per protocol).


## BASE RECONCILIATION (offhost validation 04/10 01:52 — p2 decides)

**Verified mismatch:** this worktree is cut from `origin/main@4e494929`,
whose `packages/server/src/types.ts` exposes the **PiServer API**
(`PiServerOptions`, `SessionMetadata` from `@earendil-works/pi-protocol`,
`CreateSessionOptions`, `PromptInput`, ...) and whose package.json has **no
@earendil-works/chord dependency**. The in-process runtime and the
cherry-picked PR4 decorator target the **Chord-era API**
(`ServerHost`/`RoutedSessionHandle`) that exists on the memory-sound
lineage. On the supported base the build fails (root's Mac snapshot
`pi-upstream-007-shared-runtime-validation` carries the full check errors;
4 lint warnings fixed there).

**How it hid:** the standalone suites erase type-only imports under
strip-types and the local node_modules was a chord stand-in — the
lifecycle logic was validated; the base integration was not. Recorded as a
validation-gap lesson: standalone runs prove behavior, never integration;
only the offhost supported-base build does.

**Decision needed (p2 integrates):** delivery base =
(a) the memory-sound fork base (Chord API; this code compiles as-is), or
(b) the supported origin/main API — requiring an honest port of the
runtime + decorator seams to `PiServerService`/`PiSessionRuntime`
(no shimming obsolete names to pass, per the instruction). The narrow
interface (identity/engine/factory/control) survives either way; the
adapter layer is the delta. Recommendation: (b) — it is the supported
surface and the PR target; the port scope is the two seam adapters.

## Defect round 3 (root review 04/10 01:52)

- **R4 verified + fixed:** `onEngineOpen` throwing after `engines.set`
  leaked the admitted engine + writer (the handle was never returned).
  Reproduced (writer releases = 0 on the rejected open), fixed (cleanup on
  notification throw: engine close + map delete + rethrow), pinned
  (`R4: onEngineOpen throw releases engine+writer and frees capacity`).
- Test-housekeeping: the shared fixture module
  (`test/in-process-fixtures.ts`, root's extraction) is adopted;
  `index.ts` now exports `in-process-runtime` (the fixtures' import needs
  it); an unhandled-rejection recorder is pinned in the regression file.

Suite state on this host: regressions ALL PASS (R1–R4) · acceptance
ALL PASS · falsifiers ALL PASS (11/11).


## DELIVERY BASE RULED (root directive 04/10, via 330 seat)

**Baseline = MEMORY-SOUND** (PR4's native target). Cross-base mixtures are
not published: the 005 origin/main cut (PiServer API) is not the delivery
vehicle for this seam. **Runtime file verdict (for the 330/`ms/shared-session-host`
manifest): `packages/server/src/in-process-runtime.ts` current bytes are
memory-sound-compatible as authored — no port required.** Its binding
surface is entirely the Chord-era contracts (`./types.ts` names
ServerHost/RoutedSessionHandle/RoutedSessionAttachment/SessionMetadata/
MaybePromise + `./shared-process.ts` = PR4 lineage + type-only chord
imports). Fold dependency note: shared-process.ts (PR4) must be present;
`index.ts` exports `in-process-runtime` (their fixtures type-import from
`../src/index.ts`). The file carries R1–R4 (identity validation,
shutdown epoch, single engine-identity notification, onEngineOpen-throw
cleanup) and the tests adopt their `echoEngineShell` fixture.


## BASE RESOLUTION — FINAL (04/10, closed)

The (b) decision is **superseded by the provenance evidence**: delivery
base = **MEMORY-SOUND as authored** — the runtime file compiles unchanged
(Chord-era ./types.ts + PR4 lineage + type-only chord imports); **port = 
zero**. The 330 composition is single-base and **FROZEN against my exact
bytes (R1–R4 included)** (`MANIFEST-330-FROZEN.md` carries the cite lines
+ fold-deps as specified). PR-time merge-main rebase = rule-4 concern at
PR time, not a composition concern. Last open item closed; no port work
remains (the PiServer-API recon from the mid-decision window is moot).
