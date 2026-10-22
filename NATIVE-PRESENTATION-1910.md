# Native shared-host presentation

## Plan

The accepted shared SDK exposes native durable state, but the existing string
`observe` canary neither subscribes to that state nor cancels the actual task.
Publish the existing immutable `DurableView` through Chord's native replicated
state service. Route commands through the same SDK dispatch and active-work
barrier. Adapt the existing routed client transport to `DurableViewSource` and
`DurableController`, then render the existing `DurableTui` without a Harness in
the presentation.

The implementation is opt-in. It starts no daemon, creates no provider request
on import, changes no installed model/account policy and migrates no live seat.
Each application remains responsible for its session allowlist and account-bound
model runtimes. Never share one credentials runtime across unrelated accounts.

`createSharedDurableUnixHost({socket, serverId, sessions, policy, hydrate})`
composes the existing native server services and SDK residency. The fixed session
partition rejects unknown IDs and mutation. Supply `hydrate.modelRuntime` as a
per-session resolver for separate account contexts; that context is resolved once
and retained across reopen. `runSharedDurableTui({socket, serverId, sessionId,
settings})` consumes the existing TUI and closes its transport on exit. Neither
entry starts automatically.

## Tasks and acceptance

- Preserve original pD/p4/p9 worktrees and p3's frozen measurement packet.
- Publish typed native state and controller over the existing Chord endpoint;
  unsubscribe and drop SDK references on presentation release.
- Use the actual native client/server Unix protocol in the two-session test.
- Render existing TUI widgets in the existing xterm terminal harness; verify
  streamed partials before settlement, registered tool/result, actual task abort,
  private session isolation, stale attachment rejection and storage-preserving
  park/reopen.
- Require full source checks and exact-head native acceptance before normal PR
  merge. A source fixture with reused dependencies is advisory until the composed
  immutable artifact is qualified.
- Under the existing admitted offhost allocation, run matched baseline/shared
  process-tree PSS+SwapPss at idle/mid-turn/peak for N=1/8/32 where admitted. Keep
  identical history/workload/concurrency and count every terminal, client,
  daemon and worker. Refusal or missing rows is not a measured RAM improvement.

## Runnable checks

```sh
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --experimental-strip-types packages/coding-agent/test/durable-presentation-contract.ts
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --expose-gc --experimental-strip-types packages/coding-agent/test/native-durable-presentation.ts
node --experimental-strip-types packages/coding-agent/test/durable-presentation-imports.ts
npm run check
```

The first check uses a DTO fixture and the actual Chord endpoint. The second uses
the real SDK, storage, Unix protocol and rendered xterm harness with a **faux,
network-free provider**. Neither is successful production model inference or a
whole-fleet RAM measurement. A real PTY pilot and paired memory rows are separate
acceptance; 100x remains unproven.

## Measured source acceptance — 04/10/2026

One serialized Nix.Server source artifact, using the accepted `4f5f5366` lock and
copied root **and workspace-local** dependencies, passed full `npm run check`,
model-data validation, the native Chord contract, the presentation import
boundary, **15 SDK/Unix/rendered-xterm cases** and **19 native reclamation cases**.
The native cases include B remaining active during A-only abort, foreign/stale
attachment rejection, actual tool/result, incremental rendering, private model
contexts and SQLite stores, park/reopen and WeakRef GC after typed subscription
release. The import regression excludes SDK creation and ModelRuntime from the
client's local graph; it reports 498 presentation modules and excludes external
packages, so it establishes no memory reduction.

The existing allocation was CPU200%, 2GiB, zero swap and Tasks96. Memory peak was
2,103,398,400 bytes during source checking, with zero OOM or task-limit events.
The owned scope exited and its cgroup disappeared. These are test resource
measurements, **not baseline/shared PSS+SwapPss**. Source packet and sanitized
commands: `~/.local/state/pi-programme-20261004/portfolio-pi-pilot-1910/`.

Rollback: remove the opt-in presentation composition. Existing single-session
entry points and pD's source/WIP remain intact.
