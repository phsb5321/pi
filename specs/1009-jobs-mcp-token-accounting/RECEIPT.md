# jobs-mcp token-accounting QA — measured checkpoint

Seat `ms-qa` (transcript identity; pane role label lost at reboot). OWN `pi-upstream-005-shared-isolation`. Operator directive 09/10 17:26 BRT; pickup **17:31**, checkpoint **17:52 BRT**. All numbers below are measured from the live pi runtime and on-disk job records — no fixture theater, no fabricated acceptance.

## PRIMARY FINDING — the premise is false

The directive's "verified context" states pi sessions declare a jobs MCP server (`mcp__jobs__job_submit/job_wait/job_pool_status/job_status/job_list`) with `exposure: codemode` in all four `~/.pi` agent dirs. **It does not exist in this environment.** Evidence (commands + exits):

| Check | Command | Result |
|---|---|---|
| four agent `mcp.json` | `cat` + `sha256sum` on `~/.pi/{agent,agent-gpt-a,agent-gpt-b,agent-gpt-c}/mcp.json` | all four byte-identical (`696424e78720479f…`), declare **only `browser-fleet`** (exposure:codemode); no jobs |
| live tool registry | codemode `ALL_TOOLS` | 18 nested = 12 builtins + 6 `mcp__browser_fleet__*`; **0 `mcp__jobs__*`** (`anyJobsToolAnywhere=false`) |
| pi source | `grep job_submit\|job_wait\|job_pool_status` in pi package | **no hits** — not a pi built-in |
| other servers | `cat ~/.jcode/mcp.json ~/.cursor/mcp.json`; `find /nix/store -name '*jobs-mcp*'` | jcode=search_vault/cua_repl/node_repl, cursor={}, no jobs-mcp binary |
| name origin | `grep` | `mcp__jobs` names appear only in `~/.claude/skills/codemode/SKILL.md` (prose/contract), not an installed server |

**Consequence:** the two literal measurements requested — declared-tool tokens *with and without the jobs server connected*, and the exact byte size of *a job_wait result* — cannot be run against the jobs server. I measured claim (a)'s mechanism against the one real connected codemode-exposed server (`browser-fleet`), and claim (b)'s raw-record side against pi's real job-queue records. A live `job_wait` result is unobtainable. I did not fabricate either.

## Claim (a) — codemode keeps tool schemas OUT of model-visible declarations

Measured via codemode `describeTool` on the 6 `mcp__browser_fleet__*` tools (the real connected codemode-exposed server; same mechanism the jobs server would use):

- **full declarations total = 1952 bytes** (what `exposure: direct` would push into per-turn declarations)
- **prose paid per turn (codemode listing) = 650 bytes**
- **schema kept OUT of model-visible declarations = 1302 bytes (~326 tokens)**  [650 + 1302 = 1952 ✓]
- token heuristic `bytes/4` (approx); bytes are exact.

Proof of absence: these 6 tools are **not** top-level model-declared functions (`any_browser_fleet_tool_top_level=false`); they live only in codemode's nested registry, reachable at runtime via `describeTool`. Their 1302-byte input schemas are therefore absent from the per-turn tool declarations. **Before/after:** codemode-exposed connection adds only the 650 B prose listing and keeps the 1302 B schemas out; `exposure: direct` would add the full 1952 B. Delta saved = 1302 B/turn.

Raw: `measurements.json` → `claim_a_...`. Verdict: **claim (a) SUPPORTED** (mechanism), not measured against the absent jobs server.

## Claim (b) — job_wait returns a filtered result, never the raw job record

Raw-record side measured across **578 completed** job records in `~/.local/state/desktop-job-queue/jobs/*.json` (`claim-b-job-record.py` → `claim-b-job-record.out`, exit 0):

- **full job record = 498,765 bytes total** (union of 21 fields: `args, attempts, class, command, created_at, cwd, exit, finished_at, id, idempotency_key, log, not_before, note, pid, project, refusals, slot, started_at, state, timeout_seconds, ttl_seconds`)
- **kept record fields `{exit, log}` = 48,184 bytes**
- **FILTERING DELTA (metadata job_wait drops) = 450,581 bytes** (mean 779.6 B/record)
- biggest dropped field: **`args` = 223,161 bytes** (the full command+script payload), plus `pid`, `idempotency_key`, `slot`, timestamps, `command`, `cwd`, `state`, `ttl_seconds`, etc.
- `log_tail` is content job_wait **adds** from the log file (483,114 B total) — separate from record metadata; `note` is server-generated (unmeasurable without invoking job_wait).

Honesty caveat: the exact live `job_wait` **result** byte size is **unmeasurable** (server absent). The keep-set side is the documented `job_wait` contract applied to real record values. The measured delta is the record metadata `job_wait` does not return. Verdict: **claim (b) raw-record side SUPPORTED** (records carry 21 metadata fields the keep-set excludes); the exact result-vs-record byte delta cannot be completed without a live `job_wait`.

## Falsifiers

- **Claim (a) falsifier:** inspect the actual request `tools` array pi sends while a server is `exposure: codemode`; if a codemode-exposed tool's full JSON `inputSchema` is present there (or the tool is a top-level function carrying its schema), claim (a) is **false**. Current run: the 6 browser-fleet schemas (1302 B) are absent from top-level declarations → claim holds.
- **Claim (b) falsifier:** capture a real `job_wait` result containing any raw-record-only field (`args, pid, idempotency_key, slot, created_at/started_at/finished_at, command, cwd, state, ttl_seconds, timeout_seconds, class, project, id`) or byte-identical to the full raw record → claim (b) **false**. Current run: real records carry these fields (e.g. `args`=223,161 B), excluded from the keep-set → claim holds as far as measurable.

## Files (OWN repo `specs/1009-jobs-mcp-token-accounting/`)

- `measurements.json` — consolidated measured numbers + falsifiers + premise finding
- `claim-b-job-record.py` / `.out` — raw-record measurement script + output (exit 0)
- `claim-a` numbers captured from codemode `describeTool` (in `measurements.json`)

Knowledge note: vault `3. Resources/` (jobs-mcp token accounting finding). Nothing staged/committed. No fixture, no fabricated job_wait result, no credentials/HTTP.
