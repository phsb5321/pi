# Nix fleet artifact pin (NixOS #2804)

The portable `fleet-pin.json` remains unchanged. It identifies the retained
npm-built fleet artifact, not the Nix build. Nix rewrites Node shebangs and the
bundle build has distinct content-addressed chunk names. A dependency-tree match
alone is not sufficient: the full CLI and manifest assertions remain required.

`fleet-pin.x86_64-linux.json` records the exact Linux Nix artifact built from
memory-sound `56faba940` plus the four fleet packaging commits, with its existing locked inputs:

- fleet source: `/nix/store/shjiy7grccm0hrjb4bb1mkvljq61rykp-pi-fleet-source-1.1.0`
- Node: `/nix/store/gf597zf0ysgbngwb92baxgxjd02px6jh-nodejs-22.23.2`
- canonical computation: `bash packaging/fleet/fleet-install.sh compute --source <fleet-source>`
- full manifest: `87fd97beb2a4e5d50db9a85141c189e9145e444af94d4c3a413f0f0aa2ec677e9e526c824a21d4097f06f7d5c6ff78569f52dce233dd8c670fa691ccfa7a6e67`

The NixOS consumer selects the checked-in platform pin and puts an unmodified
copy of `fleet-install.sh` next to it as `fleet-pin.json`. The script's verifier
still checks every field before any installation write; no mutable environment
pin override, runtime hash generation or reduced verification is introduced.
The pin must be verified again after this metadata commit's own Nix build: a
changed source revision must not be assumed to preserve artifact bytes.

No Darwin pin is asserted. Its store-path shebangs differ and its actual build
and native SDK must be qualified on that platform before fresh-host deployment.
This source change neither installs a runtime nor restarts any existing seat.
