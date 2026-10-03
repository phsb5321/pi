# Bounded streaming shell output — delivery, 03/10/2026

The interactive `BashExecutionComponent` previously retained and rejoined the entire streamed output. It now keeps the last `DEFAULT_MAX_BYTES + 4` UTF-16 code units and uses the existing `truncateTail` for display (50 KiB / 2000 lines). No durable/session storage is changed: transcript `BashResult` comes from `executeBash`, and this component's `getOutput()` has no in-tree callers.

The raw suffix preserves line boundaries and split surrogate pairs. Repeated truncation is not associative, so display truncation is applied only to that raw suffix. The raw retention ceiling is a count of UTF-16 units, not a 50 KiB allocation claim; UTF-8 encoding can use three bytes per retained unit. Input normalization remains in the existing caller.

V8 sliced strings can keep a complete parent allocation alive. A UTF-16 buffer round trip detaches the retained suffix without replacing unpaired surrogates. A subprocess regression creates a random 32 MiB source string, drops temporary references at the next event-loop turn, runs GC, and requires retained heap plus external allocation below 8 MiB. This tests actual backing retention rather than string length alone. It does not claim a fleet RSS reduction.

The 11 focused tests also compare every append to `truncateTail(full)` and `Buffer.byteLength(full)`, including 15,000 seeded Unicode/chunk/cap combinations, partial first lines, trailing newlines, split surrogate pairs, empty chunks, and invalid bounds. Display text and truncation flags match the full-stream oracle; raw output is an exact suffix and dropped-byte accounting matches the full concatenation.

Validation: all 11 focused tests, static checks, offline build, and the isolated full suite pass (5564 Vitest tests plus 24 script checks; 911 intentional skips). An initial direct `npm test` run tried the installed but unavailable Ollama service; use the repository's existing `./test.sh` isolation, which disables local/provider integration and removes user credentials.

Scope: source proposal only, no occupied session, provider, model or live runtime changed. Native pD's original source is preserved in its desktop worktree; this integration adds physical-retention and validation corrections. Revert the eventual commit through a PR to undo the change.
