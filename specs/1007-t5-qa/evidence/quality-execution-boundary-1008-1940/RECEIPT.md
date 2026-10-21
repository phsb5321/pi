# Real quality-execution boundary check — verified rejecting boundary

Actual pickup **08/10/2026 19:34 BRT** (deepseek-v4-pro:high continuation, same `ms-qa / side-projects:w28:pK / accountA`, OWN `pi-upstream-005-shared-isolation`). Check ran at **19:41:04 BRT**, normal SMALL admission, exit **0**.

**Status: QUALITY_EXECUTION_BOUNDARY_CHECK_PASS_NOT_PRODUCT.** The executor rejects before product. No scanner, credential fetch, HTTP request, compiler invocation, product child or ACED occurred.

## Defect fixed

`quality-execution.py:preflight()` previously required an artifact receipt **before** checking source identity, so a stale-T14/T15-tuple manifest fell through to `Missing qualified compiled artifact` (78) instead of being rejected as stale (3). The API-history executor already had the correct ordering (`contract['sourceIdentity']` checked first). Fixed:

- `prepare-quality-execution.py`: the quality plan now carries `sourceIdentity` = `{tuple, sourceSha256, inputSha256}` from the current T15 identity, mirroring `prepare-api-history.py`.
- `quality-execution.py:preflight()`: loads `identity` + `plan` up front and, immediately after the fixture guard, rejects any manifest whose identity does not match `plan['sourceIdentity']` with `Stale source identity: <key>` (exit 3), **before** the artifact check.

The three sealed qualified helpers (`scanner-fd.py`, `source-map-coverage.mjs`, `project-gate.py`) and `quality-entry.py` are unchanged.

## Verified negative controls (both exit-0 PASS, side effects 0)

| Control | Input | Exit | Blocker |
|---|---|---|---|
| missing-artifact | `PROJECT-GATE.T15.QUALITY.json` (T15 identity, `artifactReceipt: null`) | **78** | `Missing qualified compiled artifact` |
| stale-tuple | same manifest, `identity.tuple` → `T14-stale-negative-control` | **3** | `Stale source identity: tuple` |

Both raw results confirm `scansSubmitted: 0`, `credentialFetches: 0`, `httpRequests: 0`, `compilerInvocations: 0`, `productLaunched: false`, `ACED: false`; no `sonar/` side-effect directory was created in either rejection path. `behaviorExecuted: false`, `fixturePositive: false`.

## Command

```sh
python3 -B specs/1007-t5-qa/test-quality-execution-boundary.py
```

Wrapped with the owned-root guard. The check re-regenerates the derivative manifests (scoped unlink of the four own regenerable files + `prepare-quality-execution.py`), then runs the two rejections through the real `quality-entry.py --manifest … --execute` argv via subprocess.

## New code hashes

- `quality-execution.py` `b6fd972efc99fa1bca05593bbd02452360754a2f20b2953b5ad861a9f5c9cefc`
- `prepare-quality-execution.py` `130345cf63176619c13906170065c21a135fe431e13da64b942c78b691121696`
- `test-quality-execution-boundary.py` `c1e731108b3f712871e13299eae2bb2b3c36a1cbb305455fccc6b0bb9a3ba786`
- `quality-entry.py` unchanged `0ec936adc1c82aac07e22873fe51bcffd27f6ac39a2904aaa4e650ca3b6ef065`
- `PROJECT-GATE.T15.QUALITY.json` (regenerated with `sourceIdentity`) `e9ab4f139ba8d7708a5226fd7da52e45601bde5e77ba238ddcb7a13c2da849f7`
- `QUALITY-EXECUTION.json` `ee76dd8064260d72c1fec22ad65298c21f1532ed248fcce13ef95184f5ada665`

## Scope and continuation

This is a verified rejecting boundary only. No accepting product/coverage/Sonar/ACED is claimed; the old 18/7/8/16 fixture matrices were not rerun. Artifact remains NULL — pJ has published no compiled artifact and still owns vendor+generated-runtime map provenance. When a genuine successor tuple is published, bind its exact source/input/output/runtime/map identity (not a T15/T16/T17 label) before any real quality execution.

Immutable clone `4e494929998d6bc4fccf75e0a233f727db4b70ee`/minTokens50/newclone0/aislop0; release commit `7c10bd4337495ee613f2224843ecdf349b80d1df`/tree `de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0`; A ratings/newcoverage≥80/newduplication≤3/newissues0/reviewedhotspots100 unchanged. Sonar token stays in rbw/request-process memory only; no new issuance or profile/global change.

Durable evidence: this directory (`boundary-result.json`, `missing-artifact/`, `stale-tuple/`, `preparation.log`, `clock.txt`). Knowledge: vault `QUALITY-EXECUTION-2026-10-08.md`. All deliverables in the owned repo/vault, not `$PI_SCRATCH_DIR`/`$TMPDIR`.
