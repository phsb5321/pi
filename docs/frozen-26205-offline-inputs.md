# Frozen 26205caa: already-realized offline inputs

Observed on desktop, 12/10/2026 17:29 BRT. These are **existing files**, not
substitution recipes for missing inputs. Source stays frozen at
`26205caa390b533cfab5832556eae6972dcd8125`. This receipt does not change a pin,
Nix source/tests, installed runtime, original session, provider or account.

## Exact paths and qualification

| Purpose | Existing path |
| --- | --- |
| Frozen source | `/nix/store/kpjgjqki0n3mr1d3axazsd8lmaz55866-source` |
| Frozen workspace dependency localizations | `/nix/store/cp3nyzgbizjlp412h0w4p2cfarz2xhrp-pi-monorepo-0.0.3-sources` |
| Built workspace package tarballs | `/nix/store/6mqhlzgmr1kidrzprdpqi94d11740kgf-pi-workspace-packages-1.1.0` |
| Typed model-data input | `/nix/store/c2hfynrx0mf60mg26x4mid732wgygdcw-pi-model-catalog.json` |
| Node24 | `/nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node` |
| Node24 headers/source | `/nix/store/clkq16cgzimxj8h4pim2p0xa09cfx9zs-nodejs-24.19.0-source` |
| Real SDK 0.52.0 tarball | `/nix/store/p8k3z8hpzjhai0jlac2hravwrbz39vbh-sdk-0.52.0.tgz` |
| Sealed **runtime-only** node_modules | `/nix/store/nmybmqbknywrz2cdiwaz58b18bmbxz5i-pi-fleet-source-1.1.0/node_modules` |

The `*-sources` output contains two localized manifests, **not** a ready dev
`node_modules` tree. The built workspace output contains `*.tgz`, not dev deps.
Do not copy the runtime-only node_modules over a source checkout or use deps
from another shared root.

Read-only executable evidence:

- Node reports **v24.19.0**. Its npm CLI and `cacache` are present under
  `lib/node_modules/npm` in that same Node24 prefix.
- The original frozen lock and localized lock have **401 identical package
  keys and exact versions**. All **362 registry tarballs exist and match their
  original lock integrity hashes**. There are no non-local resolved inputs or
  tarballs without original integrity. The remaining **19 workspace links** are
  localized only to this exact frozen store source, not to another checkout.
- Specifically, SDK **0.52.0**, root SDK **0.129.0** and nested SDK **0.91.1** each
  match their original SHA512 integrity. Those versions occupy distinct lock
  locations; none is substituted for another.
- Catalog SHA256 is
  `439c53478c84ed27a58f8b54e1c3bd45810e5a969515b4e3666a3898d51ee22f`, exactly the
  checked-in `nix/model-catalog.json` revision. `ai.tgz` contains
  `dist/models.generated.js` and `dist/providers/data/.manifest.json` with typed
  provider data.
- Frozen `package.json` SHA256 is
  `c62fcf34a420f8707ac307dd0fc154270979288b0590946017c8bebab8c6d4a7`;
  `package-lock.json` SHA256 is
  `86220e0f3228b9914c17ac575f6603cf52c4ed44551ea274c6b6f9a45a933d42`.
  Both are identical to the pin owner's frozen worktree files.
- Derivation `vafw2fky0kdhpcidzpfg39zkb2jdzp25-pi-workspace-packages-1.1.0.drv`
  explicitly uses this frozen source, this `cp3…` dependency input, and this
  `c2h…` catalog. Its output is `6mq…`; its recorded build Node is **22.23.2**.
  That successful old build is **not** a claim of Node24 native-addon parity.

## Offline source bootstrap, without replacing tracked manifests

This recipe is for the existing source owner in **their own frozen feature
worktree**, not C1 or an installed runtime. A fresh private npm cache may be
seeded from the verified tarballs by their real lock integrity, then stock
`npm ci` uses the **unchanged original lock**. This preserves ordinary relative
workspace links, instead of letting the localized manifests point imports at
immutable store source. No shared cache/root is cleaned or overwritten.

The recipe below has not been executed by the pin owner; the inputs and npm's
cache-by-integrity mechanism were verified read-only. It is not a claim that
Node24 source build/tests or native addons have already passed.

```bash
set -euo pipefail
# Run only in your own confirmed 26205caa feature tree.
test "$(git rev-parse HEAD)" = 26205caa390b533cfab5832556eae6972dcd8125
export FROZEN_262=/nix/store/kpjgjqki0n3mr1d3axazsd8lmaz55866-source
export NIX_DEPS_262=/nix/store/cp3nyzgbizjlp412h0w4p2cfarz2xhrp-pi-monorepo-0.0.3-sources
export NODE24_PREFIX=/nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0
export NODE24_NPM="$NODE24_PREFIX/lib/node_modules/npm/bin/npm-cli.js"
cmp package.json "$FROZEN_262/package.json"
cmp package-lock.json "$FROZEN_262/package-lock.json"
export FROZEN_NPM_CACHE="$(mktemp -d "$PI_SCRATCH_DIR/frozen262-npm.XXXXXX")"
mkdir -p "$FROZEN_NPM_CACHE/home"
: > "$FROZEN_NPM_CACHE/user.npmrc"
: > "$FROZEN_NPM_CACHE/global.npmrc"
export HOME="$FROZEN_NPM_CACHE/home"
export NPM_CONFIG_USERCONFIG="$FROZEN_NPM_CACHE/user.npmrc"
export NPM_CONFIG_GLOBALCONFIG="$FROZEN_NPM_CACHE/global.npmrc"
export NPM_CONFIG_CACHE="$FROZEN_NPM_CACHE"
export NPM_CONFIG_OFFLINE=true
export PATH="$NODE24_PREFIX/bin:$PATH"
export UV_THREADPOOL_SIZE=1
export NODE_OPTIONS=

"$NODE24_PREFIX/bin/node" --input-type=module -e '
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
const cacache = createRequire(process.env.NODE24_NPM)("cacache");
const raw = JSON.parse(readFileSync(join(process.env.FROZEN_262, "package-lock.json"))).packages;
const local = JSON.parse(readFileSync(join(process.env.NIX_DEPS_262, "package-lock.json"))).packages;
if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(Object.keys(local).sort()))
  throw new Error("Frozen package-key mismatch");
let seeded = 0;
for (const [key, pkg] of Object.entries(raw)) {
  if (pkg.link || !pkg.resolved) continue;
  const pinned = local[key];
  if (pinned.version !== pkg.version || !pkg.integrity ||
      !pinned.resolved?.startsWith("file:/nix/store/"))
    throw new Error("Not a verified frozen tarball: " + key);
  await pipeline(
    createReadStream(pinned.resolved.slice(5)),
    cacache.put.stream(join(process.env.FROZEN_NPM_CACHE, "_cacache"),
      "frozen262:" + key, { integrity: pkg.integrity }),
  );
  seeded++;
}
if (seeded !== 362) throw new Error("Unexpected tarball count: " + seeded);
console.log("Seeded 362 exact frozen tarballs; no provider/network request");
'

# Ignore install scripts just as the frozen Nix dependency installation did.
# This does NOT silently qualify Node24 native bindings.
"$NODE24_PREFIX/bin/node" "$NODE24_NPM" ci \
  --offline --ignore-scripts --no-audit --no-fund
cmp package.json "$FROZEN_262/package.json"
cmp package-lock.json "$FROZEN_262/package-lock.json"

# The existing hydrator consumes the actual typed catalog, never placeholder data.
"$NODE24_PREFIX/bin/node" packages/ai/scripts/hydrate-model-catalog.ts \
  /nix/store/c2hfynrx0mf60mg26x4mid732wgygdcw-pi-model-catalog.json
# Source owner may then run their exact bounded offline build/regressions.
```

Npm's realized `pacote/lib/fetcher.js` uses
`cacache.get.stream.byDigest(cache, integrity, opts)` for this path. Seeding
verified bytes by the original integrity therefore avoids registry lookups
without inventing dependencies. Keep offline enabled; if any required input is
absent, stop with that real failure, not a replacement/fake package.

The private cache is disposable runtime state. Put source regression/build
results in the owner's repository before settlement. If Node24 native bindings
are required, their actual rebuild/loading must pass separately; the realized
Node24 headers above are an input, not an assumed passing build.

## Limits / custody

No native transport/private-context capture was performed or authorized. The
original picker still selects GPT, so no MiMo probe/model change is authorized.
The public `code: string` schema inspection alone does not establish a production
serialization bug. No repair hypothesis or original-oracle success is claimed.
The #2804 source head, Linux artifact pin and sole infra CI/release ownership
remain unchanged. Changed adapter/build bytes still return to the pin owner for
exact-head artifact requalification before adoption.

A bounded store-name lookup and one `nix-store -q --deriver` each reached their
30-second timeout. The daemon query was not repeated as a wait or bypassed.
Provenance above comes from already-realized `.drv` files and direct hash
validation, not a new build, cache sweep or successful global store scan.
