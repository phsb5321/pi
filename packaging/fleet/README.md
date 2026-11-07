# Managed fleet artifact

`nix build .#fleet-source` restores the managed install layout from the native
Pi output. It copies the complete native `node_modules` closure, not only its
nested coding-agent package. Dependencies and minification remain owned by
`nix/package.nix`; this bridge does not resolve or upgrade dependencies.

The installer is retained unchanged from the proven 1.4 fleet packaging source
(installer SHA-256 `63c04d3ca1a2e32a9263630c39f7cd66e2e7e279ed0d3c316baf897c77b29ce6`).
No legacy experimental ABI, wrapper, provider policy or 1.1 dependency tree is
ported. No `install` app or activation hook is added.

## Acceptance

```sh
python3 -B packaging/fleet/test-install.py
nix build --no-link --print-out-paths .#fleet-source
python3 -B packaging/fleet/check-artifact.py /nix/store/ACTUAL-fleet-source
```

The artifact check loads the relocated SDK/parser and native dependencies,
checks the exact 1.4 dependency cohort and CLI/exports, and rejects a nested-only
package. It runs no model request. The installer regressions use synthetic
fixtures only and prove wrong pin/version/lock/CLI/manifest rejection before
installation plus retained old-root rollback under disposable roots.

A platform pin must be measured from the accepted immutable build, not copied
from a prior installed runtime. The existing canonical computation is:

```sh
bash packaging/fleet/fleet-install.sh compute --source /nix/store/ACTUAL-fleet-source
```

Preserve the source revision, locks/catalog, derivation/output/closure identities
and emitted parser/consumer/native hashes. Commit the resulting platform pin
only after that exact build is verified. The native source filter excludes only
fleet-pin JSON metadata to avoid a pin/artifact feedback cycle; the fleet bundle
reuses that same native install-lock input. Compare exact derivation identities
and requalify the committed source rather than assuming metadata neutrality.
The managed Nix consumer selects `fleet-pin.<system>.json` and copies it beside
the unchanged installer as `fleet-pin.json`. No fallback pin is invented for an
unqualified platform. Until a valid platform pin exists, managed activation is
blocked; exporting `fleet-source` alone is not delivery completion.

For sandboxed install acceptance, copy the unchanged installer and qualified
platform pin into one disposable tool directory (pin named `fleet-pin.json`),
run `verify --source <artifact>`, then `install --source <artifact> --root <temp>`.
Run `check-artifact.py` against the installed target too. Never use the real
fleet default or replace a loaded immutable directory in place.

## Queue-complete artifact is a separate gate

This packaging follow-up is based on protected `memory-sound` after native
adapter/consumer PR29. Build the exact combined source and additionally run:

```sh
python3 -B packaging/fleet/check-artifact.py /nix/store/ACTUAL-fleet-source --require-queue
```

The required-queue mode rejects a base without the consumer. Literal
presence is not behavioral acceptance: the exact combined artifact still owes
the real native observer/footer/RPC hold-to-output, cancellation, partial/error
and provenance-negative canary. Disk/default identity never proves a live
process has reloaded native module-cache bytes. p1 alone owns later activation.
