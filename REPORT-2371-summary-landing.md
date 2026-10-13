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

## Fresh CI diagnosis — 13/10/2026

The new instruction permits a normal checked merge when the safe class actually applies; it supersedes the previous no-merge instruction. Source head inspected: `7337a1445eab75c12f2268b8c7b5905528d568d5`. Base: `main@4e494929998d6bc4fccf75e0a233f727db4b70ee`.

Both original failed jobs had no logs, zero steps, and no assigned runner. Exactly one failed-job rerun was requested for each existing run. Attempt 2 completed on 13/10/2026 at 16:05 BRT with the same result:

| Gate | Exact run / attempt-2 job | Evidence |
| --- | --- | --- |
| `build-check-test` | [38301404189 / 115485196701](https://github.com/phsb5321/pi/actions/runs/38301404189/job/115485196701) | `[V]` FAILURE; `steps: []`, `runner_id: 0` |
| catalog `generate` | [38301404067 / 115485207493](https://github.com/phsb5321/pi/actions/runs/38301404067/job/115485207493) | `[V]` FAILURE; `steps: []`, `runner_id: 0` |

Both failure annotations state exactly:

> The job was not started because your account is locked due to a billing issue.

`gh run view <run> --attempt 2 --log-failed` returns `log not found` for each corresponding job. There is no compiler, test, or catalog-generation output to repair. The Ubuntu image-migration notice is not the failure. No speculative source change, weakened test, fake fixture, workflow migration, or forged status is justified.

### Acceptance and merge rubric

| Item | Oracle | Result |
| --- | --- | --- |
| Preserve F1/F2 and extension diagnostics | Targeted Vitest command below | `[V]` PASS: 4 files, 21 tests, exit 0 at 16:07 BRT |
| Fresh hosted build/check/test | Attempt-2 job and annotation | `[V]` FAIL before any step; not a source-test failure |
| Fresh hosted catalog generation | Attempt-2 job and annotation | `[V]` FAIL before any step; catalog execution unverified |
| Contributor entitlement | Author collaborator permission plus `.github/workflows/pr-gate.yml` admin predicate | `[V]` Author has `admin`; no human contributor-entitlement hold is assumed |
| All review threads | Paginated GraphQL `reviewThreads(first: 100, after: $endCursor)` | `[V]` 0 threads, `hasNextPage: false`; no unresolved findings |
| Actual reviews | Paginated REST `/pulls/19/reviews` | `[V]` Only historical Copilot quota-unavailable COMMENTED review; not approval and not a required-review blocker |
| Protected safe-class base | `/branches/main`, `/branches/main/protection`, `/rules/branches/main` | `[V]` `protected: false`, protection 404, effective rules `[]`; do not claim a branch-protected base |

The existing contributor workflow runs on PR opening only. Its historical failed run is not a current-head rejection. The observed owner permission meets its actual collaborator predicate; no registry, permission, approval, or workflow edit is needed.

Run from `packages/coding-agent` on the inspected source head:

```sh
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --maxWorkers=1 --run \
  test/session-manager/persistence-roundtrip.test.ts \
  test/suite/regressions/2371-summary-context-boundary.test.ts \
  test/branch-summarization.test.ts \
  test/extension-source-install-load.test.ts
```

This reruns the existing 15 summary checks and adds the 6 existing extension checks without changing any test or production source. Synthetic/faux tests are local regressions, not live-provider or hosted-CI proof. `specs/` remains unstaged. Current transport-owner `w2K:p4` context was read; no Pi SDK file or sibling worktree was edited.

Raw public API receipts are committed under [`docs/evidence/pr-19-ci-2026-10-13/`](docs/evidence/pr-19-ci-2026-10-13/). They cover both jobs/annotations, source-head PR/review pagination, contributor permission, base protection, and effective rules. Private billing history and vault content are not included.

### Evidenced external hold and continuation

**[pending] Pedro: resolve the verified GitHub Actions account lock through the existing billing/support owner.** No billing, payment, budget, permission, provider/model/account, workflow, or CODEOWNERS change is authorized or performed here.

This is not a contributor hold and not a completed CI repair. Do not merge while the actual build and generation gates remain red. The unprotected base also does not satisfy the standing branch-protected safe-merge class; repository owner access is not proof of that class. No settings change or admin bypass was attempted.

After the external lock clears, rerun the existing failed checks on the then-current immutable PR head, inspect any actual step failures, repeat complete review-thread pagination, and merge only when green and normally permitted. Local tests and a signed evidence push cannot substitute for that acceptance.
