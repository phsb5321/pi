# Nix fleet artifact pin (NixOS #2804)

The portable `fleet-pin.json` remains unchanged. It identifies the retained
npm-built fleet artifact, not the Nix build. Nix rewrites Node shebangs and the
bundle build has distinct content-addressed chunk names. A dependency-tree match
alone is not sufficient: the full CLI and manifest assertions remain required.

`fleet-pin.x86_64-linux.json` records the exact Linux Nix artifact built from
memory-sound `1ca833bbe` (v1.4.0 base) plus the fleet packaging commits and the gateway-queue-wait port (#55, `0322ac870`), with its existing locked inputs:

- fleet source: `/nix/store/s6r4brqjik80q69zfa641sjbbmw1g7h5-pi-fleet-source-1.4.0`
- Node: `/nix/store/gf597zf0ysgbngwb92baxgxjd02px6jh-nodejs-22.23.2`
- canonical computation: `bash packaging/fleet/fleet-install.sh compute --source <fleet-source>`
- full manifest: `9b797caee43e2d6d988232063f056b61b2d68f5bfe99196bee801a9a9e4e1ab5889b0a4124cf8b055a0ce6d43a52492fd2c2da55e29a1470713569ab1cce6361`

The NixOS consumer selects the checked-in platform pin and puts an unmodified
copy of `fleet-install.sh` next to it as `fleet-pin.json`. The script's verifier
still checks every field before any installation write; no mutable environment
pin override, runtime hash generation or reduced verification is introduced.
The pin must be verified again after this metadata commit's own Nix build: a
changed source revision must not be assumed to preserve artifact bytes.

No Darwin pin is asserted. Its store-path shebangs differ and its actual build
and native SDK must be qualified on that platform before fresh-host deployment.
This source change neither installs a runtime nor restarts any existing seat.
