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
