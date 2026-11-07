# Gateway queue status

The built-in `gateway-queue` extension displays held Claude gateway requests in the TUI footer and RPC extension status channel:

```text
Queued: weekly pacing | waited 10s | next check in 15s
```

The check interval is advisory, not an estimate of when generation will start. The original model request stays pending. Cancelling it uses the normal abort path; the native Anthropic adapter cancels and releases its body reader even while no stream data arrives.

The consumer accepts only the configured `claude-lane` model at loopback HTTP port 8765, a successful response marked `x-anthropic-throttle-proxy: 1`, and an Anthropic `ping` containing:

```json
{"type":"ping","throttler_queue":{"version":1,"source":"throttler-gateway","state":"waiting","reason":"weekly_pacing","elapsed_ms":10000,"next_check_ms":15000}}
```

Reasons are `queue`, `weekly_pacing`, and `retry_after`. Durations must be finite, nonnegative numbers within the safe numeric range. Status clears when generation begins, the request changes, the turn settles or is cancelled, the model changes, or the session shuts down. Malformed, foreign-origin, unmarked and unsupported metadata is ignored. Print/JSON modes do not render this UI.

A separate native pre-egress maintenance wait is displayed as `Waiting: maintenance (pre-egress)`. It is an actual HTTP503 refusal, not an SSE ping or model output. The adapter requires the exact configured loopback Claude POST/model, direct unredirected response URL, exact bounded admission-closed body, both gateway/admission markers and a valid bounded Retry-After. REQUIRES gateway PR21 anti-spoof stripping on EVERY configured relay tier, even when upstream claims to be another gateway. Old producer d47/#20 is UNSAFE and cannot be used with this feature. Client fixture tests do not prove producer anti-spoof safety; producer acceptance and exact loaded-chain qualification are deployment gates.

Native patient waiting is **off by default**, including against today's old runtime. A trusted in-process host must supply `gatewayPreEgressTrust: { origin, verify(signal) }`. The exact canonical origin must match the request. The verifier is checked on every candidate refusal and again before resending after a wait. Missing, false, unknown, stale, failed or revoked verification never grants patient replay. Model response headers cannot supply this function, and a normal marker or merged source hash cannot substitute for it.

There is deliberately no production issuer wired into the SDK, launcher, environment, fleet config or pane. p1 must first define and provide fresh loaded-code/transport proof for the WHOLE configured relay chain, including central, tied to its origin and invalidated across process/config/chain changes. A permanent `verify: () => true` is appropriate ONLY for isolated synthetic tests, never for production. Without that integration the feature remains disabled; a client unit test is not a trust attestation.

The same serialized request waits inside one SDK fetch and retains its original abort/timeout signal and explicit retry-delay ceiling; refusal checks do not consume the ordinary provider retry count. Explicit `timeoutMs` is one end-to-end deadline on the capability-enabled call, never renewed by provider retries; its owned timer is cleared on exit. Cancellation also interrupts a pending asynchronous verifier. Trust revocation is unwrapped from the SDK transport error so it cannot trigger ordinary provider retries. No replay is allowed after a real model response or unknown transport outcome. The existing SDK default transport timeout is unchanged; this is not an unbounded-duration guarantee. The typed `preEgressWait` observer reports `waiting`/`ended` at the original HTTP503 status and clears on exit, including cancellation.

This extension does not submit prompts, retry errors, change models or accounts, renew deadlines, spend tokens, or add transcript entries. Explicit patience and inherited cancellation remain authoritative. It does not reconnect remote operations after a process restart; durable task recovery needs a separate operation identity and unknown-outcome contract before replay can be safe.

Like other built-ins, it can be disabled with `-builtin:gateway-queue` in the `extensions` setting, or with `--no-extensions`.
