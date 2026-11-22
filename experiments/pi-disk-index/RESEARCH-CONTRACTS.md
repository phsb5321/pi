# Disk-backed Pi / Herdr research contracts

These 24 tasks are concrete scoped research and engineering contracts. They are **not** admitted GPT turns or active browser tabs. Use the original fleet dispatcher to acquire a native chat and exact acknowledgement before marking a task running. Source prototype: [draft PR #58](https://github.com/phsb5321/pi/pull/58).

## Fork core

- [ ] **PI-DISK-R01 — Inventory exact persistent heap retainers**. Deliverable: Produce object graph of fileEntries/byId/state.messages plus hot paths. Acceptance: Independent heap snapshot attribution on pinned 1.5.2.
- [ ] **PI-DISK-R02 — Define durable entry-index contract**. Deliverable: Specify SQLite schema, transaction/rotation and JSONL source of truth. Acceptance: Documented crash and append semantics with fixture IDs.
- [ ] **PI-DISK-R03 — Implement offset-index integration**. Deliverable: Replace full-history read in an isolated candidate manager. Acceptance: Exact old/new entry and byte offset parity on 10k records.
- [ ] **PI-DISK-R04 — Branch and label parity**. Deliverable: Support sibling branches, labels, leaf moves, cycles and orphaned records. Acceptance: Frozen JSONL branch projection equals pinned manager.
- [ ] **PI-DISK-R05 — Compaction parity**. Deliverable: Handle summaries and token-effective active branch correctly. Acceptance: Historical compaction context equal before/after on fixtures.
- [ ] **PI-DISK-R06 — Tool-result hydration**. Deliverable: Bound large tool-result memory while preserving source bytes. Acceptance: Large tool-output fixture resumes without lost result IDs.
- [ ] **PI-DISK-R07 — Extension replay and state**. Deliverable: Document extension APIs that implicitly scan all old entries. Acceptance: Representative extension suite passes with bounded history API.
- [ ] **PI-DISK-R08 — Fork package/API contract**. Deliverable: Propose stable opt-in flags and disabled-by-default fallback. Acceptance: No default Pi CLI semantic change before merge.

## Herdr client and lifecycle

- [ ] **PI-DISK-R09 — Herdr stable seat descriptor**. Deliverable: Retain pane/workspace/tab/cwd/model/session identity on disk. Acceptance: Same exact seat ID across backend shutdown and reattach.
- [ ] **PI-DISK-R10 — Terminal thin-client design**. Deliverable: Keep Ghostty Herdr seat promptable while Pi backend absent. Acceptance: Native prompt accepted by same original pane with no empty session.
- [ ] **PI-DISK-R11 — Unsent draft and busy guard**. Deliverable: Design retention of drafts, tool processes and active generation state. Acceptance: No eviction with draft, generation, modal or unknown tool effect.
- [ ] **PI-DISK-R12 — Shared Pi backend worker pool**. Deliverable: Define multi-seat isolated worker lifecycle. Acceptance: 32 synthetic concurrent sessions with no cross-seat data leak.
- [ ] **PI-DISK-R13 — Idle worker eviction**. Deliverable: Dispose agents and release Node process at known settled boundary. Acceptance: Inactive worker PSS falls and exit is independently observed.
- [ ] **PI-DISK-R14 — Cold wake and reattach**. Deliverable: Restore original session tree, model, extensions and tool registry. Acceptance: One prompt resumes exact source session and maintains turn IDs.

## Durable task coordination

- [ ] **PI-DISK-R15 — Intent/ACK protocol integration**. Deliverable: Map per-seat prompt to durable idempotent outbox. Acceptance: Exactly one logical grant and no blind retry after uncertain effect.
- [ ] **PI-DISK-R16 — Crash and restart recovery**. Deliverable: Test partial JSONL, index corruption and daemon crash. Acceptance: Cold recovery reproduces exact transcript and no duplicate action.

## GPT headless adapter

- [ ] **PI-DISK-R17 — Headless GPT source-research control**. Deliverable: Map 24 work items to authenticated existing headless chats. Acceptance: Native project ID, chat ID, author and ACK receipt per active turn.
- [ ] **PI-DISK-R18 — Browser/profile ownership fences**. Deliverable: Keep one writer across Brave and headless identities. Acceptance: No two controllers send to same conversation.

## Measurement

- [ ] **PI-DISK-R19 — 32-seat memory A/B**. Deliverable: Measure PSS/anon/heap of deterministic history and runtime fixtures. Acceptance: Reproducible exact revision baseline and uncertainty intervals.
- [ ] **PI-DISK-R20 — 128-seat memory A/B**. Deliverable: Scale benchmark to 128 with idle/active mix. Acceptance: Measured proportional savings, disk IO and no OOM.
- [ ] **PI-DISK-R21 — Wake and active-task latency**. Deliverable: Measure cold attach, restored context, first token and tool completion. Acceptance: p50/p95/p99 distributions and baseline comparison.
- [ ] **PI-DISK-R22 — Resource cohort accounting**. Deliverable: Collect cgroup RAM/swap/PSI, process tree and disk traffic. Acceptance: No double-counted RSS and separate accepted task throughput.

## Packaging and QA

- [ ] **PI-DISK-R23 — Nix packaging and isolated CI**. Deliverable: Package candidate from merged SHA with reversible release. Acceptance: Source hash, green CI, exact Nix package and rollback proof.
- [ ] **PI-DISK-R24 — Activation and independent acceptance**. Deliverable: Install only after readiness release, verify exact live seat behavior. Acceptance: Merged/deployed/runtime-accepted separated with zero lost sessions.

## Acceptance order

Detached source checks → exact pinned Pi projection parity → native no-inference worker/seat tests → controlled turn delivery/ACK → merge → declarative package → independent active-seat acceptance → cgroup memory and swap delta. Preserve all uncertain sends and unfinished tool effects. Do not infer real fleet savings from the standalone synthetic experiment.
