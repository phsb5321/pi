# COMPOSITION-1206 — immutable composition/build manifest (PORT-PI-1206)

Frozen: 2026-10-04 (ISO). Owner: p4 (sole immutable composition/build
ownership). Consumer: p3 (candidate/measurement) after W3 containment;
p7 (publication, `PR-PREP-shared-host.md`). Status taxonomy per PR-PREP:
SOURCE / LIVE / ACCEPTED / 100x = UNPROVEN.

## Composition commits (exact, `ms/shared-session-host` lineage)

| SHA | Content | Author lane |
|---|---|---|
| `59e7842de` | shared-host entry + multi-session canary (item 12 slice) | p4 |
| `a26622401` | thin-client leg (client-attach + thin-client + contract tests) | pD |
| `d59a8bcad` | docs: TARGET re-scope (100x objective; 10x labelled intermediate) | root |
| `0e17d59fe` | client lazy-presentation mode + measured presentation-cost row | pD |
| `f4c584a67` | per-session DurableOptionsResolver + reversible live-canary stage | p4 |
| `237427f1e` | SharedHostCore seam source tracked (composition completeness) | p4 |
| (this commit) | owned acceptance source tracked + this manifest | p4 |

Correction of record: the live-stage/resolver revert is
`git revert f4c584a67`. `0e17d59fe` is pD's CLIENT commit and must not be
reverted for live-stage removal.

## Lockfiles (exact, hashed at freeze)

- `package-lock.json` (root)
- `packages/coding-agent/npm-shrinkwrap.json`

SHA-256 values and the resolved source hashes (git tree hash of the freeze
commit + per-package `git archive <sha> packages/<pkg>/src | sha256sum`) are
recorded in the freeze receipt:
`~/Documents/Notes/1. Projects/Memory-Sound Program/evidence/MS-20/composition-freeze-1206/`.

## Build ownership (binding)

- **One build owner** (p4), within the existing admitted serialized offhost
  budget only. **No desktop heavy build. No live turn.**
- **No borrowed mutable package artifacts**: the 330 working-tree dists,
  g4-bundle dists, and workspace `node_modules` links are local conveniences
  and are NOT composition inputs. A build is valid only if produced inside a
  clean checkout of this freeze.
- **No concurrent 330/g4 rebuilds** while the build owner runs.
- Build hashes (dist artifact digests) bind into the freeze receipt when the
  build owner executes; until then they are explicitly PENDING.

## Measurement hold (binding)

The composed measurement — matched before/after whole-tree PSS+SwapPss at
N = 1/8/32 (idle/mid/peak, same workload/history/concurrency in both arms;
whole tree includes terminals, clients, daemons, workers; real SDK + thin
presentations + history) — is **HELD** until admitted W3 containment. W3
currently shows a tmux sibling-scope escape under p3/infra. Per-parked-seat
Node/V8 isolate substitutes are banned as 100x evidence (PR-PREP protocol).

## Acceptance binding (lightweight, provider-free)

`packages/coding-agent/src/experimental/durable/shared-host-acceptance.ts`
is owned composition source (tracked from this commit). It executes
provider-free (view/abort only; no model turns) against THIS head's own
artifacts once built, and its evidence must cite the exact final source head
+ artifact digests. Previously recorded runs bound to the `59e7842de`-era
working tree are SOURCE-level evidence only.

## Non-claims (binding, per p7 PR-PREP)

- Synthetic canary/pre-pilot/battery-2 runs = proof-of-life, recovery, and
  seam isolation. They do NOT establish real SDK battery, parked-history
  reclamation, or 100x.
- Abort-with-no-active-turn and view-only reads are NOT cancel-of-active-turn
  or streaming/tool/restart evidence. Retirement is OFF; per-session on-open
  context deferral does not prove history reclamation.

## Landing workflow (binding)

Tested PR → normal merge → staged default-OFF pilot + rollback. **Live
activation is not authorized in this lane.** Any declare uses the binding
`DECLARE-CHECKLIST` order: push + `ls-remote` VERIFY first, declare file
last. PR opens only on lgtm (prepare, do not open; no upstream human send).
