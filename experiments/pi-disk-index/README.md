# Disk-backed Pi session index experiment

Status: isolated source-only prototype. No live Pi/Herdr inference, no browser sends, no deployment, and no production session modification.

The current pinned `phsb5321/pi` at `40976d9d48599adc9009dd6d96b1a6c55b167765` persists transcripts as append-only JSONL but retains the parsed `fileEntries`, a `byId` map and projected `agent.state.messages` in each resident Pi process. Those per-seat runtimes dominate fleet RAM. The prototype is an independent, read-only sidecar demonstrating bounded history hydration, **not** a drop-in replacement for `SessionManager`.

`disk-session-index.mjs` stores ID, parent ID, kind, and byte offsets in SQLite WAL and reads one JSONL entry at a time. It checks file size, inode, mtime and ctime at every access, detects append, rebuilds indexes transactionally, and leaves the canonical transcript untouched. It does not implement Pi's complete session projection (compaction, branch summaries, labels, queued tool effects), nor an active worker pool. It is experimental because Node 22's `node:sqlite` remains experimental.

## Tests and benchmark

Run `node --test disk-session-index.test.mjs` and `node benchmark.mjs` using Node 22 or later. Both work offline without providers or private transcripts. The tests cover exact Unicode content, cross-buffer offsets, branch ancestry, pagination, malformed lines, append freshness, session isolation and cycle rejection.

In a synthetic run on Node 22.16.0, thirty-two sessions with 350 messages each produced:

| Retention model | Proportional memory | Heap in use |
| --- | ---: | ---: |
| Full parsed entries, ID map and projected state | 98,174 KiB | 51,750,120 bytes |
| Read-only SQLite index, one hydrated entry per session, index handles closed | 31,423 KiB | 4,201,656 bytes |

This corresponds to **68.0% less PSS** and **91.9% less heap** for this particular history-retention workload. It is *not* a production Pi measurement, a forty-eight- or ninety-two-percent generalized saving, or evidence of end-to-end session compatibility. Disk IO and cold-wake latency are not yet benchmarked here.

## Full design still required

The accepted design needs a lightweight Herdr seat process that retains name, workspace, tab, cwd, session ID and draft ownership; a shared Pi backend that processes active turns; complete release of idle `AgentSession` objects, extensions and child processes; and a disk-indexed immutable transcript tree that hydrates only active context. An idle boundary must be proven after outstanding tool effects and delivery acknowledgement, and sessions must resume exactly once from their original history, model and extensions.

The current Token Diet `pi-seat-supervisor` is a useful reference and passes its own twenty-six deterministic tests, but it deliberately creates a fresh Pi session for every event and reconstructs context from a small `state.md`. It does not transparently resume an arbitrary existing Herdr seat.

The cross-project research tasks are in `RESEARCH-WORKSTREAMS.json`. Prepared tasks are not active browser tabs or successful model dispatches. The headless GPT gateway currently has admission disabled and no registered contracts or caller grants. Do not bypass it by creating a second dispatcher or replaying uncertain sends.

## Source refs

- Homegrown pinned fork: https://github.com/phsb5321/pi/tree/40976d9d48599adc9009dd6d96b1a6c55b167765
- Retaining manager: `packages/coding-agent/src/core/session-manager.ts`
- Duplicate projection: `packages/coding-agent/src/core/agent-session.ts`
- Desktop supervisor: `~/NixOS/user-scripts/pi-seat-supervisor`
- Canonical live fleet queue: `~/Documents/Notes/1. Projects/ChatGPT Workstream Fleet/PANE-TODOS.json`

All experimental source files are editable. They do not modify the pinned fork or production package in this archive.
