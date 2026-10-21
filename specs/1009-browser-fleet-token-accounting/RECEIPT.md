# browser-fleet MCP token-accounting QA — measured checkpoint

Seat `ms-qa` (transcript identity). OWN `pi-upstream-005-shared-isolation`. Directive 09/10 19:22 BRT (re-target of the accepted jobs finding onto the live browser-fleet server). All numbers measured on the live server and live pi runs — no fixtures, no fabrication. Consolidated numbers: `measurements.json`.

## Runtime note (matters for reading the numbers)

Fleet sessions run **pi 0.99.1** (HM wrapper `/etc/profiles/per-user/notroot/bin/pi`; this session's `PI_FLEET_PIN=0.99.1+7f32a8d9`). The PATH `pi` shim (installed today 17:33) resolves `pi-fleet/current` = **1.1.0**, whose MCP semantics differ (system-prompt `mcp_servers` section, codemode description does not list tools, first prompt waits only for `direct` servers). Early arms on 1.1.0 showed the server never connecting before the request; all reported numbers below are from the 0.99.1 fleet runtime. Usage via `--mode json` events (`usage.input+cacheRead+cacheWrite`, deepseek/deepseek-v4-pro; the zai proxy reports usage zeros and was discarded).

## Claim (a) — codemode keeps tool schemas OUT of model-visible declarations: SUPPORTED

Before/after declared-tool tokens per turn (identical prompt/flags/cwd; `PI_CODING_AGENT_DIR` scratch configs differing only in `mcp.json`):

| Arm | Declared tools | Input-side tokens/turn | Δ vs A |
|---|---|---|---|
| A: no server (no `mcp.json`) | 12 (read…AskClaude) | **16,951** | — |
| B: server, `exposure:codemode` (fleet default) | 13 = A + `codemode`; **0 browser-fleet tools** | **21,468** | **+4,517** |
| C: server, `exposure:direct` (counterfactual) | 18 = A + 6 `mcp__browser-fleet__*` (schemas inline); no codemode | **17,591** | **+640** |

Schema-absence proof: arm B's declarations contain **zero** browser-fleet entries; the codemode entry (9,986 B; description 9,147 B) lists the 6 tools with 6 compact TS `codemode tool declaration` blocks but **0 JSON-schema markers**. The raw `inputSchema` JSON (1,198 B, captured from `tools/list`) never enters the declarations. Arm C shows them inline (`"parameters": {"type":"object",…}`, 2,321 B of entries) for +640 tok.

Honest nuances: (1) TS signatures of the nested tools ARE text in the codemode description — what is kept out is the JSON Schema tool declarations; (2) per-turn, codemode is **more** expensive for this 6-tool server (+4,517 vs +640 tok) — the schema-out property is structural (large tool lists stay out of the tools array under a shared budget), a win for big servers, not this one.

**Falsifier (a):** with `exposure:codemode`, any `mcp__browser-fleet__*` entry in the model-visible declarations, or a JSON-schema object in the codemode description ⇒ claim false. Measured: 0 and 0.

## Claim (b) — tool returns are filtered for the model: SUPPORTED

Full raw payload record on disk: `raw-payload.jsonl` (16,956 B, live stdio JSON-RPC capture). For `browser_identities`:

- raw JSON-RPC line **14,520 B** → CallToolResult **14,481 B** (39 B envelope) → `content[0].text` **12,774 B** = `{host, count, identities[68], wanted_not_running, note}`; per-record fields `identity, state, mode, unit, started_at, tunneled, local_port`.
- Model-visible side: default (no script forward) = **0 B of tool data** (a failed script whose tool call had already succeeded delivered only the error line — none of the 14.5 KB entered context); a real curated forward = **73 B** (`identities=68; states={"ready":68}; sample=aliexpress,amazon,amigos-share`) against a 14,475 B raw result in the same call.
- **THE DELTA = 14,402 B filtered out (99.5%)**: dropped per-record `local_port/mode/started_at/unit/tunneled`, 65 of 68 identity names, `wanted_not_running/note/host/count`, and the `content/isError` envelope. Design note (`🌐 Browser Fleet MCP — design & rollout`) matches: text-only returns, `max_chars` cap (default 2,000 / hard 20,000), screenshots and CDP passthrough rejected in-server so raw page/base64 payloads can't reach agent context.

**Falsifier (b):** a model-visible browser-fleet result containing any raw-record-only field (`local_port`, `started_at`, `unit`, `tunneled`, full identities list, `content/isError` envelope) or byte-identical to the raw CallToolResult ⇒ claim false. (Design note's own falsifier: `browser_run` base64 > 20,000 chars.) Measured: 73 B carried vs 14,475 B raw; no dropped field present.

## Commands / exits (all exit 0 unless noted)

- `python3 raw-mcp-capture.py` — live stdio capture: initialize + tools/list + browser_identities → `raw-payload.jsonl` (3 lines).
- `pi --print … --mode json "Reply with exactly OK"` × 3 arms under `PI_CODING_AGENT_DIR` → `arm-A-no-server-print.out`, `arm-B-codemode-print.out`, `arm-C-direct-print.out` (+ `.err`).
- codemode live calls (read-only `browser_identities`) — raw 14,475 B → curated 73 B measurement; one earlier script failed after its tool call succeeded (retained: default-forward-is-zero evidence).
- Methodology negatives retained: `arm-{no-mcp,with-codemode,with-codemode-ext}-rpc.jsonl` (pi 1.1.0 arms; server never connected pre-request), `ab-driver.py`.

## Files

`measurements.json` (consolidated), `raw-mcp-capture.py/.out`, `raw-payload.jsonl`, `ab-driver.py`, `arm-*-print.out/.err`, `arm-*-rpc.jsonl`. Knowledge: vault `3. Resources/🛠️ Tools/pi browser-fleet token accounting — measured 2026-10-09.md`. Nothing staged/committed. No browser was driven (read-only identities/status tooling only); no credentials in outputs.
