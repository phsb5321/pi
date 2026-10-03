# Asynchronous credential and trash command delivery

Integration date: 03/10/2026. Source patch provenance: input-freeze-fix
0fab42b25c4907960be29e9d2ea3a2ac500a3d72, originally based on v0.99.1.
That is source provenance: observed desktop seats still run v0.99.0.

The candidate applies to memory-sound ab9c9fa6. Key and provider header
resolution already return promises, so their shell-command waits can leave the
Node event loop. Synchronous public resolver exports remain compatible. The
credential path still executes an uncached helper per request, preserving
account rotation; cached auth-storage readers and synchronous users share completed results. Concurrent async cached calls coalesce; clearing in flight prevents stale cache repopulation.
Only async exports with actual production callers are added.

Integration fixed invalid Node spawn/exec option types in the original patch.
Node's execFile/exec now provide UTF-8 decoding and a 1 MiB output bound instead
of unbounded string accumulation; command timeouts are 10 seconds. Captured
stderr is also bounded, so an excessively noisy helper refuses. Trash uses the
same async native primitive and preserves the existing unlink fallback.

The original standalone mechanism fixture is incorporated into the existing
Vitest resolver suite. It exercises real slow child commands, event-loop timer
progress, literal/scoped environment values, errors, cache preservation,
uncached freshness, asynchronous headers and output overflow. A reproduced cancellation failure is fixed with the existing abort helper: one
reader can cancel without cancelling the shared credential subprocess. A preexisting
10 ms concurrent-prompt test race now waits for observed streaming state. The
native filesystem watcher test checks actual branch convergence without
assuming exactly one OS notification batch; exact debounce counts remain in
the controlled-clock tests. No real secrets,
provider calls or session deletion are used for those checks.

Remaining synchronous callers include MCP transport configuration and OAuth
factory paths whose public synchronous contracts require a separate change.
This slice does not claim that every synchronous operation or all desktop
latency is eliminated. Runtime adoption requires a disposable session canary
and one idle existing seat with exact transcript/model preservation.
