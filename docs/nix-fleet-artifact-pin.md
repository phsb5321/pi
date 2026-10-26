# Nix fleet artifact pin (NixOS #2804)

The portable `fleet-pin.json` remains unchanged. It identifies the retained
npm-built fleet artifact, not the Nix build. Nix rewrites Node shebangs and the
bundle build has distinct content-addressed chunk names. A dependency-tree match
alone is not sufficient: the full CLI and manifest assertions remain required.

`fleet-pin.x86_64-linux.json` records the exact Linux Nix artifact built from
memory-sound `1429d44ac` plus the four fleet packaging commits, with its existing locked inputs:

- fleet source: `/nix/store/8bj6fdl0m5gjgj9a38zi9g7had6yj0lw-pi-fleet-source-1.1.0`
- Node: `/nix/store/gf597zf0ysgbngwb92baxgxjd02px6jh-nodejs-22.23.2`
- canonical computation: `bash packaging/fleet/fleet-install.sh compute --source <fleet-source>`
- full manifest: `95db83e8b0bcb52c88effc329b1d0a6d6dec3e9711f24e0c3dc97d944fff67890f21985c4f56387a33dfda42bf83869569b25fda91961293e4c38b93e98e36b8`

The NixOS consumer selects the checked-in platform pin and puts an unmodified
copy of `fleet-install.sh` next to it as `fleet-pin.json`. The script's verifier
still checks every field before any installation write; no mutable environment
pin override, runtime hash generation or reduced verification is introduced.
The pin must be verified again after this metadata commit's own Nix build: a
changed source revision must not be assumed to preserve artifact bytes.

No Darwin pin is asserted. Its store-path shebangs differ and its actual build
and native SDK must be qualified on that platform before fresh-host deployment.
This source change neither installs a runtime nor restarts any existing seat.
