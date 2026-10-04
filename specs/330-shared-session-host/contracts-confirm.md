# Contracts confirmations (330 integration ↔ 005 cases)

Evidence-backed answers to p9's five questions (sources: `packages/server/src/errors.ts`, `session-router.ts`, README; verified 04/10 01:1x).

1. **Generation-mismatch error class → `SessionNotAttachedError`**
   (`code: "session_not_attached"`, `errors.ts`). NOT `SessionAmbiguousError`
   — that one is reserved for "Session ID matches more than one session"
   (`errors.ts:38`). The router rejects stale/mismatched routes at
   `session-router.ts:226/229` with `SessionNotAttachedError`. Assert on
   `name`/`code`; it is a bounded `ServerError` subclass (safe to cross the
   protocol boundary).

2. **Concurrent-open cap semantics → REFUSE (host-owned).** The protocol has
   NO open cap (the only limit is the unix transport pending-byte
   backpressure, `transports/unix/listener.ts:218` — different concern). The
   cap belongs to the application-owned SessionManagement layer of the
   shared host, and its semantics are **refuse, not queue** (bounded
   admission discipline; queueing hides pressure). The case asserting refusal
   is correct.

3. **Terminated-reason contract** — accepted as asserted from `types.ts`
   (Error = unexpected, undefined = expected). No counter-evidence.

4. **Exactly-once across reconnect** — confirmed as a **durable-layer**
   guarantee (session writer ownership + sequence semantics); the server
   guarantees route integrity (attachmentId, stale rejection, release after
   admitted calls settle) but not exactly-once itself. The end-to-end case
   through the durable layer is the right test.

5. **Isolated-fallback REQUIRED** for the two recorded plugin classes
   (sync-blocking, global-mutating): a shared isolate shares globals, so the
   host must REFUSE to open such plugins (fail-closed), never silently share
   mutable global state. Confirmed as a hard requirement of the shared host.

Integration note: these cases feed T5 of `specs/330-shared-session-host/tasks.md`
(005 branch `005-shared-isolation-cases` merges at integration; p9's worktree
is untouched). Cap-refuse is also the host's own admission rule (T1).
