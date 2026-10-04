# Plan 330 — shared session host (sketch by contract seams)

Seams (each owned per the role contracts; integration serialized in this worktree):

1. **Host (p4 contract — concrete runtime):** `packages/coding-agent/src/
   experimental/durable/` already constructs a durable session in-process
   (`openDurable`, `sessions.ts`). Add `shared-host.ts` + `shared-host-main.ts`:
   build N sessions via that construction, keep them in one isolate, and
   register them with an application-owned `SessionDirectory` +
   `SessionManagement` per the `packages/server` README example. Transport =
   `createUnixServer`/`getUnixSocketPath`. **Default OFF**: the host main is a
   separate entry (`pi-shared-host`); nothing in the normal startup path
   changes.

2. **Thin client (pD contract — client):** connect `packages/client` to the
   unix socket, `attachClient()` per session, present transcript state only
   (no per-presentation agent loop). The canary's clients are headless.

3. **Memory measurement (p3 contract):** reuse the A-marginal driver shape
   (`r4` evidence, proof-OK captures) — canary prints measured values only;
   optional `tools/mem-probe` snapshot per run.

4. **Isolation/recovery falsifiers (p9 contract):** kill-9 the host mid-turn,
   resume sessions from durable storage (packages/durable resume); assert
   cross-session isolation (separate transcript files, no shared mutable
   session state beyond the isolate's module singletons); verify attachment
   semantics (idempotent attach; stale routes rejected).

5. **Packaging (p7 contract):** entry wiring + flag documented in the host
   README; PR shape = minimal-diff upstream-ready addition (U2), default-OFF
   noted in the PR body; no Nix activation in this slice.

Testing shape: synthetic provider only (test-suite faux provider pattern),
offline; static acceptance = check + server/client/durable suites + the
canary; no paid calls; no fleet activation.
