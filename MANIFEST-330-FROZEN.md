# MANIFEST 330 — frozen shared-session-host composition (offhost acceptance)

Frozen 04/10/2026 02:2x BRT by w28:p2 (integration owner). **Base: MEMORY-SOUND
as authored — zero port.** p4's runtime verdict (verified): the file's whole
binding surface is Chord-era `./types.ts` contracts (ServerHost /
RoutedSessionHandle / RoutedSessionAttachment / SessionMetadata / MaybePromise)
+ `./shared-process.ts` (PR4 lineage) + type-only chord imports — all native on
memory-sound. The PiServer-API mismatch exists ONLY on the wrong-based
origin/main cut. Cross-base mixture: none (single base). PR-time note: rule 4
(PR-only-new-content after merge-main) governs the eventual upstream rebase;
not a composition concern.

## Composition — exact files (all base-coherent on memory-sound)

| # | File | Worktree / owner | State |
|---|---|---|---|
| 1 | `packages/server/src/in-process-runtime.ts` | 005 (p4) | **memory-sound-compatible as authored**; R1–R4 fixes in bytes (single engine-identity notification; full sessionId+generation+pid validation; shutdown-epoch refusal+release; onEngineOpen-throw cleanup) |
| 2 | `packages/server/src/shared-process.ts` | 005 (PR4 cherry-pick bc2b157f2, resolved) | staged |
| 3 | `packages/server/src/index.ts` | 005 (exports in-process-runtime per p4) | staged |
| 4 | `packages/server/src/in-process-host-core.ts` | 330 (p2) | frozen this turn (seam-only: imports only from #1) |
| 5 | `packages/server/test/in-process-fixtures.ts` (`echoEngineShell`) | 330/005 (p2 extract) | frozen |
| 6 | `packages/server/test/in-process-runtime-regressions.ts` | 005 (p4 R1–R4 + p2 scoped-R4 hook per root) | **ALL PASS** |
| 7 | `packages/server/test/in-process-acceptance.ts` | 005 (p4) | **ALL PASS** (synthetic provider, zero paid calls) |
| 8 | `packages/server/test/in-process-falsifiers.ts` (contractFixture extract) | 005 (p9 + p2 de-clone) | **11/11 ALL PASS** |
| 8b | `packages/server/test/in-process-pilot-falsifiers.ts` + `contract-fixture.ts` | 005 (p9) | **pilot battery ALL PASS ×3 deterministic** — host kill-9 → durable recovery gen+1 + post-run disk audit (FEASIBILITY-A gate case); exactly-once streams across kill; client reconnect; isolation under load; cap-refusal + writer accounting; torn-tail tolerance; open-count vs disk-truth discrepancy DISCLOSED (disk audit binding) |
| 9 | `packages/server/test/shared-process.test.ts` (`makeRetiringShared` extract) | 005 (PR4 + p2 de-clone) | frozen |
| 10 | `packages/server/CHANGELOG.md`, `docs/SHARED-PROCESS-SLICE.md`, `MANIFEST-004/005-*` | 005 (PR4 resolution) | staged docs |
| 11 | `specs/330-shared-session-host/{spec,plan,tasks,contracts-confirm}.md` | 330 (p2) | frozen docs |
| 12 | `packages/coding-agent/src/experimental/durable/shared-host-main.ts` + `shared-host-canary.ts` | 330 / delivered by p4 | **DELIVERED** `ms/shared-session-host@59e7842de` (pushed + ls-remote verified) — real entry (openDurable per-session engines, DEFAULT OFF) + executable synthetic canary **GREEN on-host**: 3 engines/1 pid, >=2 thin clients (pD ThinClient interface), isolation asserts, mem-probe measured-only 46.8 MiB, exit 0/3 |

## Open items: NONE before offhost checks (the canary/entry = follow-on slice)

**Pre-pilot gate run** = p4 canary (GREEN @59e7842de) + p9 falsifiers (ALL
PASS x3) — **JOINT VERDICT PASS 12/12 (04/10)**: kill-9 mid-canary-run ->
per-session recovery gen+1 + client re-attach; exactly-once streams across
kill (torn tail skipped); isolation clean live+resumed; cap refusal + writer
released once. Evidence: `evidence/MS-20/pre-pilot-gate-run-2026-10-04/`
(01a/01b/02/03 + README). Next battery: cancellation/history/extensions
isolation + SDK host services + native no-network canary + process-tree
memory contract; composed candidate sha -> p3/p7.

## Acceptance commands (Mac / offhost full lane)

```bash
cd <composition worktree>          # memory-sound base + files above
npm ci --ignore-scripts
npm run hydrate:model-data && npm run generate:models   # B0 fresh-checkout trap
npm run build
npm run check
node --experimental-strip-types packages/server/test/in-process-runtime-regressions.ts   # R1-R4
node --experimental-strip-types packages/server/test/in-process-acceptance.ts            # acceptance ALL PASS
node --experimental-strip-types packages/server/test/in-process-falsifiers.ts            # falsifiers 11/11
```

## Constraints recorded

Runtime DEFAULT OFF (nothing ambient), no child Node per session
(identity.pid enforced), cap refuse-not-queue, tests = synthetic provider
(zero paid calls), privacy/model constraints unchanged, PR4 + all WIP
preserved, no session/model resets, heavy gates run offhost only,
DECLARE-CHECKLIST line 1 (push + ls-remote VERIFY) at publish time.

## Battery-2 (04/10 11:5x) — COMPOSED REAL-SDK ACCEPTANCE: PASS

Composed candidate @59e7842de through the real SDK/application host path
(real openDurable engines, per-session SQLite, provider-free):
cancellation/history/extensions + SDK host services isolation ALL PASS;
p9 adversarial overlay + standalone 11/11; strict no-network canary under
unshare -Urn (kernel-level) + zero-socket counters. **Process-tree memory
CONTRACT defined+asserted**: one pid tree / 1 process / N sessions,
mem-probe whole-tree measured-only — NPROC=1, PSS 34.3 MiB (46.8 class,
bound 128). W1/E axis: CTXDEFER (no per-session context at host start;
all deferred to open/per-call) + per-session-cwd resolver (cwd isolation).
**LIVE CANARY STAGED, DEFAULT OFF** — opt-in PI_SHARED_LIVE_CANARY=1,
real turns gated on PI_SHARED_LIVE_MODEL + pilot authorization; head
237427f1e (pushed + verified); EXACT REVERT = `git revert f4c584a67`.
Evidence: `evidence/MS-20/pre-pilot-battery-2/` (01-04 + README).
Next slice: pilot-authorized live turn + resolver battery.

## Superseded by COMPOSITION-1206 (04/10 12:15)

Frozen source-of-record = `pi-upstream-composition-1206/COMPOSITION-1206.md`
(head **93219cd84**, pushed+verified; exact commits + lockfiles + hashes;
one-build-owner = serialized offhost budget only). REVERT of the live-canary
staging = `git revert f4c584a67` (corrected: 0e17d59fe is pD's client
commit). Claims boundary: PROVEN = synthetic seam isolation + kernel
no-network + memory-contract mechanics N=3 (NPROC=1, 34.3 MiB) + real-engine
abort-no-active-turn/view-only; NOT PROVEN = real streaming/tool/cancel-of-
active-turn/restart/parked-history-reclaim (retirement OFF). Live activation
NOT authorized. N1/8/32 measurement HELD until W3 containment (tmux
sibling-scope escape, p3/infra).
