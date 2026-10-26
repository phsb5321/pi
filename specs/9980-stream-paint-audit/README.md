# Interactive hot-path audit prototype

Base: `772c945d67a20a6ac5a6240ec74d04358927846d` (`memory-sound`).
Branch: `9980-stream-paint-audit`. Experimental only; no PR or merge.

## Hypothesis and plan

Context dispatch deep-clones the entire transcript even when no extension handles
`context` or `context_with_system`, adding history-sized work to each model request.
Skip that work only when neither handler exists. Preserve the existing deep clone,
handler ordering, system restoration and mutation isolation otherwise.

1. Profile the real InteractiveMode benchmark at 10 and 200 turns.
2. Add a failing no-copy test and mutation-isolation controls.
3. Add one handler-presence guard to `ExtensionRunner.emitContext`.
4. Compare five interleaved 200-turn pairs on identical dependency/build artifacts.
5. Run the targeted tests and root check; push this branch only.

## Measured acceptance

Five before/after pairs, alternating AB/BA order, unique 50,000-byte bash results,
120-column fullscreen VirtualTerminal, faux provider, compaction disabled, empty
HOME, `--expose-gc`, two collections at checkpoints. The baseline method is loaded
from the pinned base in the same build; only `emitContext` is selected differently.

Medians across runs (per-turn CPU uses the last ten turns at each checkpoint):

| Metric | Before | Prototype |
| --- | ---: | ---: |
| CPU/turn, 1–10 | 131.8 ms | 129.3 ms |
| CPU/turn, 91–100 | 141.9 ms | 130.0 ms |
| CPU/turn, 191–200 | 266.0 ms | 138.5 ms |
| Sum of measured turn CPU, 200 turns | 37.47 s | 27.94 s |
| Context dispatch CPU, 400 calls | 4158.6 ms | 6.9 ms |
| RSS at turn 200 | 319.8 MiB | 213.9 MiB |
| Retained heap at turn 200 | 67.8 MiB | 73.1 MiB |

Total turn CPU was lower in all five pairs (14.9–29.6% savings). RSS ranges did
not overlap (311.3–338.0 vs 207.3–217.3 MiB). Retained heap increased: this is
not a claim of reduced retained output. No allocator setting changed.

The no-handler dispatch becomes independent of transcript size; the entire
application is not claimed O(1). Real context handlers still pay the cloning
cost. Streaming Markdown and scrollbar costs are separate, unmodified findings.
The virtual terminal is not a measurement of physical display latency.

## Follow-up: string-sharing clone (handler loaded)

Every fleet seat loads `pi-context-lean.ts`, which registers a `context` handler,
so the fast path never fires in production. `emitContext` now copies plain objects
and arrays but shares strings (immutable), falling back to `structuredClone` for
non-plain values and preserving aliasing/cycles. Microbench, 200 turns of 50 KB
tool output: `structuredClone` 11.0 ms vs 0.69 ms; with 100-byte outputs
`structuredClone` is 2.9 ms, so ~74% of its cost was string copying.

With `pi-context-lean` loaded, 5 Latin-square triples x 200 turns (medians):

| Metric | Base | Fast path only | + string-sharing clone |
| --- | ---: | ---: | ---: |
| CPU/turn, 1-10 | 91.4 ms | 91.7 ms | 92.4 ms |
| CPU/turn, 91-100 | 103.9 ms | 103.8 ms | 95.2 ms |
| CPU/turn, 191-200 | 155.9 ms | 154.9 ms | 107.3 ms |
| Context CPU/call, 191-200 | 35.5 ms | 36.3 ms | 4.8 ms |
| Total turn CPU, 200 turns | 24.38 s | 24.38 s | 20.64 s |
| RSS at turn 200 | 277.8 MiB | 279.9 MiB | 217.1 MiB |
| Heap used at turn 200 | 68.0 MiB | 68.0 MiB | 73.3 MiB |

Share vs base total CPU savings per pair: 16.3, 16.2, 13.4, 17.5, 12.9%.
RSS ranges do not overlap (267.9-302.8 vs 210.9-218.5 MiB).

## Checks and evidence

Run from `packages/coding-agent` with an empty HOME and clean environment:

```sh
node ../../node_modules/vitest/dist/cli.js --run \
  test/suite/context-dispatch-fast-path.test.ts \
  test/suite/regressions/9789-context-handler-system-messages.test.ts \
  test/extensions-runner.test.ts --maxWorkers=2
```

Run `npm run check` at the root. The prototype adds no dependencies or flags.
The branch includes incidental baseline lint/format cleanup required for a clean
root check; those changes do not affect the measured product paths.

Full report and runnable harness copies live in Pedro's vault:
`1. Projects/Memory-Sound Program/evidence/perf-audit-2026-10-25/perf-audit-A-session-hot-path.md`.
Raw runs, profiles, scripts, and test/build logs are beside it in
`a-session-hot-path/`. Reconstruct the original harness from
`d23a63bedd94bafb2c8b79df34528dacb58617e6` on `9989-mem-bench`; its files are not
production changes in this prototype.

Rollback: discard this experimental branch. If subsequently landed, revert its
single prototype commit through the normal PR workflow.
