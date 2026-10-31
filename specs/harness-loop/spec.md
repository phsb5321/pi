# Bounded native goal / repair loop

Status: local integration checks passed; external delivery/independent audit remain. Faux-provider acceptance is not measured model effectiveness. Owner: p2C. Delivery/evaluation: p2E. Measured pilot: p2D.
Receiving base: `6784958b93dc2d85a8b43448e54b01c2514d84d5` (Forgejo memory-sound after PR #2; earlier slice verified at `056720511ef78ec5d79581641070c9a46004d44e`, merged v1.4 #52), descending from `1ca833bbebe58496e95157013740951f38e844f6`.

## Problem and hypothesis

`pi goal` persists a per-seat objective, but has no evaluator or bounded repair driver. Pi's SDK already owns prompting, abort, provider retries and session persistence. A small host function connecting these to independently supplied context/routing/acceptance/usage functions should suffice; a second framework is unnecessary.

Example: worker says done; trusted artifact-check fails with expected fixed=true; next prompt includes that exact failure; worker repairs; a fresh trusted check passes. The assistant's claim never grants completion.

## Scope

One goal, one dedicated persistent AgentSession, finite attempts and absolute deadline. No provider choice, subprocess launch, daemon, scheduler, quota cache, dispatch, pane wake, deployment or ledger writer. Inputs are host-selected and reviewed, not worker-generated control data. Existing `pi goal status --json` may supply the goal text through the host; this function does not mutate a standing seat goal or active session.

## Required behavior

- Host injects v0 context, routing, usage and acceptance adapters. Unknown availability must checkpoint. Receipt fields never supply executable commands or oracle authority.
- Before each prompt: positive host credential eligibility for the pinned account plus fresh routing decision; a nominal codex 0% reading does not prove eligibility. Driver independently enforces attempts/deadline. Disable native automatic retries while owning the session. Provider error/abort stops without automatic retry.
- Await actual p2J callable-capability evaluation within the deadline. Pass taskId, pinned dependencies and prior host verdict explicitly; compare only verdict === "verified". Unknown acceptance checkpoints without a worker retry.
- Select checkpoints only from native getBranch(), never getEntries() across inactive siblings. Append native custom checkpoints before effects, after prompt completion, and after checks. Fsync persistent checkpoint bytes. Bound task identity, goal, initial source, acceptance IDs, attempts and deadline immutably across resume.
- Resume a completed prompt recorded on the active branch at fresh trusted checks, never by replaying its effects. A saved success also requires fresh checks. An interrupted prompt is uncertain: require reconciliation, never automatic replay.
- Atomic exclusive session lock rejects duplicate/concurrent owners. Never steal locks. Busy unrelated sessions are not aborted. An operation ignoring deadline cancellation quarantines the lock until host reconciliation.
- Failed checks supply concrete feedback. J's repeated-failure hint stops nonprogress; failures never become verified by assistant assertion. Host progress prose cannot flip acceptance.
- Usage is delegated from host-normalized timestamped records; preserve unknowns. No token estimates, subscription-spend claims or multiplier claims.

## Trust boundary and limits

Trusted host selects source SHA, required check IDs, executable checks and independent oracle provenance. The acceptance adapter invokes host-only callable checks and then validates documents; it cannot authenticate a malicious host. Its source observer must fence clean/immutable source, not just a dirty tree's HEAD. Check callbacks must be read-only, abort-aware and bounded by their own runner. Only trusted host code may normalize receipts or decide progress fingerprints. Same-UID transcript/lock tampering, system power-loss filesystem guarantees and arbitrary tool rollback are outside this slice. Native agent tools must honor cancellation; uncertain operations remain quarantined. Attempt count bounds prompts, not requests inside a tool-using native run. This is not a total provider-token quota implementation.

## Acceptance

Native faux-provider tests compose actual A/D/H/J modules and unchanged #51 prerequisite: failed independent file check → repair tool writes file → fresh verified result; claim-only rejection; attempt/deadline/quota and host-eligibility stops; no retry after provider refusal; disk reopen without repeated effect; saved success is not an oracle; concurrent-owner rejection; unknown awaited verdict; deadline during evaluation; dependency binding and receipt-command rejection. Targeted tests plus full receiving-head npm run check, with a nonblocking heavy-job lock. Faux fixtures prove control flow, not cheap-model gains. p2D alone runs the pre-registered same-model measured pilot; no smoke dataset or held-out grader key belongs in the production import graph.
