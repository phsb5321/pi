# Local gateway patient-wait host issuer

The native maintenance-wait adapter is disabled unless a trusted host verifies the producer. A matching 503 body/header is not proof: an old forwarding tier can launder those stamps from upstream.

Ordinary CLI, TUI and RPC sessions use the same `createAgentSession()` request builder. For Linux `claude-lane` / `anthropic-messages` / `claude-*` requests, it supplies an origin-bound verifier. Other models/providers are unchanged. No model selection, credential, context, tool or retry-policy setting is changed. Explicit SDK-supplied `gatewayPreEgressTrust` remains a trusted host override.

## Supported deployment

Only the exact configured `http://127.0.0.1:8765`, `http://localhost:8765` or `http://[::1]:8765` origin with base path `/` or `/v1` is eligible. Userinfo, query, fragment and other paths are rejected. No URL or executable is discovered from model output, response headers or configuration documents.

The initial host supports **direct routes only**. A nonblank or unknown actual central route fails closed. An unused central does not block a qualified direct route. Supporting a used central later requires independent, fresh qualification of every actual hop; this implementation does not follow a self-advertised central URL.

## Explicit deployment acceptance

The gateway rollout owner must first qualify the complete live route, immutable source/module lineage, transport binding and genuine-error behavior. It then atomically publishes an owner-only regular file at:

```text
~/.local/state/throttler-gateway/accepted-chain.json
```

The file is runtime authorization/expected deployment identity, **not runtime proof**. No file is generated automatically from a candidate receipt, note, response marker, HTTP200, default symlink, package version or source PR. Do not publish it before whole-path qualification. There is no daemon or background renewal.

The JSON object has these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `origin` | Exact configured eligible logical origin |
| `sourceRev` | Qualified 40-character lower-case source commit, mapped to installed bytes by the rollout owner |
| `build` | Exact imported `/nix/store/<hash>-throttler-gateway-<version>/lib/python3.<minor>/site-packages/anthropic_throttle_proxy` directory |
| `pid`, `invocationId`, `startedMonotonic` | Current systemd PID, 32-character invocation ID and positive monotonic start timestamp string |
| `modules` | Exactly the qualified `proxy.py`, `forwarding.py`, `capability.py` basename→lower-case SHA256 map |
| `configSha256` | Qualified fingerprint of every effective trust/forwarding-relevant configuration input |
| `acceptedAt`, `expiresAt` | Integer epoch milliseconds; interval at most one hour, neither future nor expired |

The final path is opened without following a symlink, nonblocking; it must be a regular file owned by the current UID, mode0600, at most16KiB. A missing, malformed or unsupported file grants nothing. Replacement/expiry revokes an already-issued request capability. Only the deployment owner may republish after renewed actual qualification. A candidate artifact is never enough.

## Fresh verification

On each candidate maintenance refusal and before each resend, the host:

1. Reads current deployment acceptance.
2. Reads fixed systemd service identity fields with fixed read-only argv. No shell, discovered executable, `Environment` dump or secret is used.
3. Hashes all three exact immutable module files **before any capability GET**. Missing/drifted capability code denies locally: old producers catch-all forward unknown routes and must never be probed as a fallback.
4. Challenges the fixed control-plane path `/__throttle/pre-egress-capability?nonce=<64 lower-case hex>` twice with fresh nonces, then rechecks systemd identity and unchanged acceptance. Only schema1 / `gateway-pre-egress-capability`, exact nonce/PID/invocation/imported build/module hashes/config fingerprint and direct route match is accepted. Restart, pending unit reload, hot route/config drift, old/unknown schema/code and stale/replayed responses deny.

The capability is an in-process producer contract, not a health/header claim. Its producer must capture immutable imported module fingerprints and expose current effective configuration even during genuine closed admission. The HTTP reader uses fixed local GETs without proxy discovery, credentials, redirects or vendor/model/probe calls. Responses/command output are bounded; each verification has a1.5s ceiling inside the inherited caller abort/deadline. Stalled observations fail closed. No successful result is cached; once issued, uncertainty permanently revokes that logical request's capability.

Trust is not capacity: verification never requires admission allowance, quota headroom or a model completion. Admission-closed and `allow=false` are valid identity-verification states. The unchanged native adapter still requires the exact status/body/method/path/model/stream stamps and refuses arbitrary503, genuine auth/quota errors, SSE/partial output or unknown outcomes. Patient sleep does not renew the original deadline.

## INITIAL maintenance fence

The host also wraps the actual native fetch boundary for this exact local route. It does not use `before_provider_request` (extension handler errors are advisory), interpret a 503 as an INITIAL handoff, or replay a settled operation. The native adapter already starts its effective deadline before payload callbacks and passes the combined deadline/caller signal through the HTTP request. The wrapper preserves that signal and captures the serialized body/headers once. Cancellation, expiry, refused/changed custody and cleanup errors terminate without provider retries. Other routes retain their original fetch option, including an absent option.

The rollout owner may atomically publish `~/.local/state/throttler-gateway/maintenance.json`, mode0600, with exactly:

```json
{"schemaVersion":1,"kind":"gateway-initial-maintenance","id":"<32 lowercase hex>","origin":"http://127.0.0.1:8765","startedAt":0,"expiresAt":1,"phase":"holding"}
```

Times are integer epoch milliseconds, not the illustrative placeholders; the window must be current and no longer than360s. `holding` defers; `released` additionally requires fresh verification of the accepted live generation before dispatch. `aborted`, invalid, missing-after-latch, expired or replaced windows fail closed. The identity/origin/original start and expiry cannot change while a request waits. The file is a host withholding instruction, NEVER a substitute for `accepted-chain.json` and genuine process/module/config/nonce observations.

Every participating fetch registers an owner-only lease in the private0700 `receiving/` directory BEFORE reading the window. A `.json` lease stays until response headers/error. A latched request atomically renames its lease to `.<window-id>.waiting`, then stays in that SAME fetch call without sending HTTP. The publisher MUST publish HOLDING BEFORE enumerating leases and MUST settle every pre-fence `.json` lease before closing admission; a newly registered reader then either appears in that inventory or sees HOLDING and never dispatches. Unknown/stale/foreign/malformed leases are a stop, not garbage-collection permission. Waiting leases are not old upstream work.

The one120s natural-drain deadline begins at window publication and includes lease settlement. Before replacing the gateway, require CLOSED admission and four strict integer-zero counters before that original deadline. Otherwise restore exact-prior admission and abort; independent restoration must complete within360s. Never stop a stream, renew the drain or restore controller automation. Only a genuinely supporting newly loaded generation can be joined/accepted and the SAME window atomically changed to `released`. Delete the window only after receiving/waiting leases have settled; removal while latched is a refusal, not release. Source/unit/fixture controls alone do not authorize this transaction or cover older/unobserved clients.

## Release boundary

The producer capability contract must be independently implemented/tested and its exact immutable artifact qualified by the producer/rollout owners. An older22 producer without this contract is unsupported and stays fail-closed. Host unit/native/AgentSession tests are not actual deployed producer, rendered TUI/RPC subprocess or all-instance loaded-code acceptance. Those remain separate canary and per-instance rollout gates. No Ghostty/Herdr server restart, `/reload` or default-symlink change proves that existing Pi processes loaded these bytes.
