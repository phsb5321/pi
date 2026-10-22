# pi-shared-host user unit (D3, EXPERIMENTAL)

Plain user service — no socket activation by design: the daemon binds and
verifies its own unix socket (mode/ownership gate lives in the daemon after
bind; `transports/unix/listener.ts` also publishes via a private bind path
and hardlink), so a pre-bound activation fd would only conflict. The socket
"plumbing" is the unit's `RuntimeDirectory=pi-shared-host` (0700, cleaned up
by systemd) plus the daemon's post-bind filesystem gate.

## Install (per seat)

```
sed "s|__REPO__|$HOME/Documents/Code/pi-upstream-005-shared-isolation|" \
  fleet/pi-shared-host.service.in > ~/.config/systemd/user/pi-shared-host.service
systemctl --user daemon-reload
systemctl --user start pi-shared-host.service
```

Install path documented in the durable README:
`packages/coding-agent/src/experimental/durable/README.md` ("Shared-host daemon").

## Verify

```
systemd-analyze verify ~/.config/systemd/user/pi-shared-host.service
systemctl --user status pi-shared-host.service      # active (running)
ls -la $XDG_RUNTIME_DIR/pi-shared-host/             # dir 0700 (RuntimeDirectory), sock 0600
systemctl --user stop pi-shared-host.service        # SIGTERM -> drain -> exit 0
```

Restart=on-failure keeps the daemon up across crashes; killing -9 the
daemon mid-turn and restarting recovers every session from durable state
(native continuation), which the D4 live check demonstrates.

## Security boundary

This transport cannot check per-peer credentials (no SO_PEERCRED exposure
in Node). The gate is filesystem: the socket directory must be 0700 and
the socket 0600, both owned by the seat uid — the daemon refuses to serve
otherwise, and a cross-uid connect() fails at connect time. Verified
15/10/2026: 755 dir -> refuse exit 1 rendering the seat uid.
