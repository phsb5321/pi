# Memory-Sound T2 QA work product

Status: source/input and oracle checks executed; actual frozen launch control flow is RED (two hosts/ProcessTerminal constructions for two pane invocations). Native composed behavior, actual fleet topology/client floor, rich Pi parity, root check and ACED are NOT accepted. Canonical matrix/checkpoint: `~/Documents/Notes/1. Projects/Memory-Sound Program/evidence/execution-wave-2026-10-06/qa/RECEIPT.md`.

## Executed preparation

- `node --experimental-strip-types --test specs/1006-composed-qa/identity.test.ts`: initial three tests passed; the added input test was then run specifically and passed. Tests include wrong blobs/modes, path escape, duplicate entries, stale/source-substituted output, missing/null ACED metrics and threshold violations. One targeted artifact-oracle rerun then passed after fixing a concrete validation gap: previously a matching manifest hash did not detect mutated source files; the artifact verifier now rechecks source/input bytes and a source-drift red control.
- `reconcile-source.ts`: all NEW1971 declared source blobs/modes, 274 symlink paths/targets/existence and 43 catalogue hashes passed independently. The newly delivered T1 tuple `35f5d3fa73ef` then independently passed **1975/274/43**, with `thin-presentation.ts` present. Negative-space completeness/dependency content/ABI/build remain unqualified.
- `PYTHONDONTWRITEBYTECODE=1 python specs/1006-composed-qa/test_sonar_readback.py`: four offline API-oracle tests passed. Every HTTP/rbw call was mocked; this is NOT a Sonar result.
- Missing artifact preload refused with exit 1 before payload. No native battery attempted.

Raw logs are in this directory. No deliverable lives only in disposable scratch.

## Actual launch and rich Pi extension

`FLEET-PARITY-MATRIX.md` is mandatory alongside the original T2 matrix. It covers actual-launch process census/native client floor and fifteen paired terminal/rich UI features. A 20-row/4096-char text surface cannot pass unchanged rich Pi behavior.

`launch-source-check.ts` imports and invokes the exact frozen old main through `launch-source-loader.ts` under explicit dependency spies. Corrected narrow run: RED/exit3, two host-constructor and ProcessTerminal calls. No real host/PTY/provider/process census/build. Raw initial hash-pin failure and qualified rerun are retained separately. Run only against frozen identity; do not retarget the file or manufacture green from mocked constructors.

`fleet-contract.test.ts` passed two oracle-only tests. It rejects multiple hosts/hidden JS/helper floors, unqualified binaries, missing budgets/ancestry/PTY aliasing and incomplete/unexecuted/parity-mismatched rows. These fixtures are not product evidence.

The existing native in-process/text-surface battery below is COMPONENT ONLY. It cannot qualify the actual launch entry, whole-fleet floor or rich Pi parity. Product runner must use the corrected delivered artifact and real owned PTYs/native legs, original qualified offline admission, and real raw census/terminal evidence; no broad network guard bypass or new live cohort.

## Exact artifact contract (not an original-owner approval substitute)

`artifact-loader.ts` requires `MSQA_ARTIFACT_RECEIPT` with schema `memory-sound-qa-artifact/1`. The receipt must be derived from the original qualified green build, NOT written to assert a green result. It binds:

- `root`: absolute actual composed build root; `sourceRoot`: immutable matching source root, independently rechecked against the source/input manifests;
- `sourceManifest` / `inputManifest`: absolute paths and independently verified SHA256;
- `build`: exit 0, all stages complete, raw log path and SHA256;
- `modules`: explicit names below to compiled relative `.js`/`.mjs`/`.cjs` files;
- `runtimeFiles`: absolute resolved paths and hashes for ALL loaded runtime files, dependencies, JSON and native assets; qualification must come from the build owner's receipt/closure, not on-the-fly trust of whatever dist happens to exist.

Names: `msqa/chord`, `msqa/context`, `msqa/ai`, `msqa/auth`, `msqa/models`, `msqa/residency`, `msqa/presentation-service`, `msqa/thin-presentation-service`, `msqa/thin-presentation`. Workspace transitive package aliases must resolve to this exact composed compiled output. Source fallback and unbound dependencies fail before use. Existing Node options are preserved; assigned UV/OMP/V8 pool sizes follow the admitted resource budget. The loader refuses sockets/HTTP, but genuine qualified offline admission is still required.

`MSQA_DATA_ROOT` must be a fresh empty directory under this worktree's `specs/1006-composed-qa/native-data/<unique-run>/`; existing evidence is never removed/reused. No production cwd/auth/session files are inputs.

After exact-green eligibility and bounded native admission, one sequential focused command is:

```sh
node --expose-gc --experimental-strip-types --import ./specs/1006-composed-qa/artifact-loader.ts \
  --test --test-concurrency=1 \
  specs/1006-composed-qa/composed-native.test.mjs \
  specs/1006-composed-qa/presentation-generation.test.mjs
```

This is a prepared COMPONENT command, NOT executed product/fleet/rich-parity acceptance. Run full output to the owned durable log. The native battery's 306 real SDK histories use compiled faux provider/runtime/residency/replica modules and native SQLite, not minimalEngine. It asserts streaming before final, actual bash effect/model result, actual presentation cancel with peer isolation and active-park refusal, all-session context recall/store continuity, reference release plus bounded explicit-GC reclamation and frame identity. Renderer schedule doubles are labeled separately. Wire sequence replay, fault/pool recovery and unsafe extension fallback remain explicit additional matrix rows and cannot be greened by this battery. No memory ratio is measured here.

## Static analysis execution boundaries

- `npm run check` has a write-enabled Biome stage. Do not run it in immutable tuples/foreign WIP. T1 must supply exact composed source/check view; otherwise root check remains blocked. This QA worktree currently has no usable Biome/tsc/vitest binaries; no dependency install/cache repair was authorized or attempted.
- Identify actual Sonar project, matching PROJECT_ANALYSIS_TOKEN via rbw, exact new-code baseline and LCOV over all changed source. Do not use `sonar-piorchestrator` or a USER_TOKEN for Pi scans, create a project/token, lower thresholds, overwrite unrelated Community single-branch main or infer coverage from oracle tests.
- `sonar-readback.py --project KEY --task-id ACTUAL_CE_TASK --revision EXACT_SCM_REVISION --output NEW_EVIDENCE.json` is a bounded read-back after the one qualified scan. It privately obtains admin web basic auth via rbw for read-only APIs; no credential appears in output/argv/env. It refuses pending CE without polling, wrong revision, concurrent/newer analysis, missing metrics and unreviewed hotspots. A metric pass is not full ACED; code-slop trio/baseline and executable/root acceptance also remain required.
- Canonical `code-slop-gate --changes` ignores uncommitted/untracked work. Do not stage everything or silently scan zero files. The exact composed changed-source set and a genuine baseline must be supplied; run the canonical immutable snapshot mechanism without editing/staging frozen owners' files or ratchet relaxation. No scan wave launched yet.

## Reversal / preservation

No commits, pushes, deployment, dependency mutations or cleanup. Original untracked test remains SHA256 `7a34c5eeac6eb6a4fe017241c98d5523cd3a34c07cae77a287a425863be5145c`. This directory is an owned additive work product; it can be left uncommitted and ignored for product runtime. Do not remove any other WIP.
