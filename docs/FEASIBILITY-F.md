# FEASIBILITY — F: immutable data + adoption (one-copy catalogs · fleet pin swap · upstream sync)

**F VERDICT: GO on F2 (adoption — the fleet runs the patched build via the
Nix pin swap; mechanism exists and deploys tonight). NO-GO on F1 standalone
(one-copy immutable data: per-process it is already one copy, and the
measured bytes are a rounding error) — F1 survives only as A's data-sharing
annex (≤ 0.3 GiB fleet on its own).**

Fork-only doc (memory-sound program), 01/10/2026 20:4x BRT, owner w28:pC
(R3). Track F per `docs/FEASIBILITY-BRIEF.md` (Pedro directive: the ~40
MiB/seat stack is NOT ENOUGH — structural tier); p2 compiles
`docs/FEASIBILITY.md`. Never PR this file upstream. Binding rules apply at
claim time: every implementation claim ships the `docs/PROGRAM-RULES.md`
trio (mem-probe table idle+mid, kill-9 conformance, matrix row); bars per
the class-point rule; plan rule 1 (behavior-identical); proxy numbers are
not citable.

Measurement window note: no seats launched for this doc — all numbers are
existing measured classes (M1 differential 30/09, S1/S5 declares, MS-04
census, MS-25 wrapper review 01/10). Fleet figures are ESTIMATED.

---

## Attack surface (F classes, per-seat, worked seats)

The brief's three named stores — prompts, skill catalogs, syntax tables —
are measurably SMALL, and mostly already single-copy:

| store | measured resident | one-copy status | owner track |
|---|---|---|---|
| skill catalogs + prompt templates | **≈ 0** (S5 declare verified 01/10: residency ≈ 0; what stays resident is the yaml/ignore PARSE machinery, pinned by browser-bundlability — immovable in U3; deferred-parse win parked at the U2 parser-facade) | module-registry singleton (one copy per process by construction) | S5 (landed) |
| syntax tables (hljs grammars) | **1.0 MiB used-grammars tail** (P90 A/B row) — gross class ceiling **7.0 MiB** (p6 A−B nocode; M1 corroborates 6.7 loaded-source + 1.0 grammars = 7.7) | module-registry singleton; per-language lazy registration already landed (S1, **Δ 9.7 banked**) | S1 (landed) |
| prompts (system/role text) | folded into S5 ≈ 0 | ditto | S5 |

**F1 total: ≈ 1 MiB/seat of not-already-shared bytes ≈ 0.3 GiB fleet
(306 seats) — the structural prize is NOT here.** The program's real data
mass is elsewhere and already has owners: session content ≈ 15 MiB/seat
(MS-21/E), render/export blobs ≈ 9.3 (S9/S10/S11/B), code-as-text ≈ 11.6
(D/`FEASIBILITY-process-baseline.md`). Two further observations from the
same frames: (a) tiny-identifier strings run 2.2–3.2 MiB/seat (interning
candidate — V8 already internalizes many; ESTIMATED 0–1 MiB win, not
worth a slice on its own); (b) the "one copy per fleet" premise is
process duplication — V8 heaps cannot share objects across processes at
all, so cross-process single-copy needs track A's shared process or S10's
off-heap/foreign memory. Both are dependencies, not levers F owns.

---

## F1 — Immutable data: one copy of prompts / skill catalogs / syntax tables

Dedup + interning of the read-only catalogs; cross-process single copy via
shared mapping.

| field | |
|---|---|
| **Measured ceiling** | **≈ 1 MiB/seat (used-grammar tail; S5 stores ≈ 0) → fleet ≈ 0.3 GiB hard bound, ESTIMATED 0–0.3 GiB.** Under track A (N sessions/proc) the catalogs share for free and F1's marginal work is the design note; under S10 foreign memory the tables could be mmap-shared CoW across processes — but 0.3 GiB does not pay for either. Interning tail ESTIMATED +0–1 MiB/seat. |
| **Effort + risk** | **S** for in-process dedup (they are already module singletons — mostly a no-op audit); **L** for cross-process (requires A or S10 first). Risk **S** in-process (behavior-identical by construction: same strings, fewer copies); cross-process identity semantics (`===` on returned strings/arrays becomes observable if copies collapse) need the S10 held-reference probe discipline. |
| **Matrix row** | **invisible** for dedup/interning (probe-gated: held-reference + byte-identical output); cross-process foreign-memory tables = **needs-restart** (runtime representation change) with a G-ruling, same class as S10's row. |
| **Upstream PR shape** | **U3 where measured — and nothing here measures > S**, so no PR now. The cross-process story is not its own PR: it rides A's `packages/server` RFC (or S10's off-heap PRs). The design note (which stores are immutable + shareable: theme tables, grammar registry, skill catalog ASTs, prompt template text, syntax tables) is cheap and SHOULD be attached to A's RFC as the data-sharing annex. |
| **Dependencies** | S1 + S5 (both landed — they already consumed the bankable wins in these stores); **track A** (shared runtime) or **S10** (off-heap/foreign memory) for any cross-process claim; p6 §3 matrix row before any claim. |
| **GO/NO-GO** | **NO-GO standalone.** Per-process the copies already don't exist (module registry), the measured bytes are ≈ 1 MiB/seat after S1/S5, and cross-process sharing is A's substrate, not an F build. **CONDITIONAL-GO as A's annex** — fold the immutable-store design note into the A RFC; re-run the arithmetic only if A GOs. |

## F2 — Adoption: the fleet runs our patched build as the pinned pi runtime

Nix pin swap before npm publishes 1.0; upstream sync burden.

The mechanism exists and is landing tonight (MS-25 = NixOS#2536, reviewed +
deployed by this seat): the fleet wrapper prefers a shared, bundle-pinned
install at `$PI_FLEET_ROOT/current` when its `package.json` version equals
the Nix pin `piVersion` (`modules/home/pi.nix:85`, today `0.99.0`), fails
open to the npx cache otherwise, and stamps every seat with install identity
(`PI_FLEET_PIN = <version>+<sha512(dist/cli.js)[0:8]>`, `PI_FLEET_WRAPPER_REV`,
`PI_FLEET_NODE_FLAGS`) in `/proc` — so cohort attribution is mechanical
(the MS-04 census could not separate wrapper versions from seat age; now it
can).

Adoption runbook (per host):

1. Build/pack the fork (`packaging/fleet` on phsb5321/pi `ms/fleet-packaging`,
   `fleet-install.sh` materializes `current`); the bundle's `package.json`
   version MUST equal the pin (exact-match gate — tampered/skewed bundles
   are refused by construction).
2. Bump `piVersion` in `modules/home/pi.nix` to the patched version string
   (e.g. `0.99.0-ms.<sha>`); bump `PI_FLEET_WRAPPER_REV` iff launcher
   semantics change (MS-25 comment protocol).
3. `nixos-smart-switch` (never raw activation — the guard class); new seats
   pick the patched runtime, old seats finish naturally.
4. Rollback = one-line pin swap back (wrapper falls open to the npx cache;
   live rollback `sudo nixos-rebuild switch --rollback`).

| field | |
|---|---|
| **Measured ceiling** | No new memory class — **F2 is the delivery channel for every banked win** (S1 Δ 9.7 + G4 bundle + S9/S10/S11 + MS-21/22 against the +43.5 MiB worked-seat growth). Rule of thumb from the census: **10 MiB/seat landed ≈ 3.0 GiB fleet (306 seats)**; without adoption the wins stay on `ms/*` branches and the fleet keeps running npm 0.99.0. |
| **Effort + risk** | **S** to execute (exists: one-line pin + bundle rollout + smart-switch; reviewed fail-open this seat 01/10). **M recurring** = the upstream sync burden: every upstream release → rebase `ms/*` off `upstream/main`, re-pin, re-run the PROGRAM-RULES trio for any wrapper-semantics delta. Risk **M**: fork drift accelerates toward upstream 1.0 (API/package-layout churn — `packages/server`, session-backends); mitigations: upstream-first (MS-05 gate, `lgtm` earned before any PR — earendil-works/pi#10308 posted 01/10), minimal-diff U3 discipline, `PI_FLEET_PIN` cohorts prove which build a measurement came from. |
| **Matrix row** | The swap itself is **needs-restart** (whole-runtime replacement; seats converge at natural idle, never mid-turn). Each carried patch keeps its own matrix row — a patched build is plugin-visible exactly to the extent its diffs are; there is no blanket "invisible" for a fork. |
| **Upstream PR shape** | Not a PR — fleet ops. Upstream side = the sync discipline: `ms/<slug>` branches off `upstream/main`, one U3 PR per slice behind the MS-05 gate, parked until `lgtm`; the fork converges to "upstream + unlanded PRs" as PRs land. Fork-only artifacts (this doc, wrapper identity, fleet packaging) never go upstream. |
| **Dependencies** | **MS-25/NixOS#2536 (merging + deploying 01/10 evening)**; `packaging/fleet` `ms/fleet-packaging@b3f976b`; `fleet-install.sh`; `nixos-smart-switch` deploy flow; cross-host HEAD parity (desktop first, fleet after); MS-05 upstream gate. |
| **GO/NO-GO** | **GO.** Execute now (in flight 01/10); treat the sync burden as a standing M-cost bought against the program's whole win column; converge upstream-first so the burden shrinks rather than grows. |

---

## Plugin-visible? — extension surface at risk

1. **F1 dedup/interning** — no API touches it (catalog accessors return the
   same content); the only observable is reference identity (`===`) for
   strings/arrays that used to be per-load copies → probe-gated exactly like
   S10's `captureRenderState`/`restoreRenderState` held-reference probe.
   Cross-process foreign-memory tables would expose backing representation
   (Buffer vs string) — the S10 forbidden/needs-restart boundary applies.
2. **F2 adoption** — same API surface, different implementation build; each
   carried patch is a plugin-visible diff with its own row (S1's two-consumer
   highlight rule is the cautionary example: tool renderers observe highlight
   output too). The identity env (`PI_FLEET_PIN` et al.) is additive /proc
   data — invisible to extensions.

## Shared conclusion

F splits cleanly: **the one-copy data lever is nearly exhausted before it
starts** (module-registry singletons + S1/S5 already banked the store wins;
≈ 1 MiB/seat ≈ 0.3 GiB fleet remains, and cross-process sharing is A's
substrate) — **F1 NO-GO standalone, folded into A's RFC as a design annex**.
**Adoption is the load-bearing half of F**: the fleet only keeps the
program's ~43.5 MiB/seat attack surface reductions if it RUNS the patched
build, and the Nix pin swap (MS-25, fail-open wrapper + pin identity) is
the proven, one-line-revertable channel — **F2 GO now**, upstream-first
sync as the standing cost. If track A GOs, F1's annex re-enters with A's
ceiling; not before.
