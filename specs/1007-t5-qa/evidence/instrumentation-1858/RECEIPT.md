# Independent instrumentation checkpoint — 07/10/2026

Pickup18:58:29 BRT; next verified clock19:06:07. Applied mandatory FASTER-FEEDBACK and UNBLOCK-2026-10-07-1744 goal handoff. OWN repository deliverables, no scratch-only copy. Two independent prerequisites now have actual runnable accepting/rejecting evidence, not just contracts.

## Actual accepting execution

1. `PYTHONDONTWRITEBYTECODE=1 python specs/1007-t5-qa/test-scanner-fd.py <OWN evidence>/scanner-a2-final` — **exit0,7 checks**. Installed Nix scanner8.1.0.6389 wrapper → actual scanner shell → actual JVM receives fake-only anonymous memfd settings; help-only, no server requests. JVM exits0/23/-9 (normal/failure/timeout), exact fake-settings digest, no secret in argv/env, streamed raw/Basic redaction across all split boundaries and truncated EOF prefixes, duplicate credential rejection, log-open failure fd cleanup, fd close/child reap verified. Raw sanitized JVM logs/argv/compile commands/result retained. Final admitted small runtime6.992s/peak119.7MiB; telemetry, not savings.
2. `node --v8-pool-size=1 --max-old-space-size=160 specs/1007-t5-qa/test-source-map-coverage.mjs <OWN evidence>/coverage-a2-final` — **exit0,8 checks**. Real installed tsc produces tiny TS→JS/maps; actual Node V8 coverage remapped by installed ast-v8-to-istanbul1.0.5/Babel/Istanbul to TS LCOV. Executed file has1/2 branches covered; never-loaded file retains0/2 lines and0/2 branches, not removed. Source-byte mismatch, missing map, out-of-root source, empty mappings, embedded-content mismatch and unmapped eligible file all reject. Raw TS/JS/maps/V8/source-output manifest/converted Istanbul/LCOV/result retained. Actual cgroup `cpu.max=100000 100000`, `memory.max=536870912`, `pids.max=64`; final small runtime3.965s/peak111.9MiB.

Helpers/tests: `scanner-fd.py`, `FdProbe.java`, `test-scanner-fd.py`, `source-map-coverage.mjs`, `test-source-map-coverage.mjs`; usage/boundaries in `INSTRUMENTATION.md`. A1 passes remain separate; final A2 additionally qualifies truncated-log/error cleanup and strips inherited token env from fixture children. No new dependency/framework or product compiler wave.

## Precise remaining producer requirement

One source-setting inspection: frozen T9 `scripts/build-coding-agent-bundle.mjs:118:commonBuildOptions` has **sourcemap:false**, SHA `8d562065fffe01fb461a7cd1e38a29a2db327d94cd0ba9d872d63d42be22ad6c`. `producer-map-requirement.json` records actual host/chunk map emission, inventory binding and composed canonical core-JS→exact-TS provenance required before candidate conversion. No pJ file edit or occupied-pane prompt; no assumption about a later derivative by name. No experimental/source carveout, generated-JS relabeling or source runtime fallback.

`QUALITY-CONTRACT.json` now records qualified **fixture mechanisms**, not an actual remote settings/bootstrap/analysis or complete candidate graph. Caller still enforces matching compiled behavior, exact source/input/loaded closure and full eligible source/condition denominator. Actual v1.0.4 CE/revision/version/SPECIFIC_ANALYSIS ID and candidate coverage/new-code readback remain NOT_EXECUTED until eligible. Original clone baseline4e494929998d6bc4fccf75e0a233f727db4b70ee, aislop0/new-clone0/minTokens50/all ACED predicates unchanged; original18 artifact controls reused, not rerun.

## Refusals / next action

First coverage submission refused before payload74 (30s caller small admission); actual later small execution is separate. Metadata/hash submission and one completed-publication-boundary final custody submission each refused before payload74 (15s caller admission). All three refusal records retained; no unexecuted index/custody PASS inferred. No further admission request. No payload waiting/polling/fallback/caps change. Real tests above passed; raw logs/exits/results exist durably.

Next: producer's genuine source-free graph with bound composed maps → same-identity compiled/API/seed/history/richPTY checks → actual quality baseline/candidate conversion/analysis → memory. Product compiler0, real token fetch0, remote analysis/setup0; no accounts/agents/panes/dependencies/heavy competition/commit/push/send/deploy or shared cleanup. No ACED/80%/compiled product/RAM acceptance claimed.
