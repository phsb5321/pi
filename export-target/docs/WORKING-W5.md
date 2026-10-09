# WORKING-W5 — Resend mode: full-history → delta/windowed, 02/10/2026 (pD)

Direction per `docs/WORKING-INSTANCE-BRIEF.md` (plan bf5659c3e): full-history
resend (`mode=Full`) re-materializes everything per turn → delta/windowed
resend where the transport allows; measure per-turn cost.

## Mechanism (as built)

Every LLM call re-sends the complete conversation: the provider request
builders (`packages/ai/src/api/*`) receive the full `messages` array per
call (stateless HTTP transports). Client-side the unchanged prefix is
re-serialized into the request body every turn. Provider-side prompt
caching exists (Anthropic `cache_control`, OpenAI cached-token accounting)
but does not remove the client re-serialization; one delta path already
exists in-tree (`getCachedWebSocketInputDelta`,
`packages/ai/src/api/openai-codex-responses.ts:1438` — websocket
continuation).

## Measured per-turn cost — worked cohort (02/10, pD)

Corpus: 30 worked sessions (of 443 ≥200 KB; host total 903 files),
per-turn payload = cumulative history bytes at each assistant turn
(full-history resend; metrics only):

| metric | p50 | p90 | max |
|---|---|---|---|
| per-turn resend payload (MiB) | **2.4** | **24.8** | 134.6 |
| largest single turn payload (MiB) | 5.8 | 46.6 | 303.1 |
| session-lifetime re-sent volume (MiB) | **1095** | **14436** | 126082 |
| amplification vs retained bytes | **177×** | **342×** | 652× |

A median worked session (5.8 MiB retained) re-sends **~1.1 GiB** over its
life; a p90 session **~14 GiB**. Memory side: request build transiently
materializes the serialized body (≈1–2× payload on the MS-22 stringify
shape) — **~2.4–4.8 MiB at p50, 25–50 MiB at p90, 300–600 MiB on the worst
turn** — this is a peak class (swap hits) shared with W4. G4 worked cohort
mid-turn row (n=6, mem-probe v1.2.2): 125.2/120.1 P50, sampled mid max
142.6 (true peak capture = W4's `peak_at` fix).

**Ceiling for the lossless delta variant:** re-serialization of the
unchanged prefix goes to ~0 (send delta + rely on cache/continuation where
the transport supports it) ⇒ per-turn transient ≈ delta bytes (KB–low-MiB)
instead of 2.4–303 MiB; fleet-wide the avoided re-send churn is the p90
turn spikes (the swap-storm class).

## What "where the transport allows" means (lossless line)

- **GO — delta resend, exactly-equivalent requests:** provider cache
  breakpoints (Anthropic `cache_control` prefix marking; OpenAI automatic
  prefix caching) + transport continuation (codex websocket delta) + skip
  client-side re-stringify of the unchanged prefix (keep one cached
  serialized prefix per conversation, invalidate on history mutation).
- **NO-GO — lossy windowing/dropping resend:** sending a *shorter* history
  changes model behavior. That is compaction (W2), whose summary semantics
  are upstream policy — not the resend layer. The resend layer never drops
  content.

## Effort / risk

**Effort M.** Risks: (1) cache-breakpoint placement must be byte-exact or
providers silently miss cache (measure cache-hit rate as acceptance);
(2) history mutation paths (edit/branch/compaction) must invalidate the
cached prefix — the kill−9/conformance suites cover byte-identical resume
because the JSONL path is untouched. Behavior identity: requests are
content-identical (same messages) ⇒ behavior-identical by construction for
the GO variant.

## Plugin matrix row

**invisible** (transport/serialization substrate; message content and
provider semantics unchanged). The request-billing surface (cached tokens)
is already user-visible on upstream builds; documented, not changed.

## PR shape

**U3** (client-side: cached serialized prefix + cache-breakpoint marking,
per provider where supported) with a U2 issue-first step for any new
transport continuation surface. Changelog per package (`packages/ai`),
parks behind MS-05 until `lgtm`.

## GO/NO-GO

**GO** for the lossless delta variant (measured: 177–342× resend
amplification, 2.4–303 MiB per-turn transient; ceiling ≈ prefix
re-serialization + p90 spikes removed). **NO-GO** for any lossy
windowed resend (it is W2's job, upstream-policy gated).
