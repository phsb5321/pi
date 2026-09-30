# Node/V8 memory optimization for long-lived pi seats — research brief

Date: 30/09/2026 · Scope: fork `phsb5321/pi` (monorepo root), goal **behavior-identical, fraction of the RAM**, PRs back upstream.
Node under test: v22.23.2 (desktop). Measurement: `PSS + SwapPss` from `/proc/<pid>/smaps_rollup`.
**Fork-only evidence document — never PR this file upstream** (fleet numbers + U-ranks are fork context).
Knowledge copy: vault `1. Projects/Memory-Sound Program/node-v8-memory-research-2026-09-30.md` (points here).

Reference numbers (fleet, given at brief time): **181.5 MiB per idle seat (PSS+SwapPss), 215 seats = 39 GiB; bare `node` ≈ 50 MiB.**
Superseded as of the MS-04 census ([MEMORY-BASELINE.md](MEMORY-BASELINE.md), 30/09/2026 14:47 BRT, 306 seats): fleet idle mean **139.7 MiB/seat** (PSS+SwapPss), fleet total **43.08 GiB** (PSS 35.68 + SwapPss 7.40, 17.2 % swap); age bands: fresh same-day ≈ 99 MiB, 3-day side-projects cohort 177.5–181.5 MiB. All claims below carry both where they differ.

---

## 0. Where the memory actually goes (measured today, this host)

Five live `pi` seats on desktop, 30/09/2026 14:39 BRT (`/proc/<pid>/smaps_rollup`):

| PID | Rss (kB) | Pss (kB) | SwapPss (kB) | PSS+SwapPss (MiB) | Private_Dirty (kB) | Shared_Clean (kB) |
|-----|---------:|---------:|-------------:|------------------:|-------------------:|------------------:|
| 4587  | 146,772 |  88,917 |     0 |  84.8 |  88,460 | 58,256 |
| 7177  | 178,408 | 155,858 | 51,688 | 207.5 | 155,736 | 22,616 |
| 16013 | 144,896 | 122,604 | 29,780 | 152.4 | 122,484 | 22,356 |
| 16270 | 142,744 |  84,779 |     0 |  84.8 |  84,320 | 58,368 |
| 18946 | 141,640 | 119,368 | 23,048 | 142.4 | 119,248 | 22,336 |

- Mean idle seat ≈ **134 MiB PSS+SwapPss** (n=5; consistent with MS-04's 139.7 fleet mean and the 181.5 cohort figure).
- Bare `node -e` idle on the same build: **44.5 MiB RSS**.
- **The per-seat cost is `Private_Dirty` (84–156 MiB)**: JS heap + JIT code + native/WASM allocations. File-backed code pages already share between seats (22–58 MiB `Shared_Clean`). Deduplicating *code* across processes buys little; the win must come from (a) not keeping seats resident at all, (b) shrinking each seat's private heap.

What one seat loads today (repo evidence):
- Single esbuild bundle (`packages/coding-agent/dist/bundle/cli.js`, built by `scripts/build-coding-agent-bundle.mjs`) with only `@earendil-works/chord`, `@silvia-odwyer/photon-node`, `jiti`, and optional native accelerators external. Everything else — `quickjs-wasi` (WASM QuickJS for the `codemode` tool, `packages/codemode`), `highlight.js`, `diff`, `grok-mermaid`, `undici`, `typebox`, `yaml`, `minimatch`… — is evaluated into the heap at boot (`packages/coding-agent/package.json`).
- The whole session tree is resident: `JsonlStorage` wraps an `InMemoryStorageState` holding **every** entry (`entries: Map`, `entriesBySeq: Entry[]`) plus scalar/list values and usage rows (`packages/agent/src/harness/session/jsonl/storage.ts`, `in-memory-storage-state.ts`). JSONL is the persistence format (`~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl`, `packages/coding-agent/docs/session-format.md`).
- Upstream already polices module-graph bloat: `scripts/check-entry-graphs.mjs` — *"importing a 1-file pure function through a barrel costs ~37 MB of evaluated module graph"* — enforces per-entry file budgets at commit time.

---

## 1. V8 startup snapshots (warm start, not steady RAM)

- API: `v8.startupSnapshot` (`addSerializeCallback`, `addDeserializeCallback`, `setDeserializeMainFunction`, `isBuildingSnapshot`); build with `node --snapshot-blob snapshot.blob --build-snapshot entry.js`, run with `node --snapshot-blob snapshot.blob`. Added v18.6.0/v16.17.0, **stable since v22.17.0/v24.0.0** ([nodejs.org/api/v8.html#startup-snapshot-api](https://nodejs.org/api/v8.html), [nodejs/node#57513](https://github.com/nodejs/node/pull/57513)).
- What it buys: skip parse/compile/instantiate of the baked module graph → **large boot-time win**, including deserializing a pre-built heap.
- What it does NOT buy: each process still deserializes **its own copy** of the heap; live per-seat data (session tree, TUI state, sockets) is not snapshotable. Idle-seat RSS barely moves.
- Constraints: docs' examples and hooks are CJS-oriented; native addons, open handles, WASM instances and the ESM module registry don't serialize — pi's optional native TUI accelerator, `quickjs-wasi`, and `jiti` would need careful exclusion. A CJS prelude or `setDeserializeMainFunction` restructure of the entry is a real refactor.
- **Verdict for this fork: low RAM ROI, high warm-start ROI — pairs with idle eviction (§6), don't do it first.**

## 2. Heap caps and GC tuning for many small processes

Verified flags (current [Node CLI docs](https://nodejs.org/api/cli.html)): `--max-old-space-size=SIZE` (MiB), `--max-semi-space-size=SIZE`, `--max-heap-size`, `--max-old-space-size-percentage`, `--jitless`, plus `--expose-gc` under "Useful V8 options".

- V8 grows the old generation lazily and only returns pages to the OS after full GCs (`heap_size_limit` follows `--max-old-space-size`, per [v8.getHeapStatistics docs](https://nodejs.org/api/v8.html#v8getheapstatistics)). Capping old space (e.g. 256–512 MiB per seat) makes major GCs happen earlier and closer together → **lower and flatter steady-state RSS**, and a hard ceiling against leak tails. This is exactly the failure class at [anthropics/claude-code#56693](https://github.com/anthropics/claude-code/issues/56693) (V8 OOM, 113 GB observed) and [#33356](https://github.com/anthropics/claude-code/issues/33356) (50.4 GB).
- Idle-GC hint: `--expose-gc` + a timer that calls `global.gc()` after N minutes without input returns pages on seats that just finished a heavy turn. Cheap, no behavior change; measure the actual PSS delta before/after (V8 may decline to free).
- `--max-semi-space-size=1–2` shrinks the young generation — fine for an I/O-bound TUI, reduces scavenger RSS.
- `--jitless` cuts code memory but cripples agent-loop throughput — not acceptable for active seats; listed for completeness.
- Effort: **S** (shebang wrapper / `NODE_OPTIONS` in the `pi` bin script; keep a user escape hatch). Risk: OOM if the cap is below a legit large session → default modest (e.g. 512) + document.

## 3. Lazy module loading and bundle slimming

- Today everything above is loaded eagerly per seat (§0). Candidates for load-on-first-use: `quickjs-wasi` (only when the `codemode` tool runs), `@silvia-odwyer/photon-node` (image work), `highlight.js` (rendering code blocks), `grok-mermaid`, `jiti` (TS config/extensions), MCP transports, `packages/coding-agent/src/modes/*`.
- Mechanism: `import()` at the use site + esbuild code splitting (bundle is already esbuild-driven), or `require()` behind a memoized getter for CJS-friendly deps. Note the tension with repo style: `AGENTS.md` says *no inline imports, top-level only* — this needs explicit upstream buy-in framed as a perf boundary, plus new budgets in `scripts/check-entry-graphs.mjs` so the split can't regress.
- Expected win: unmeasured until heap-profiled, but the repo's own "37 MB barrel" datum shows module-graph evaluation is tens of MiB. Estimate −10–40 MiB per idle seat.
- Bundle slimming side quest: prune grammars/features shipped for highlight.js and defer WASM compile (`WebAssembly.compile` on demand, not at module init).

## 4. Off-heap session storage (don't keep the whole session in RAM)

- Today: `InMemoryStorageState` holds the full entry tree per open session (§0). A 6-hour session with file reads and tool output is hundreds of MiB of strings that are *already durable on disk*.
- Option A — windowed JSONL: keep the last N entries + tree skeleton (id/parentId, seq, roles) in RAM; hydrate older entries on demand (`/tree` navigation, search, compaction input, stats). Pure fork-local change inside `JsonlStorage`.
- Option B — SQLite backend: **`packages/session-backends/sqlite-node` already exists in-repo** (node:sqlite, per-session DB files, WAL, read-only fork opens, benchmark suite) but is not wired into the coding agent. Precedent at scale: opencode keeps sessions in SQLite (`@effect/sql-sqlite-bun` in its [package.json](https://github.com/sst/opencode), [storage docs](https://deepwiki.com/sst/opencode/2.9-storage-and-database)).
- Either way the acceptance bar is behavior-identical: `/tree`, `/fork`, `/clone`, session stats, `/compact`, and resume must produce byte-identical model requests. The Storage interface (`packages/agent/src/harness/session/`) is the seam; the conformance suite (`harness/session/testing/conformance/`) is the gate.
- Expected win: −20–60 MiB on long-running seats (grows with history today → bounded after).

## 5. worker_threads isolation and SharedArrayBuffer

- `SharedArrayBuffer` shares memory **within one process only**. It cannot dedupe anything across separate `node` processes. For pi, workers make sense for *isolation/CPU* (run the QuickJS codemode sandbox or image work off the main thread), not for cross-seat dedup. ([worker_threads docs](https://nodejs.org/api/worker_threads.html))
- Cross-seat sharing of immutable data (model catalog, token tables) would require either (a) one resident supervisor holding it with thin per-seat clients — an architecture change with real crash-isolation and per-seat env/argv risk — or (b) file-backed RO mmap (dedupes page cache, which Linux already does for the shared code pages today).
- **Verdict: not a fork lever. The many-seats problem is solved by §7, not by SAB.**

## 6. Idle eviction: serialize + free heap, restore on wake (durable sessions)

The fleet math favors this above everything: an evicted idle seat costs **0 MiB**. MS-04 census math: 306 seats × 139.7 MiB = 43.08 GiB → cost only what is active (23 mid-turn seats ≈ 4.2 GiB today; even generous supervisor overhead keeps us in single-digit GiB) before any other optimization.

- pi already has every ingredient: sessions auto-persist as JSONL unless `--no-session`; `pi --continue` / `pi --resume` / `/resume` reopen them (`packages/coding-agent/docs/sessions.md`); `packages/durable` is an experimental harness with explicit persist-and-resume of mid-turn state; sessions survive process death by design (crash recovery).
- Design: a small supervisor (tmux `remain-on-exit` wrapper, or `pi attach <session>` client) that, after an idle timeout, flushes and exits the seat; any keystroke respawns `pi --continue --session-id …`. Warm-start cost is exactly what §1/§2 reduce.
- RAM-only state to account for (the behavior-identical risk list): open MCP server connections (already re-established on process restart), extension/module runtime state, editor draft text, in-flight tool output not yet committed to the JSONL. Each needs either "already durable" or an explicit flush hook — `pi-durable`'s commit-before-display model is the pattern.
- This is also, verbatim, Anthropic's own guidance for Claude Code bloat: *"Close and restart Claude Code between major tasks… restart Claude Code and run `claude --continue` to resume the conversation in a fresh process"* ([official troubleshooting](https://code.claude.com/docs/en/troubleshooting)). We'd automate what their users do by hand.
- Exotic alternative — CRIU checkpoint/restore of whole processes ([checkpoint-restore/criu](https://github.com/checkpoint-restore/criu)); Node core has declined built-in C/R ([nodejs/node#17103](https://github.com/nodejs/node/issues/17103)). Catches RAM-only state without app changes, but breaks on sockets/TTY/NixOS seccomp quirks — keep as fallback only if exit-and-resume proves lossy.

## 7. What other agent CLIs do (verified)

| CLI | Runtime | Memory posture | Session storage |
|---|---|---|---|
| Claude Code | Node | Leaks reported to 113 GB ([#56693](https://github.com/anthropics/claude-code/issues/56693)) and 50.4 GB ([#33356](https://github.com/anthropics/claude-code/issues/33356)); official docs acknowledge heavy usage: 2.5 GB heap warning, mitigations = `/compact`, restart between tasks, `--safe-mode` isolation, `/heapdump` diagnostics ([troubleshooting](https://code.claude.com/docs/en/troubleshooting)) | JSONL transcripts, resume via `--continue` |
| OpenAI Codex CLI | **Rust** (rewritten from TS/Node in 2025 for performance/security/zero-dep install: [InfoQ](https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite/), [devclass](https://www.devclass.com/ai-ml/2025/06/02/nodejs-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/1619589)) | Native-footprint process; no Node heap to tune | JSONL "rollout" files under `~/.codex/sessions` ([format walkthrough](https://codex.danielvaughan.com/2026/05/21/codex-cli-session-transcripts-jsonl-replay-viewer-tools-audit-analysis/)) |
| gemini-cli | Node/TS | OOM was a tracked work stream: meta issue [#5300](https://github.com/google-gemini/gemini-cli/issues/5300) (closed after sub-issues), 3 GB blowups [#22790](https://github.com/google-gemini/gemini-cli/issues/22790), [#28698](https://github.com/google-gemini/gemini-cli/issues/28698); third-party idle ≈ 200 MB report (unverified) | local chat/checkpoint files under `~/.gemini` |
| opencode (sst) | Node/Bun | client/server split | **SQLite** storage ([deps](https://github.com/sst/opencode), [storage docs](https://deepwiki.com/sst/opencode/2.9-storage-and-database)) |
| pi (upstream) | Node | this brief | JSONL tree + full in-RAM state; sqlite backend exists unwired; `pi-durable` persist/resume experimental |

Takeaway: nobody in the Node cohort has solved per-seat RAM; the Rust cohort sidestepped it; SQLite session storage is the proven pattern; and "restart + resume" is what the biggest player tells users to do manually — automating it is legitimately novel territory for pi.

## 8. Ranked wins by effort (the table)

Ranked by expected idle-fleet RAM reduction ÷ effort; **U** = provisional upstream-ability rank per `MEMORY-SOUND-PLAN.md` (fork-internal plan; splits shown where an item carries several):

| # | Technique | Expected effect | Effort | U | Behavior risk | Confidence |
|---|---|---|---|---|---|---|
| 1 | **Idle eviction + supervisor resume** (§6) | −139.7 MiB per evicted seat (cohort up to −181.5); fleet 43 GiB → active-only (≥80 % cut) | M | U3 mechanics · U2 policy default · U1 supervisor | M — RAM-only state (MCP conns, extension runtime, editor draft) needs flush/restore; conversation itself is already durable | High |
| 2 | **Heap caps** `--max-old-space-size=512` (+ small `--max-semi-space-size`) in bin wrapper (§2) | Bounds + flattens RSS; −10–30 % on post-turn seats; kills leak tails | S | U2 upstream default · U1 fleet env | L–M (OOM if user legitimately needs more → keep escape hatch) | Med |
| 3 | **Idle-GC hint** `--expose-gc` + timer (§2) | −5–15 % after heavy turns, free | S | U3 timer (no-op w/o flag) · U1 flag | L | Med (measure; V8 may decline) |
| 4 | **Off-heap session storage** — window the JSONL tree or wire `sqlite-node` backend (§4) | −20–60 MiB on long seats; bounded growth | M–H | U3 | M — `/tree`, `/fork`, compaction, stats, resume must stay byte-identical; conformance suite exists | Med-High |
| 5 | **Lazy-load heavy subsystems** quickjs-wasi / photon / hljs / jiti / MCP (§3) | −10–40 MiB idle (needs heap profile to confirm) | M | U3 per site (U2 where inline `import()` is unavoidable) | L — same code, later load; upstream "no inline imports" style needs a framed exception + entry-graph budgets | Med |
| 6 | **Compile cache** `NODE_COMPILE_CACHE` / `module.enableCompileCache()` + shipped read-only cache (§2 refs) | ~0 steady RAM; −20–60 % boot → cheapens #1's wake cost | S | U3 call · U2 shipped cache · U1 env | L (coverage-profiling precision caveat only) | High (docs-verified) |
| 7 | **V8 startup snapshot** (§1) | ~0 steady RAM; further boot win | M–H | U2 | M (CJS prelude; native/WASM/ESM constraints) | Med |
| 8 | CRIU whole-process checkpoint (§6) | Full freeze incl. RAM-only state | H | U1 parked | H (sockets/TTY, NixOS) — fallback only | Low |
| — | Worker/SAB seat consolidation (§5) | Shares one heap across seats | H | U2 (MS-24 adoption) | H (crash isolation, per-seat env) — wrong tool here | Low |

Fleet projection with #1–#5 at measured-optimistic values: active seats ~90–120 MiB each + supervisors ≈ **single-digit GiB vs 43 GiB today**.

U0 (banned, report-only): highlight.js grammar subsets that change rendered output; SAB/worker cross-process sharing inside core; `--jitless` on active seats.

## 9. Measurement and acceptance protocol (every change runs through this)

1. **RAM**: per-seat `PSS+SwapPss` from `/proc/<pid>/smaps_rollup`; report mean/p50/max; never RSS alone (overstates sharing). Canonical tables: `MEMORY-BASELINE.md` (this dir) + `tools/mem-probe` (p4). Raw pid lists filed under vault `1. Projects/Memory-Sound Program/evidence/`.
2. **Boot/wake**: `hyperfine 'pi --continue --session-id <fixed>'` before/after compile cache + snapshot experiments.
3. **Behavior-identical gates**: `./test.sh` (non-e2e), the session conformance suite (`packages/agent/src/harness/session/testing/conformance/`), `npm run check` incl. `check:entry-graphs`, and for eviction: kill -9 a seat mid-turn → resume → transcript and model-request bytes must match a no-kill control run.
4. **Heap attribution** when a number surprises: `--heapsnapshot-signal=SIGUSR2` + Chrome DevTools, or `v8.queryObjects()` for targeted leak regression checks ([v8 docs](https://nodejs.org/api/v8.html)); `getHeapSpaceStatistics()` to see old-space vs code-space split.

## 10. PR shape sketches — top two of §8 (30/09/2026)

Selected: **#1 idle eviction** and **#2 heap caps** — top by fleet MiB ÷ effort. Per the plan's scheduling rule (higher U-rank, then lower effort) the U3 halves of MS-20/MS-21 can ship first; each sketch splits its U3 (straight PR) from its U2 (issue-first) part. Upstream gate (MS-05) applies to all: **no PR opens before maintainer `lgtm`**; the single quality issue text is `[pending] Pedro: approve`. Worktrees per plan: `git worktree add ../pi-upstream-ms-<slug> -b ms/<slug> upstream/main`.

### 10.1 PR A — idle eviction (MS-22, `ms/22-idle-eviction`)

Problem, trace, solution (CONTRIBUTING frame): a pi seat killed while idle loses nothing observable **only if** every state class is already committed to the JSONL — the gaps (editor draft, tree cursor, extension runtime state) are unproven. Trace: seat idle 30 min → supervisor kills it → `pi --continue` → user expects identical UI + transcript state.

- **A1 `fix(agent,coding-agent): durable idle shutdown + resume parity` — U3, straight PR.**
  (1) `checkpoint()` on the session repo: drain commit queue + persist UI-adjacent state (`packages/agent/src/harness/session/jsonl/storage.ts`, `in-memory-storage-state.ts`); (2) deterministic teardown in `packages/coding-agent/src/main.ts` (close MCP/extension handles, flush editor draft + tree cursor where they live); (3) parity test: kill -9 vs clean-exit resume → byte-identical transcript + identical restored state (`packages/agent/src/harness/session/testing/conformance/` + a coding-agent suite test). Minimal diff, no new flags/defaults.
- **A2 `feat(coding-agent): opt-in --idle-exit=<duration> (default off)` — U2 → issue + `lgtm` first.**
  Flag in `src/cli.ts` (6-line shim → `main.ts`), idle timer armed from TUI idle events in `src/modes/interactive/`, calls A1 teardown then exit 0. Default off ⇒ upstream behavior unchanged. Docs `packages/coding-agent/docs/cli.md` + CHANGELOG (PR branch: changelog allowed per repo rules). The supervisor/`--continue` wake loop is fleet-side (U1) and never in the PR.
- Memory table (plan format): evicted idle seat = process absent (probe counts active seats only) vs MS-04 baseline 139.7 MiB/seat fleet mean; mid-turn rows unchanged. Pid lists → `evidence/MS-22/`.
- Revert: one `git revert` per PR; fleet disable = drop `--idle-exit`.

### 10.2 PR B — heap caps (MS-23, `ms/23-heap-cap`)

Problem, trace, solution: V8 heap caps must be set **before** heap init, so they cannot be added from inside the ESM entry; today the only lever is hand-set `NODE_OPTIONS`. Trace: `pi` boots with the default limit; a leaky turn grows unboundedly (the #33356/#56693 class) with nothing bounding it.

- **B1 `feat(coding-agent): launcher shim with heap-cap passthrough (default off)` — U3.**
  npm `bin` becomes a tiny CJS launcher (`dist/bundle/pi.cjs`, emitted by `scripts/build-coding-agent-bundle.mjs`) that re-execs `node --max-old-space-size=$PI_OLD_SPACE_MB …/cli.js` **only** when no cap is already present in `process.execArgv`/`NODE_OPTIONS`; `PI_OLD_SPACE_MB=0` disables; user-set `NODE_OPTIONS` always wins. Default behavior identical to today. Risk surface = respawn parity: TTY raw mode, SIGINT/SIGTERM forwarding, exit codes — covered by suite tests.
- **B2 `feat(coding-agent): default heap cap 512 MiB` — U2 → issue + `lgtm`, with load evidence.**
  One-line default + docs (`packages/coding-agent/docs/cli.md`/`configuration.md`) + escape hatch. Gate evidence per plan: "no behavior change under load" = evals + long-turn session at cap, zero OOM, unchanged outputs, plus idle + mid-turn memory table (expect −10–30 % post-turn; leak-tail elimination).
- Revert: `git revert <sha>`; fleet: `PI_OLD_SPACE_MB=0` / unset env.

## References

**Node/V8 docs (fetched 30/09/2026)**
- https://nodejs.org/api/v8.html — Startup Snapshot API (v18.6.0+, stable v22.17.0/v24.0.0), getHeapStatistics, queryObjects
- https://nodejs.org/api/cli.html — `--build-snapshot`, `--snapshot-blob`, `--max-old-space-size`, `--max-semi-space-size`, `--max-heap-size`, `--max-old-space-size-percentage`, `--jitless`, `NODE_COMPILE_CACHE*`
- https://nodejs.org/api/module.html — module compile cache: CJS+ESM+TS coverage, portable & read-only modes, per-Node-version invalidation, coverage caveat
- https://v8.dev/blog/code-caching and https://v8.dev/blog/code-caching-for-devs — V8 code cache mechanics
- https://nodejs.org/api/worker_threads.html — worker/SAB scope (in-process only)

**Other agent CLIs**
- https://github.com/anthropics/claude-code/issues/56693 · /issues/33356 — memory leak reports
- https://code.claude.com/docs/en/troubleshooting — official high-memory guidance (2.5 GB warning, restart + `--continue`, `/compact`, `/heapdump`)
- https://github.com/google-gemini/gemini-cli/issues/5300 · /issues/22790 · /issues/28698 — OOM work stream
- https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite/ · https://www.devclass.com/ai-ml/2025/06/02/nodejs-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/1619589 — Codex TS→Rust
- https://codex.danielvaughan.com/2026/05/21/codex-cli-session-transcripts-jsonl-replay-viewer-tools-audit-analysis/ — Codex JSONL rollout files
- https://github.com/sst/opencode (+ `@effect/sql-sqlite-bun` dep) · https://deepwiki.com/sst/opencode/2.9-storage-and-database — SQLite sessions

**Checkpoint/restore**
- https://github.com/checkpoint-restore/criu · https://github.com/nodejs/node/issues/17103

**In-repo evidence (this checkout)**
- `MEMORY-BASELINE.md` (this dir) — MS-04 fleet census: 306 seats, 43.08 GiB, age bands
- `scripts/check-entry-graphs.mjs` — entry-point cost contracts ("~37 MB barrel" datum)
- `packages/agent/src/harness/session/jsonl/storage.ts`, `in-memory-storage-state.ts` — full-tree residency
- `packages/session-backends/sqlite-node/` — existing, unwired SQLite backend (+ benchmark)
- `packages/durable/README.md` — experimental persist/resume harness
- `packages/coding-agent/docs/session-format.md`, `sessions.md`; `packages/coding-agent/package.json`; `scripts/build-coding-agent-bundle.mjs`
- Live seat measurements, desktop 30/09/2026 (§0 table); bare `node` v22.23.2 ≈ 44.5 MiB RSS; vault evidence `evidence/2026-09-30-research-desktop-idle-seats/`
