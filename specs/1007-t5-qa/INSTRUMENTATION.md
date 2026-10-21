# Offline scanner / source-map instrumentation

Hypothesis: anonymous settings fd inheritance survives the installed scanner launcher, and the installed converter preserves real TypeScript zero-hit files/branches. Both hypotheses have executable fixture evidence; neither is a product or remote-analysis result.

Run from OWN feature worktree, with NEW durable evidence directories, one ordinary small job at a time (512MiB/1CPU; actual fixtures peak<=120MiB):

```sh
PYTHONDONTWRITEBYTECODE=1 python specs/1007-t5-qa/test-scanner-fd.py "$PWD/specs/1007-t5-qa/evidence/<new-scanner-run>"
node --v8-pool-size=1 --max-old-space-size=160 specs/1007-t5-qa/test-source-map-coverage.mjs "$PWD/specs/1007-t5-qa/evidence/<new-map-run>"
```

No dependency hydration, real credential fetch, network analysis or product compiler. Java premain fixture is compiled with installed javac/JAR and passed through the **actual Nix wrapper → scanner shell → actual JVM**, help-only. It reads the anonymous settings fd, verifies fake-only token bytes/argv/environment and exercises normal exit, exit23 and timeout/SIGKILL. `scanner-fd.py` passes only the fd reference in argv, redacts raw/Basic tokens before log persistence across every split, masks truncated prefixes at EOF and closes/reaps on failures. Duplicate credential and log-open failure are rejecting controls. Scanner analysis/bootstrap settings parsing and real CE remain NOT_EXECUTED; the caller must independently enforce compiled PASS/exact isolated project/revision before using the helper.

`source-map-coverage.mjs` uses installed ast-v8-to-istanbul1.0.5 + Babel/Istanbul, with explicit source/output/map hashes. Real fixture tsc emits JS/maps; actual Node V8 coverage covers one branch while the second TS module is never loaded. The helper converts actual ranges and inserts all-zero ranges for declared unexecuted output, keeping source/branch denominator. Missing/hash-mismatched/out-of-root/unmapped/embedded-content-mismatched sources/maps reject. Exact eligible sources absent from the final map reject. Raw V8/generated JS/maps/TS/source manifest/converted Istanbul/TS LCOV remain in evidence.

Qualified current receipts: `evidence/instrumentation-1858/{scanner-a2-final,coverage-a2-final}/result.json`; all command logs/exits and first small pre-payload refusal74 retained. Earlier a1 receipts are historical and separate.

**Exact producer requirement:** the one inspected frozen T9 bundler `commonBuildOptions`, line118, has `sourcemap:false`, SHA `8d562065fffe01fb461a7cd1e38a29a2db327d94cd0ba9d872d63d42be22ad6c`. `producer-map-requirement.json` binds the requirement for actual host/chunk maps and composed canonical core-JS→TS mapping in a future producer declaration. No producer file/pane was touched. No blanket experimental/source carveout or generated-JS LCOV relabeling is allowed.

For eventual candidate conversion, original compiled identity/loaded closure/V8 receipt/map provenance must be bound to the original frozen source, not the QA fixture tree. These fixtures qualify conversion mechanics, not the absent full candidate graph, SCM/new-code attribution or80% metric. Actual candidate compiled behavior prerequisite, exact released v1.0.4 CE/SPECIFIC_ANALYSIS ID and original `4e494929998d6bc4fccf75e0a233f727db4b70ee` clone ratchet/aislop/source-condition gates remain unchanged. Heavy order producer → compiled QA → quality → memory; no waits/polling or admission fallback.
