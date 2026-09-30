# memory-sound — a pi fork for RAM-bounded agent fleets

Fork purpose (30/09/2026): keep pi's behavior, cut its resident memory. The
origin is a measured fleet problem, not an aesthetic one.

## The measured problem this fork exists to fix

Host: `desktop`, 128 GB. Fleet: herdr sessions with ~215 concurrent pi agents
plus tooling. Measured 29/09 with the same method this fork will use
(`/proc/<pid>/smaps_rollup`, PSS + SwapPss, whole process tree):

| | per unit | fleet |
|---|---:|---:|
| pi agent (idle, long-lived) | **181.5 MiB** | 215 procs = **39.0 GiB** |
| reference: a Rust-native agent seat | 67.0 MiB | — |

**Census correction (30/09 14:47, probe v2, 306/306 pids):** the 181.5×215
figure is the long-lived side-projects cohort. Fleet-wide: **306 seats, idle
mean 139.7 MiB (PSS 115.1 + SwapPss 24.5), total 43.08 GiB** — larger than
the charter estimate, so the problem stands strengthened. Idle grows with
seat age (+~75 MiB over 3 days: 99.1 → 146.5 → 173.5 by start-day),
consistently with session-retention cost; attribution pending M1. Evidence:
vault `1. Projects/Memory-Sound Program/fleet-baseline-2026-09-30.md` +
`evidence/MS-04/`. These census numbers are the ones to cite publicly.

System pressure was real: heavy swap (5.7 GiB SwapPss on 94 seats alone when
measured mid-migration). The fleet's entire memory campaign (native-agent
experiment included) came from this table. That experiment was removed from
Nix on 30/09 after failing end-to-end (zero completed turns); this fork is the
replacement path — keep pi's proven behavior, remove pi's per-process weight.

## What a node runtime costs vs what the app adds

A bare `node -e ''` on this host is ~45–60 MiB RSS. An idle pi seat is
~181 MiB total. So roughly **two thirds of every seat is application heap**,
paid 215 times. Any of these three alone would be a large win:

1. **One runtime, many sessions.** `packages/server` already exists upstream:
   "Experimental local server for the new durable Session and Agent Harness
   interfaces". N panes → 1 server process + N thin clients. This is the
   single biggest structural lever (215 → ~a few runtimes), and it is upstream
   architecture, not a fork invention.
2. **Idle eviction.** An idle seat currently holds its whole world in the heap.
   `packages/durable` (documents/entries/harness; upstream just landed
   "compaction and overflow (Package 20)") is the natural place to serialize
   an idle session to disk and free the heap, restoring on wake.
3. **Cheaper per-seat baseline.** Everything loaded per process (extension
   bundle, skills, prompts, MCP client machinery, TUI buffers) is paid per
   seat. Lazy-load and share what is identical across seats.

## Method (non-negotiable, it is how we got here)

- Measure **PSS + SwapPss** of the whole process tree, per seat, on the real
  fleet host, idle and mid-turn. Never RSS alone; never "feels lighter".
- `packages/telemetry/src/memory.ts` gives a place to emit these numbers from
  inside the runtime; until wired, an external probe script is the source of
  truth.
- Every change lands with a before/after table from the same probe.

## Milestones

- **M0 — build and reproduce.** Build this monorepo, run one seat from the
  fork, reproduce the 181.5 MiB idle number with the probe. No behavioral
  deltas.
- **M1 — where the heap goes.** Heap snapshot (`--heapsnapshot-signal`) of an
  idle seat; account the big buckets (session JSONL held in RAM, extension
  bundle, prompts/skills, MCP registry, TUI). Name the top three.
- **M2 — first structural win.** Whichever of the three levers M1 says is
  cheapest-per-effort; likely idle eviction on `durable` (rides upstream
  momentum) or server-shared sessions.
- **M3 — fleet pilot.** One herdr session on the fork; before/after per seat;
  then the fleet.

## Ground rules

- Upstream first: anything that belongs upstream (idle eviction, heap caps)
  goes upstream as a PR; the fork carries fleet-specific wiring and pace.
- No behavior changes without a memory table that pays for them.
- The probe script lives in `tools/mem-probe` in this fork and is the only
  accepted measurement instrument.
