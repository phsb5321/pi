# 2371 summary F1/F2 landing receipt

Verified on desktop on 12/10/2026 at 16:57 BRT. Extension/catalog parent: `2b54de14eefff137cc409ffc6a23bb77a2c64556` (valid signature).

## Scope

- F1: omit undefined optional entry fields so in-memory entries strictly match their persisted JSONL representation; retain the persisted-value tampering control.
- F2: document and test the ordinary `context` event versus standalone summary boundary. Default summaries do not inherit extension context filtering; custom summary hooks must explicitly filter their outbound content.
- Preserve protected bash execution exclusion through the shared `convertToLlm` boundary for ordinary requests, compaction, and branch summaries.
- Abort controls require no persisted summary and no active-branch change.

## Executable evidence

Run from `packages/coding-agent`:

```sh
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --maxWorkers=1 --run \
  test/session-manager/persistence-roundtrip.test.ts \
  test/suite/regressions/2371-summary-context-boundary.test.ts \
  test/branch-summarization.test.ts
```

Result: **3 files passed; 15 tests passed**, exit 0. The two requested F1/F2 fixtures and the modified branch-summary neighbor all passed. Tests use synthetic/faux transports, not live provider credentials.

`git diff --check`: exit 0.

The summary changes are a separate commit from the extension/catalog commits. The existing `specs/` research directory is not staged. No sibling worktree, workflow, CODEOWNERS, repository protection, provider/account selection, or global runtime settings are changed.

## Delivery boundary

Extend fork PR [#19](https://github.com/phsb5321/pi/pull/19) through a normal signed commit and hooked push. No merge, force-push, or hook bypass is authorized by the latest instruction. PR CI is a separate post-push gate, not implied by the local test result above.
