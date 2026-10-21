# T5 focused executable source QA — 07/10/2026

Own only this spec/evidence directory. Preserve previous QA/WIP and all build-owner frozen sources. Hypothesis: current physical-catalogue T5 preserves rich native PTY and SDK behavior only if exact source identity and actual rich UI/protocol flows pass executable tests; the old thin text and constructor fixtures are not substitutes.

Tasks:
- Verify T5 manifest 4d9b2518 / input7e12e2b4, 1980 code entries unchanged from T4 plus43 physical catalogue files (2023 total), 273 exact declared links.
- Reuse production createSharedTtyHost, native faux provider/ModelRuntime, rich runDurableTui, shared-tty-attach.sh and existing PTY-launch plumbing. One sequential Python worker/one native Node host; isolated owned histories/PTYs/cwd, no production inputs or network providers.
- Drive real PTY streaming, registered tool effect/result, real cancellation/peer isolation, long/multiline bracketed-paste input, model/agents rich selectors, native durable history recall and writer lease refusal, per-pane resize/negotiation and detach/reattach/host-loss restoration. Record own raw frames/requests/state/census/SQLite and failing controls. Source checks are never compiled acceptance.
- One bounded source run; at most one qualified harness/root-cause rerun per distinct defect. Handoff product defects at exact file:symbol with raw reproduction; no owner source edits.
- Check exact green dist publication once after source work. If absent, deliver a fail-closed single-shot artifact entry requiring independently verified build/output hashes. pJ alone owns root check/compiler.
- Publish raw evidence here and canonical QA RECEIPT. ACED not claimed unless exact artifact actually scanned; no fabricated coverage, duplication, issues or hotspot results.
