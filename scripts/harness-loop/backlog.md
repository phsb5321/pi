# Host-controlled backlog evaluation

Problem: `{verdict: "verified"}` from a worker, or a truthy unknown object, must not flip a backlog outcome. This module reconstructs every outcome from the existing async acceptance adapter and #51 receipt checker, not worker completion flags.

`createBacklogEvaluator(hostTasks)` captures reviewed host policy and private callback registries. Its returned async function accepts ONLY a serialized JSON batch:

```json
{"schemaVersion":1,"receipts":[{"taskId":"task-A","receipt":{"schemaVersion":1,"sha":"<host-pinned SHA>","checks":[]}}]}
```

The empty checks above intentionally cannot pass. Supply the strict receipt schema in `../check-acceptance-receipt.md`. Unknown envelope fields, duplicate/foreign task IDs, nonserialized objects and batches over 8 MiB fail closed. Missing tasks stay unknown. Evaluation follows host task order, not worker order, and reruns supplied tasks' actual host checks on every invocation. There is no sticky prior success, retry, scheduler or ledger write.

Each trusted host task has the unchanged `evaluateAttempt` fields: `taskId`, `expectedSha`, `requiredChecks`, `evidenceRoot`, `oracle` and optional `dependencies`. Register real callbacks ONLY in host source, before parsing generator output; never construct this factory from worker-supplied policy or code. Example host call:

```js
import { createBacklogEvaluator } from "./scripts/harness-loop/backlog.mjs";

// reviewedHostTasks contains independently pinned source/check IDs and actual
// host callbacks, never worker JSON or a worker-authored oracle snapshot.
const evaluate = createBacklogEvaluator(reviewedHostTasks);
const state = await evaluate(workerJson);
// Persist ONLY state.tasks if the receiving owner's policy authorizes it.
// Never spread worker fields over this result or infer success from object truthiness.
```

Output is a frozen `{schemaVersion: 1, tasks, allVerified}`. Each row contains ONLY host-pinned `taskId`, `sha`, checker-derived `verdict`, `accepted` and `reason`. `accepted` is exactly `verdict === "verified"`; missing, rejected and unknown results cannot become accepted. A required host check whose conclusion is `pending` (not completed) yields `unknown` rather than `rejected`, unless another required check completed with a failure; the loop checkpoints on it instead of spending a repair prompt. `passes`/`measured` are deliberately absent: p2E retains real ledger custody. The factory rejects an empty/duplicate host task list rather than giving vacuous success.

Runnable focused acceptance:

```sh
node --test scripts/check-acceptance-receipt.test.mjs scripts/harness-loop/acceptance.test.mjs scripts/harness-loop/backlog.test.mjs
```

Checks cover worker verdict/spread forgery, callback injection, wrong SHA/check IDs, altered/missing evidence, missing tasks, stale source, failed/throwing host checks and bare child exit0. A host-side assertion rejects an early-exiting child even though the child reports exit0. These are explicit synthetic fixtures, not production CI/adoption or measured cheap-model gains.

Trust ceiling: this is not a sandbox or an authentication system for malicious host code. Host callbacks must independently validate real results, preserve failures and cancellation, and fence a clean/immutable evaluated source/evidence tree. Bare HEAD equality cannot detect dirty/untracked writes. A deliberately lying registered host callback or hostile same-UID mutation is outside this module's boundary; a namespace sandbox alone cannot prove grader correctness. `evaluateAttempt` remains API-compatible for C. No C/D modules or policy are modified.
