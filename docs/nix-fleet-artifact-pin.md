# Nix fleet artifact pin (NixOS #2804)

The portable `fleet-pin.json` remains unchanged. It identifies the retained
npm-built fleet artifact, not the Nix build. Nix rewrites Node shebangs and the
bundle build has distinct content-addressed chunk names. A dependency-tree match
alone is not sufficient: the full CLI and manifest assertions remain required.

`fleet-pin.x86_64-linux.json` records the exact Linux Nix artifact built from
memory-sound `1ca833bbe` (v1.4.0 base) plus the fleet packaging commits, with its existing locked inputs:

- fleet source: `/nix/store/yffsgwjvqdv2xl3r77bd8y13izh1pd4g-pi-fleet-source-1.4.0`
- Node: `/nix/store/gf597zf0ysgbngwb92baxgxjd02px6jh-nodejs-22.23.2`
- canonical computation: `bash packaging/fleet/fleet-install.sh compute --source <fleet-source>`
- full manifest: `0a3caae62fe88b0819c57d5af1c223573ebb102603bdad84eed3177e4ab17b51d2bd3b21d873bc32f021896b39268c1b2b8b3a49c22ce9788046996f4b223cbb`

The NixOS consumer selects the checked-in platform pin and puts an unmodified
copy of `fleet-install.sh` next to it as `fleet-pin.json`. The script's verifier
still checks every field before any installation write; no mutable environment
pin override, runtime hash generation or reduced verification is introduced.
The pin must be verified again after this metadata commit's own Nix build: a
changed source revision must not be assumed to preserve artifact bytes.

No Darwin pin is asserted. Its store-path shebangs differ and its actual build
and native SDK must be qualified on that platform before fresh-host deployment.
This source change neither installs a runtime nor restarts any existing seat.
