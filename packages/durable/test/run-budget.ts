/**
 * Wall-clock budget for one durable test.
 *
 * `packages/durable/vitest.config.ts` applies it as the package default, because the tests here
 * inherited vitest's 5 s bound on the whole test rather than on the work it does. Every red in runs
 * 412/417/432/433 was a test that needs under 1.4 s standalone, and the failing test moved between
 * suites each run (codemode, harness-compaction, harness-structured, harness-scheduler-retention,
 * harness-tasks-recovery, sqlite-migrations), so a per-test list is whack-a-mole while one bound
 * closes the class.
 *
 * The number is measured, not round: a 1.4 s test needs about 7.4 s at the observed runner factor
 * (>= 5.3x) and about 34 s under the worst run-to-run contention swing on one file (4.6x), and no
 * durable test has exceeded ~35 s in CI (worst file total 34.8 s for 34 tests). The clamp ceiling is
 * was therefore 60 s: 1.7x that ceiling.
 *
 * Since the 1.5.2 merge one test no longer fits: "forgets a 20,000-deep chain of ended tasks" needs
 * 53.2 s in CI when it passes (run 503) and 56.9 s standalone on a 4-core desktop, so it failed at
 * 60 s in 7 of the 9 CI runs from 14/11 to 22/11/2026 (runs 504, 505, 509, 510, 511 among them).
 * The ceiling is now 120 s, 2.1x the worst passing measurement; a genuine hang fails in two minutes.
 * It is not an assertion: the deadline behaviour itself is pinned by the explicit-deadline tests.
 */
const RUN_BUDGET_PER_OPERATION_MS = 2_000;
const RUN_BUDGET_MIN_MS = 15_000;
const RUN_BUDGET_MAX_MS = 120_000;

export function runBudget(operations: number): number {
	return Math.min(RUN_BUDGET_MAX_MS, Math.max(RUN_BUDGET_MIN_MS, operations * RUN_BUDGET_PER_OPERATION_MS));
}
