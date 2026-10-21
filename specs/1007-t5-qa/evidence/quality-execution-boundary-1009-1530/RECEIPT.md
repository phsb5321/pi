# Real quality-execution boundary check — commandsLaunched fix + re-verification

Actual pickup **09/10/2026 15:22 BRT** (deepseek-v4-pro:high continuation, same `ms-qa / side-projects:w28:pK / accountA`, OWN `pi-upstream-005-shared-isolation`). Fix-verification run at **09/10/2026 15:36:37 BRT**, normal SMALL admission, exit **0**. The 08/10/2026 19:41 run (`evidence/quality-execution-boundary-1008-1940/`) is preserved untouched.

**Status: QUALITY_EXECUTION_BOUNDARY_CHECK_PASS_NOT_PRODUCT.** The executor rejects before product; both negative controls emit `commandsLaunched: 0` from a real spawn counter. No scanner, credential fetch, HTTP request, compiler invocation, product child or ACED.

## Defect fixed (found on resume)

The dispatched acceptance for this boundary check required proving **`commandsLaunched=0`** alongside `scanner 0 / credentials 0 / product child 0 / ACED false`. The `quality-execution.py` result emitted `productLaunched` / `compilerInvocations` / `scansSubmitted` but **not** `commandsLaunched`, and had no command counter at all — so the "rejects before product" claim was under-proven: it showed "no product child" but not the stronger "zero OS commands spawned." (The sibling `api-history.py` executor emits `commandsLaunched`; this was a real parity gap.)

Fix in `quality-execution.py`: a transparent spawn counter wraps `subprocess.Popen` (the single funnel through which `subprocess.run`/`check_output` and the scanner all reach the OS), incrementing on every spawn. `report['commandsLaunched'] = spawned[0]` is written in the `finally` block. Wrapping only `Popen` counts each command exactly once (no double-count through `run`→`Popen` or `check_output`→`run`→`Popen`). The rejection path provably spawns nothing because `preflight()` stops at the sourceIdentity check (stale-tuple) or the `artifactReceipt` check (missing-artifact), both before its first `subprocess` call (the git SCM check is far later).

Counter liveness verified separately (`popen-counter-liveness.py`, run-then-removed): 2 commands through `run` + `check_output` → exactly 2 counts, single-funnel. So `commandsLaunched=0` is backed, not a dead literal.

## Verified negative controls (both exit-0 PASS, zero side effects)

| Control | Input | Exit | Blocker | commandsLaunched |
|---|---|---|---|---|
| missing-artifact | `PROJECT-GATE.T15.QUALITY.json` (T15 identity, `artifactReceipt: null`) | **78** | `Missing qualified compiled artifact` | **0** |
| stale-tuple | same manifest, `identity.tuple` → `T14-stale-negative-control` | **3** | `Stale source identity: tuple` | **0** |

Both raw results (`missing-artifact/result.json`, `stale-tuple/result.json`) confirm `scansSubmitted: 0`, `credentialFetches: 0`, `httpRequests: 0`, `compilerInvocations: 0`, `productLaunched: false`, `ACED: false`, `commandsLaunched: 0`. Rejection dirs hold only `result.json` (no `sonar/` side-effect directory). `behaviorExecuted: false`, `fixturePositive: false`.

## Command

```sh
python3 -B specs/1007-t5-qa/test-quality-execution-boundary.py
```

Wrapped with the owned-root guard. Re-regenerates the derivative manifests (scoped unlink of the four own regenerable files + `prepare-quality-execution.py`), then runs the two rejections through the real `quality-entry.py --manifest … --execute` argv via subprocess.

## Current code hashes

- `quality-execution.py` `7fd2289825a930546963d617f581a2b93751a72b25d6a3ce1c737298bfe69ed9`
- `test-quality-execution-boundary.py` `eb06cecf2a209eb865b7a56cf76ccafa3bc1befb1e688fa3aaf5ae728d148842`
- `quality-entry.py` unchanged `0ec936adc1c82aac07e22873fe51bcffd27f6ac39a2904aaa4e650ca3b6ef065`
- `prepare-quality-execution.py` unchanged `130345cf63176619c13906170065c21a135fe431e13da64b942c78b691121696`
- regenerated `PROJECT-GATE.T15.QUALITY.json` `c62c76358317e0e6c8e3545bff2c097884e9b41ddbab666bea0378e7c6304f3a` (hash moved from `e9ab4f…` because it binds the fixed `quality-execution.py` in `instrumentFiles`)

## Producer state and continuation

pJ delivered a composed-map continuation at 08/10 19:40 (third distinct map class: own compiled-JS composition), **source-only, compiler event still 0/1** — no compiled artifact published. A bound artifact therefore stays NULL. Real coverage/Sonar/ACED waits on a genuine successor tuple; when it lands, bind its exact source/input/output/runtime/map identity (not any T15/T16/T17 label) before real quality execution.

This is a verified rejecting boundary only. No accepting product/coverage/Sonar/ACED is claimed; the old 18/7/8/16 fixture matrices were not rerun. Immutable clone `4e494929998d6bc4fccf75e0a233f727db4b70ee`/minTokens50/newclone0/aislop0; release commit `7c10bd4337495ee613f2224843ecdf349b80d1df`/tree `de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0`; A ratings/newcoverage≥80/newduplication≤3/newissues0/reviewedhotspots100 unchanged. Sonar token stays in rbw/request-process memory only; no new issuance or profile/global change.

Durable evidence: this directory (`boundary-result.json`, `missing-artifact/`, `stale-tuple/`, `preparation.log`, `clock.txt`). Knowledge: vault `QUALITY-EXECUTION-2026-10-08.md`. All deliverables in the owned repo/vault, not `$PI_SCRATCH_DIR`/`$TMPDIR`.
