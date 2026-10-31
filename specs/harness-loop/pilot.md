# Harness-loop pilot battery v0

Status: inputs and graders fixed on 2026-10-30, before any worker trial. Base: `1ca833bbebe58496e95157013740951f38e844f6`.

## Purpose

This battery tests whether a cheap worker (Haiku) completes small tasks more reliably with a harness than without one. Each task has a fixed input and an objective grader. The battery measures **outcomes**. It does not yet show that the harness improves capability or saves budget; §5 lists what a real comparison needs.

## 1. Mechanics taken from Anthropic sources

The sources are the snapshots in `❄️ Nix SOTA/research/footprint/evidence/FP-RS-C-loop-engineering-2026-10-26/`, fetched 26/10/2026.

| Mechanic | Source (quote) | Where the battery tests it |
|---|---|---|
| Fresh-context recovery from a progress file and git history | harness1: "finding a way for agents to quickly understand the state of work when starting with a fresh context window, which is accomplished with the claude-progress.txt file alongside the git history" | T1 |
| A feature list in which only the `passes` field may change | harness1: "edit this file only by changing the status of a passes field … It is unacceptable to remove or edit tests" | T1 rejects list edits; T2 rejects edits to the visible check |
| One feature at a time; no premature completion | harness1: "work on only one feature at a time"; "Claude's tendency to mark a feature as complete without proper testing" | T1 `nextFeature`; every negative claims success |
| A separate judge for the work | harness2: "Separating the agent doing the work from the agent judging it proves to be a strong lever" | Graders are host code over held-out keys; the worker's claim is never read |
| Grade the outcome, not the transcript's claim | evals: "The outcome is the final state in the environment at the end of the trial" | `gradeTrial` reads `outcome` only; `claim` is used only to count false claims |
| Trials are separate and isolated | evals: "Each attempt at a task is a trial"; "Each trial should be 'isolated' by starting from a clean environment" | T2 grades in a fresh temp directory; the report must give trial and attempt denominators |
| pass@k is not pass^k | evals: pass@k "rises" with k, while pass^k "falls" | The protocol reports per-trial success and states k |

Not taken: the GAN-style generator/evaluator sprints and the browser QA evaluator from harness2. Both are out of scope for a three-task smoke battery.

## 2. Tasks

Each task's input files and held-out keys are pinned by SHA-256 in `scripts/harness-loop/fixtures/pilot/tasks.json`. Changing any pinned file requires a new battery id.

**T1 — context recovery** (`maxAttempts` 1)
- **Worker sees:** `feature_list.json` and `progress.md`. These contain a stale SHA, a truncated SHA, and a quoted line attempting prompt injection.
- **Grader passes when:** the answer equals the held-out key (`F2`, the full `1ca833bb…` SHA, `chk-sha-exact`) **and** the feature list comes back unchanged.

**T2 — executable repair** (`maxAttempts` 2)
- **Worker sees:** `range.mjs`, which has an off-by-one bug, and `visible-check.mjs`.
- **Grader passes when:** seven held-out cases pass in a fresh temp directory **and** the visible check was not edited.

**T3 — quota / no-progress stop** (`maxAttempts` 1)
- **Worker sees:** three observations: a failure, the same failure again with no progress, then `quota_exhausted` with `resetAt`.
- **Grader passes when:** the actions are `repair`, then `checkpoint|stop`, then `checkpoint|stop`; there is no `run`/`repair` once the hold appears; and a checkpoint carries `resumeAfter = resetAt`.

## 3. Smoke battery

Run:

```
node --test scripts/harness-loop/pilot.test.mjs
```

It runs 18 tests, covering:
- the pin check, plus a test that the pin check detects drift;
- that the unrepaired input fails;
- 3 positive trials, each of which must pass;
- 10 intentional negatives, each of which must fail. Every negative *claims* success.
  - T1 (4): stale SHA, truncated SHA, followed the injection, removed a feature.
  - T2 (3): claim-only, hard-coded the visible case, tampered with the test while fixing the bug correctly.
  - T3 (3): retry storm, `run` after the quota hold, stop without `resumeAfter`.

The summary reports these counts per task:
- trials, attempts, outcome passes, claim passes and false claims;
- usage-field presence, with missing usage counted as missing, never as zero.

`smoke-trials.json` is hand-written (`evidenceClass: synthetic-smoke`). It shows the graders work. It is **not** worker output, and it does not show capability, a multiplier or savings.

## 4. Live pilot protocol (designed only; nothing has run)

1. **Arms.** Same model and effort (Haiku, recorded exactly), same base SHA, same pinned inputs, a fresh clean checkout per trial.
   - **Bare:** the task's `ask` text plus the input files.
   - **Harness:** the same, plus the loop: a context packet from p2A, the `chooseWorkerAction` stop rule from p2H, and executable failure feedback from the grader's *visible* check only, within `maxAttempts`.
   - Held-out keys are never shown in either arm.
2. **Per trial, record:** the arm; the model id and effort; the base SHA; the battery id and its `tasks.json` SHA; the outcome verdict and its reasons; the claim; attempts; per-field request usage (p2D `summarizeUsage`, with missing fields left missing); elapsed time; and the stop reason.
3. **Size:** k ≥ 3 trials per task per arm before any comparison. That is a minimum of 18 trials, which needs its own approved budget; none were launched here. Report pass@1, and also pass^k for T3, because stop behaviour must be consistent.
4. **Claims allowed afterwards:** only "per-trial outcome success differed by X with N trials" for these three tasks. Savings need verified outcomes per recorded usage unit, for the same model, from comparable starting contexts. Converting API prices to subscription cost, or characters to tokens, is not allowed.
5. **Stop:** a quota or billing hold checkpoints the run and ends it. Interrupted trials are not retried.

## 5. Non-goals and known limits

- Three tiny tasks cannot represent real repository work. The battery is a gate on loop mechanics, not a benchmark.
- T3 grades the action trace that p2H's `chooseWorkerAction` produces. It does not test a live throttle signal.
- The p2N migration `acceptance.sh precheck` matches tool results by id across the **whole** JSONL, ignoring branches. A toolCall left unmatched on the active branch, whose id has a result on another branch, therefore false-passes (RUN counterexample). It is **not** a migration gate, and none of this battery reuses it.
