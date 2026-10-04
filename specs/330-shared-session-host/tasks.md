# Tasks 330 — shared session host (ordered; one worktree)

- [ ] T1 host core: `experimental/durable/shared-host.ts` — N sessions in one
      isolate via the openDurable construction; application-owned
      SessionDirectory/SessionManagement; unix RoutedServerServiceHost.
- [ ] T2 host entry: `shared-host-main.ts` — CLI (`--sessions N --socket P`),
      default-OFF (separate entry; zero changes to normal startup).
- [ ] T3 thin client: headless attach via `packages/client`
      (`attachClient`, invokeService, transcript state); no agent loop.
- [ ] T4 canary: `experimental/durable/shared-host-canary.ts` — synthetic
      provider, >=3 sessions, >=2 clients, scripted turns, isolation asserts,
      measured-values-only memory print, clean exit codes (0 ok / 3 assert).
- [ ] T5 falsifiers: kill-9 host -> durable resume; cross-session isolation;
      attach idempotency + stale-route rejection (server semantics).
- [ ] T6 acceptance: npm run check; server/client/durable/offline suites;
      canary run; spec/plan/tasks boxes ticked.
- [ ] T7 PR: branch push (DECLARE-CHECKLIST line 1), ordinary PR body
      (default-OFF + measured honesty: no savings claims in this slice),
      MS-05 gate note attached.

Serialization note: implement strictly in order T1..T7; p4/pD/p3/p9/p7
contracts are read-only inputs (no edits to their artifacts); PR4 and other
WIP preserved (this worktree touches only its own files).
