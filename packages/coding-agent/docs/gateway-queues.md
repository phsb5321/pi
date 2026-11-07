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

This extension does not submit prompts, retry errors, change models or accounts, renew deadlines, spend tokens, or add transcript entries. Explicit patience and inherited cancellation remain authoritative. It does not reconnect remote operations after a process restart; durable task recovery needs a separate operation identity and unknown-outcome contract before replay can be safe.

Like other built-ins, it can be disabled with `-builtin:gateway-queue` in the `extensions` setting, or with `--no-extensions`.
