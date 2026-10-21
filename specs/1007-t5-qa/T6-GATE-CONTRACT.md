# Historical producer-declared T6 gate / exact-head quality readiness

Current T8 binding is `T8-GATE-CONTRACT.md` / `T8-PUBLICATION-CONTRACT.json` / `normalize-bound-publication.py`. Reuse final18/18 controls and their immutable receipt; the older T6 readiness and initial16-control account below is historical, not current publication eligibility. Generic compiled-only normalizer/gate bytes remain unchanged.

07/10/2026; readiness wave13:37. Latest qualified publication read at the completed normalization-preparation boundary: source-only T6, no admitted compiler/artifact. T5 outputs/source receipts remain immutable; `artifact-entry-t5.py` preserves the old gate. Current `artifact-entry.py` takes the producer's NEW receipt/root/layout, not a fixed T5 root or output count.

## Bound producer data

Existing schema `memory-sound-qa-artifact/1`, with:

- `root`: real compiled distribution/consumer root; `sourceRoot`: frozen producer source root. Source is verified but never imported in compiled execution.
- `sourceManifest`, `inputManifest`: absolute `path`/SHA256; source blob/mode/content, declared dependency aliases/catalogues/package metadata verified.
- `check`, `build`: complete/exit0, actual log paths and SHA256; opt-in emitted build must belong to the same source/input tuple.
- `distManifest`: absolute path, canonical JSON SHA256 and `merkleSha256`; `distRoots`: producer-relative physical output trees, independently enumerated. Extra/missing/drifted outputs reject.
- `modules`: actual compiled aliases required by the existing rich host harness (`msqa/ai`, `msqa/auth`, `msqa/models`, `msqa/host`). `msqa/auth/models/host` can share the producer's explicit shared bundle, whose declared exports are `AuthStorage`, `ModelRuntime`, `createSharedTtyHost`. An external compiled AI package must belong to independently verified `additionalOutputs`, never source. The old nonessential QA `msqa/tui/theme` observer imports were removed from compiled mode; a second bundle cannot observe the host's private async context.
- `dependencyModules`: resolved absolute dependency aliases (including native writer-check `proper-lockfile`); `nativeAttachment`: producer-relative emitted native `.sh`.
- `runtimeFiles`: resolved absolute paths/SHA256 for the complete runtime closure; optional `runtimeManifest` binds that map independently. Every actually resolved/loaded product file is separately checked and recorded. Missing loaded dependencies, any product TS or source-resolver reject before acceptance. Owned QA identity helpers are not product source.

If producer publication uses another shape, normalize the declaration in OWN QA only, preserving original publication/hash; do not alter its bytes, invent green phases or choose old paths. No source helper/minimalEngine fallback is admissible. Factory/ModelRuntime/AuthStorage must be native compiled implementations; actual SQLite/tool/cancel/history/residency/PTYS/rich frames are executable oracles, not constructor mocks.

Run once with a NEW owned evidence directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python specs/1007-t5-qa/artifact-entry.py \
  --artifact-receipt /absolute/path/to/complete-producer-declaration.json \
  --publication /absolute/path/to/producer-acceptance.json \
  --evidence "$PWD/specs/1007-t5-qa/evidence/ready-wave-1337/compiled-a1" --execute
```

16 initial gate checks passed (one positive fixture +15 rejecting controls), including real loaded transitive-dependency omission, loaded TS and loaded source-resolver. Additional-output/absolute-compiled-alias controls are added for the producer's packed-consumer plus emitted-AI layout; retain all old control outputs. They are identity/loader fixtures ONLY, explicitly rejected as product publications.

Machine PASS includes exact source/input/dist/Merkle/runtime-closure hashes, all supplemental compiled-output hashes, loaded-runtime ledger, actual execution mode and only exercised gates. `normalize-t6-publication.py` reads the actual producer event/package/runtime declarations, preserves their hashes, compares packed bytes to the declared tarball, verifies the full producer dist and binds the faux AI module/native writer helper to declared existing input aliases; its positive event normalization is unexecuted because no event was admitted. Historical source33 is never compiled proof. Host-loss protocol oracle now checks bytes emitted AFTER loss, not any earlier reset in the capture.

## ACED readiness and live grants

Canonical Sonar runbook and full metrics oracle read. Live rbw unlocked; existing web credential retrieved privately. Actual auth validation: documented trailing-colon form valid=false; standard admin basic valid=true. No secret printed. Initial403/read rejection preserved alongside the qualified standard-auth read.

Actual live enumeration found no canonical `phsb5321_pi` / `earendil-works_pi` or Pi-named project/approved Pi analysis-view mapping; rbw has no matching Pi `PROJECT_ANALYSIS_TOKEN` entry. This does not rule out an undocumented alternate key; no such alternate mapping is approved/verified here. `sonar-local` full metadata privately inspected: no recognized Pi project or scoped-type declaration; never used as a token. Existing unrelated project tokens/USER_TOKEN are not borrowed. No Pi new-code baseline was available. Exact required grant: approved isolated Pi projectKey/analysis view, matching existing or provisioned project-scoped analysis token, and its unchanged approved new-code period. No project/token/baseline was created or changed and no unrelated main overwritten.

Clone-ratchet preparation uses the canon's Git `origin/main` default, resolved here to `4e494929998d6bc4fccf75e0a233f727db4b70ee`; QA HEAD `200387122ca450d6387f033949423114a270b96c` is NOT the frozen candidate. Never run `--changes` on this unrelated QA head and book an empty diff. Materialize a read-only OWN analysis view of the exact declared frozen source, compare with the actual pinned Git-main snapshot using installed `jscpd-snapshot-compare.js`, and preserve all reports. Git-main mechanical comparison does not fabricate a Sonar new-code baseline.

Installed canonical engine: `/nix/store/rvc5bdlips64617figwb7zdgvv47c5x7-code-slop-gate-0.1.0/libexec/code-slop-gate/`; aislop0.12.0 and jscpd installed. Use unchanged zero-error/zero-new-clone policy, min-tokens50, baseline untouched. Snapshot jscpd aggregate threshold100 is the engine's normal collection mode; acceptance is the unchanged new-clone ratchet, NOT aggregate100.

Built-in Node24 test coverage is available. The QA worktree has no coverage converter, but the producer-declared installed input tree does contain ast-v8-to-istanbul1.0.5 and Istanbul libraries; no hydration is needed. Their presence alone is not verified source-map/new-code coverage accounting. Current converter-positive/source-map integration is NOT executed; no coverage metric is claimed. `compiled-coverage.test.mjs` reuses ONE focused compiled battery only AFTER the matching compiled behavioral PASS. Host flushes real V8 coverage before intentional SIGKILL. Use normal shared HEAVY admission, sequential with aislop/jscpd, never alongside compiler/memory cohort. Keep V8/LCOV/logs in OWN evidence, not runner scratch. Native generated-JS LCOV without verified new-code/source-map accounting is not a Sonar new-coverage>=80% claim; missing changed sources/conditions must fail closed.

Actual ACED still requires A/A/A, new coverage>=80%, zero new issues,100% reviewed hotspots, new duplication<=3%, aislop0 errors and no new-clone growth at the exact source/analysis identity. Sonar scan is not authorized by unrelated admin/token possession. Current missing Pi project/token/baseline mapping is concrete live grant evidence, not generic pending prose.
