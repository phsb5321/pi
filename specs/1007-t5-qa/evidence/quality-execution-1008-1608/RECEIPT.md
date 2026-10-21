# Real quality execution — source-only checkpoint

Original pickup: **08/10/2026 16:08:52 BRT** (`ms-qa / side-projects:w28:pK / codex-a / accountA / GPT6.1Sol`), OWN `pi-upstream-005-shared-isolation`. Cross-family continuation pickup **08/10/2026 19:20 BRT** executed the retained check at a normally admitted boundary.

**Status: PREREQUISITE_CHECK_PASS (source-only).** The ONE new prerequisite check ran and returned **exit 0** at **08/10/2026 19:25:23 BRT**. Syntax, preparation, missing-artifact rejection, ineligible rejection, and static call-chain inspection all PASS. Positive compiled/V8/scanner/baseline/candidate/ACED execution remains **UNVERIFIED**. Artifact is still NULL. No credential fetch, scanner launch, HTTP request, product launch or compiler invocation occurred.

Hypothesis: existing qualified transport, converter, native QA and readback primitives can supply real exact-source quality without another build when genuine same-identity compiled/API/V8/maps/SCM receipts exist. Falsifier (now exercised): missing/ineligible inputs must reject before any product/scanner/rbw/HTTP; actual source/SCM/condition mismatch or CE/quality RED must stop downstream.

## Verified prerequisite-check result

Command (normal SMALL lane, timeout90, wrapped with owned-root guard + `date` + raw log/exit capture):

```sh
python3 -B specs/1007-t5-qa/test-quality-boundary.py
```

- exit **0**, clock `08/10/2026 19:25:23 -0300`.
- Syntax: Python `ast.parse` (6 files) and `node --check` (3 mjs) all PASS.
- Preparation: `prepare-quality-execution.py` ran and produced `PROJECT-GATE.T15.QUALITY.json` (929 eligible sources retained, artifact/map/capture/SCM NULL), `API-HISTORY.QUALITY.json`, `QUALITY-EXECUTION.json`, `quality-scanner-metadata.json`. It refused overwrite of the original T15/API manifests; identity/policy/eligibleSources/expectedNewSources/partitions unchanged.
- Qualified helper hashes verified unchanged: `scanner-fd.py` `e56990c0…`, `source-map-coverage.mjs` `f2cd72af…`, `project-gate.py` `6a077b03…`.
- Missing-artifact rejection: exit **78**, `BLOCKED`, blocker `Missing qualified compiled artifact`; `scansSubmitted/credentialFetches/httpRequests/compilerInvocations` all 0; `productLaunched=false`.
- Ineligible (fixture) rejection: exit **3**, `FAIL`, blocker `Product quality manifest required`; zero side effects.
- Side-effect traps (`subprocess.Popen` / `urllib.request.urlopen`) recorded **0** forbidden calls across both rejections.
- Static glue inspection: scanner→`TRANSPORT['run_scanner']`, readback→`READBACK['get_json']`, `SPECIFIC_ANALYSIS` pin/readback, coverage→`convertBoundCoverage`/`coverage.merge(...)`/API-child PID guard, and `api-history.py` `NODE_V8_COVERAGE` forwarding all present.
- `validCodepathInspection=STATIC_ONLY`; `positiveProductExecution=UNVERIFIED`; `ACED=false`; `oldControlsRerun=0`.

Raw result: `boundary-result.json`; per-check logs `missing-artifact/result.json`, `ineligible/result.json`, `preparation.log`, `*-syntax.log`. Final code hashes are sealed in `boundary-result.json` and `checkpoint.json`.

## Historical admission refusals (superseded, retained as facts)

At 16:08 and 16:46 BRT the same check was refused **before payload** by SMALL admission (exit75, `fleet-working-set=62665MiB exceeds 59GiB cap`); `custody-copy-admission-refusal.txt` and `prerequisite-check-admission-refusal.txt` record those refusals. Neither consumed a compiler event. The 19:25 run is the first and only actual execution; no retry loop, alternate lane/host, cap change, resource/artifact polling, foreign kill or cleanup was used to reach it.

## Source changes (unchanged from the 16:08 pickup)

- `quality-entry.py --manifest` routes to `quality-execution.py`. Historical `--compiled-pass` local collector is explicitly labelled; its zero-submission output is not the new real path.
- `quality-execution.py` gates on exact physical artifact and original accepted publication, compiled/API850 PASS, full denominator, map inventory, candidate SCM provenance, installed binaries and existing scoped-access proof. It reuses the **ONE accepting compiled/API campaign's raw V8**, not another product battery. It prepares real v1.0.4 Git analysis view and exact frozen candidate overlay, checks TS bytes when normalizing LCOV paths, runs existing aislop/jscpd ratchets, calls real scanner/readback glue and emits genuine quality-stage receipts for the unchanged project gate. Producer Biome/types receipts are reused, never re-executed. Future actual normal heavy envelope/InvocationID/cgroup/pressure/deadline remain required.
- `quality-sonar.py` uses unchanged `scanner-fd.py:run_scanner` and private `sonar-readback.py:get_json`. Only existing project analysis token `sonar-pi-memory-sound-qa`, fetched privately in the future request process, is used; the historical admin-credential helper is **not called**. No new token or broader credential fallback. Scanner report-task → actual SUCCESS CE/project/revision/version → returned analysis ID → exact project-only `SPECIFIC_ANALYSIS` set/readback → candidate scanner → actual analysis/full-page measures/issues/hotspots/SCM/quality-gate readback. Redirects/proxies are refused. A pending CE task blocks with its submission preserved; explicit later `--resume` reuses submissions/capture, without polling or rescanning. Permission/HTTP behavior is UNVERIFIED, not an additional-approval fiction.
- `quality-coverage.mjs` feeds **all PID raw V8 documents** through the unchanged composed-map converter and merges their actual results. All inherited eligible files/unused conditions remain in the final conservative denominator; only exact mapped location/arm matches gain observed hits. Unmatched static candidates stay zero, never become invented executed branches. Vendor sources require actual physical publisher provenance; type-only empty maps require physical no-executable-code proof. Actual Sonar SCM/count mismatch rejects rather than manufacturing reconciliation.
- `api-history.py` explicitly forwards owned `NODE_V8_COVERAGE` to native children and binds resulting V8 files after normal teardown. Native Driver/adapter/loader/allocation copies are not edited. It supports a manifest-bound executor contract for the new quality derivative.
- `prepare-quality-execution.py` prepares `PROJECT-GATE.T15.QUALITY.json`, `API-HISTORY.QUALITY.json`, `QUALITY-EXECUTION.json` and scanner metadata with exact current code/tool bindings, retaining original T15 scope and keeping unknown artifact/maps/capture/SCM NULL.
- `test-quality-boundary.py` is the ONE new bounded syntax/preparation/guard/static-codepath check. It is source-only, has no positive product fixture or real token, and traps subprocess/HTTP side effects during rejection checks. No old 18/7/8/16 matrix rerun.

## Genuine continuation, not a producer retry

The retained ONE prerequisite check is now **PASS**. Remaining real-quality execution is gated on a genuine producer PASS: at a real emitted boundary, explicitly rebind actual tuple/source/input/dist/runtime/maps/publication/native closure and the accepting compiled/API campaign V8 before real quality. Current T15 source `c60ad0ff1455`/input `a7da1f25fd1b` is preparation, not T16/T17 acceptance.

The accepting compiled/API campaign must capture V8 into owned durable evidence and bind a `qualityExecution.coverageCapture` JSON with exact identity, `fixture:false`, actual compiled/API receipt bindings, the hash-bound compiled `ready.json` in its raw evidence, and the full raw V8 binding list. The API result must bind its V8 files; every actual ledger PID plus focused PID must have raw V8. Missing API children blocks, never silently becomes shared-only coverage. Map inventory and actual underlying Git revision/tree/frozen-overlay attestation must be publisher-bound. No invented commit, analysis ID, VERSION event or score. The preparer retains all929 eligible source and changed/unused-condition partitions; no recensus or static graph→observed proof transfer.

pJ alone owns vendor-map repair and latest separately recorded one-additional-tested-run authority. We did not inspect a new producer event or infer its consumption. Historical last-owned 15:16 T16 checkpoint remains check0/build0/opt-in1 and historical3+fresh1=total4 **at that boundary only**, not a new current count. All historical REDs/refusals remain.

Serialized future chain: producer → exact compiled/API campaign with V8 → real quality → matched memory. Immutable clone `4e494929998d6bc4fccf75e0a233f727db4b70ee`/minTokens50/newclone0/aislop0; actual release commit `7c10bd4337495ee613f2224843ecdf349b80d1df`/tree `de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0`; A ratings/newcoverage≥80/newduplication≤3/newissues0/reviewedhotspots100 remain unchanged. No ACED, live, full-fleet or 100× claim.

Durable machine checkpoint: `checkpoint.json`. Knowledge: owned Notes project `QUALITY-EXECUTION-2026-10-08.md`; source usage `specs/1007-t5-qa/QUALITY-EXECUTION.md`. All files are in intended owned repositories, not `$PI_SCRATCH_DIR`/`$TMPDIR`.
