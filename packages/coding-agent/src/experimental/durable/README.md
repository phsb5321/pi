# durable

A small local coding agent on `@earendil-works/pi-durable`. One process owns the model runtime, the durable
Harness, its SQLite storage, and the TUI. It reuses pi's model runtime, auth, settings, system prompt, keybindings,
theme, and interactive components; the agent itself is the durable Harness with its built-in `CodingTools`.

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts --continue
```

A new session starts with pi's default model and thinking level from `settings.json`. `--continue` opens the newest
session for the current directory. Sessions live under
`~/.pi/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`; a lock keeps a second process out
(a lock left by a crash goes stale after 10 seconds, and the next start waits for that). Log in with pi itself;
credentials are shared.

## What it shows

- **Durability:** every streamed partial, tool output, queue, and turn is committed. Kill the process in the middle
  of a tool call and start it again with `--continue`: the interrupted call gets an interrupted result and the turn
  finishes. Nothing in the TUI handles recovery; it only renders the conversation view.
- **One view:** the TUI renders `Conversation.viewState()`, the structural mount of the transcript and the built-in
  documents (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`). Streaming, tool progress, the queue, retries,
  compaction status, the model, and usage all come from it.
- **Subagents:** the `subagent` tool runs a task in a child conversation owned by the call. `/agents` switches the
  view to any conversation, also while the subagent works, and the editor then talks to it: steer it while busy, or
  keep chatting after the call returned. Esc aborts the shown conversation; aborting the main turn aborts its
  subagents.
- **Task graph:** a live panel of `Harness.taskGraph()`, shown by default and toggled with `/tasks`: every live task, what it waits on, and the
  conversations it owns.

## Commands

- submit: prompt while idle, steer while busy
- follow-up key (`app.message.followUp`): queue a follow-up
- Esc: abort the shown conversation's work, including a manual compaction
- `/model` or the model key: select a model for the shown conversation
- thinking key (Shift+Tab): cycle thinking levels
- `/compact [instructions]`: summarize older context; reports "Nothing to compact" when the context fits in
  `compaction.keepRecentTokens`
- `/agents`: switch conversations
- `/tasks`: hide or show the task panel
- tools expand key (Ctrl+O): expand tool output and compaction summaries
- clear key (Ctrl+C) or Ctrl+D: exit at once, unlike pi's clear-first Ctrl+C; work in flight resumes with
  `--continue`

## Layout

| file | role |
| --- | --- |
| `main.ts` | arguments, open, run, close |
| `sessions.ts` | session directories and the lock |
| `runtime.ts` | Harness, registry, settings, environments; the plain `DurableView` and `DurableController` |
| `prompt.ts` | pi's system prompt sections (tools, rules, docs, AGENTS.md, skills, cwd) as one extension |
| `subagent.ts` | the foreground subagent tool |
| `tui.ts` | rendering with pi's interactive components |

Compaction thresholds, retry policy, queue modes, and request timeouts come from pi's `settings.json` as loaded at
startup, read through Harness settings getters at each use. pi's HTTP dispatcher is configured as in pi; without it some provider streams end
early.

A turn that ends without an answer shows a notice; one recovered after a restart does not, since only submissions
made by this process are watched.

Not here: sessions list and resume picker, forks and tree navigation, extensions, prompt templates, images, `/login`.

## Shared-host daemon (EXPERIMENTAL)

`shared-host-daemon.ts` hosts many durable session engines behind one REAL
unix socket (default `$XDG_RUNTIME_DIR/pi-shared-host/pi-shared-host.sock`;
the D3 unit passes `--socket %t/pi-shared-host/host.sock` — 0600, dir 0700
via `RuntimeDirectory` — enforced post-bind; the transport exposes no
SO_PEERCRED, so the filesystem boundary is the gate). Attach a seat TUI over
that socket with `pi-attach.ts` (`--socket <path> --session <id|new>
[--cwd <dir>]`); an absent daemon fails fast with exit 3.

Session layout: `<root>/<session-id>/` (cwd binding) and
`<root>/<session-id>.resident.json` under `--root`
(default `~/.pi/agent/shared-host`); the DURABLE STORE ITSELF stays under
`~/.pi/agent/experimental/durable-sessions/<hash>/<native-id>/` — session
removal is manual and covers BOTH locations (the daemon never deletes).

Install (systemd user unit, D3):

```
sed "s|__REPO__|<this-repo-checkout>|" \
  specs/9990-worktree-consolidation/shared-host-prototype-20261014/fleet/pi-shared-host.service.in \
  > ~/.config/systemd/user/pi-shared-host.service
systemctl --user daemon-reload && systemctl --user start pi-shared-host.service
```
