# Pi 0.99.0 async command backport — 03/10/2026

Actual installed source base: `4b060d3a98618019adb9985d517516c8e99a2bbe` (`v0.99.0`). The four production files have zero pre-change delta against the integration base. This branch carries the six-file production/test patch from corrected PR3 and the existing Together model-catalog compatibility correction required for an offline build.

Acceptance: actual CLI reports `0.99.0`; offline build and static checks pass. Full isolated suite passes6084 Vitest tests and24 script checks,912 intentional skips. The actual built AgentSession accepts the existing Nix command-bridge preload; a real200ms credential fixture permits18 timer ticks while resolving, with zero provider calls. Credential/header coalescing, cache clearing, uncached freshness, cancellation and bounded output are exercised by the unchanged regressions.

This is a source/runtime candidate, not existing-seat adoption. MCP/OAuth factories that still use synchronous configuration remain follow-ups. No live npm cache, wrapper, model, provider credential, occupied pane or global runtime was changed.

Runtime packaging should consume the four-file patch against the exact0.99.0 base. Do not merge this historical-base branch into the newer `memory-sound` branch (PR3 already carries its implementation there).
