# Nix fleet artifact pin (NixOS #2804)

The portable `fleet-pin.json` remains unchanged. It identifies the retained
npm-built fleet artifact, not the Nix build. Nix rewrites Node shebangs and the
bundle build has distinct content-addressed chunk names. A dependency-tree match
alone is not sufficient: the full CLI and manifest assertions remain required.

`fleet-pin.x86_64-linux.json` records the exact Linux Nix artifact built from
`0e096485fd790042c41cb2f1c8f93f079cba4724` with its existing locked inputs:

- fleet source: `/nix/store/7003hzbm4qkw9b74gbpf6pv9h2wmshb0-pi-fleet-source-1.1.0`
- package: `/nix/store/0siqfr72f50344i3a7xay8d5hjdh8jpb-pi-1.1.0`
- Node: `/nix/store/gf597zf0ysgbngwb92baxgxjd02px6jh-nodejs-22.23.2`
- canonical computation: `bash packaging/fleet/fleet-install.sh compute --source <fleet-source>`
- full manifest: `e0883b536b1ee89089ae38fc618232f62927d8a270f693fc30fd9b318ac6eb555952f28830525d6ac6a181b4f69163d734d1fd72faec347c17270ef5e8c2c206`

The NixOS consumer selects the checked-in platform pin and puts an unmodified
copy of `fleet-install.sh` next to it as `fleet-pin.json`. The script's verifier
still checks every field before any installation write; no mutable environment
pin override, runtime hash generation or reduced verification is introduced.
The pin must be verified again after this metadata commit's own Nix build: a
changed source revision must not be assumed to preserve artifact bytes.

No Darwin pin is asserted. Its store-path shebangs differ and its actual build
and native SDK must be qualified on that platform before fresh-host deployment.
This source change neither installs a runtime nor restarts any existing seat.
