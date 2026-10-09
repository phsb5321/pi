# FEASIBILITY — E: off-heap / compressed conversation state

Fork-only doc (memory-sound program), 01/10/2026 23:0x BRT, owner w28:p6.
Never PR this file upstream. Binding rules apply at claim time: every
implementation claim ships the `docs/PROGRAM-RULES.md` trio (mem-probe
table idle+mid, kill-9 conformance, matrix row); bars per the class-point
rule (exposure-controlled gate runs set points; single runs never do).

Target class: **the +45.8 MiB/10.5h worked-session conversation state**
(retention ledger: closes at +43.5 ≈ observational +45.8 ±5 %; the class
the MS-21 windowing slices measured NO-WIN against — the reachable
attack is the payload state itself, not its access paths).

---

## E — off-heap / compressed conversation state

Attack: move the retained conversation payload (message strings, tool
result blobs, render/export strings — the H1/H3 payload carriers) out of
the V8 heap: either **compressed retention** (byte-lossless deflate/
brotli backing, lazy decompress-on-access behind a value-equal facade)
or **off-heap backing** (V8 external strings / ArrayBuffer-backed string
stores). Substrate change only: the conversation surface (message
objects, values, ordering) stays identical.

| field | |
|---|---|
| **Measured ceiling** | **≈ 25–30 MiB/seat attackable** of the +45.8 class (the payload carriers: retained content ~15 + blobs 9.3 + array/object/identifier growth ~11 from the M1 ledger; slack/swap is out of scope) → **fleet ≈ 7.3–8.8 GiB** (306 seats) before compression ratio. Compressed at observed text ratios (deflate on prose/JSON ≈ 3–4×): net save **≈ 18–25 MiB/seat → 5.4–7.3 GiB fleet**. ESTIMATED — the compressibility measurement is the GO experiment below. |
| **Effort + risk** | Effort **M–L**: storage-substrate swap behind the harness session state (the facade + lazy codec) + conformance hardening. Risk **M**: decompress cost at render/turn boundaries (mitigate: decompress window, cache the hot tail); string-pool churn on round-trip; the JSONL write path must serialize from the facade (value-equal) — enforced by the kill-9 suite. Off-heap-external-string variant risk **S–M** (zero codec cost) but platform-specific V8 APIs. |
| **Matrix row** | **invisible** — the class definition's own "off-heap backing" example; same surface, different substrate. Evidence-gate per the S3 ruling: held-reference identity probe extended to message objects across a compress/decompress cycle (strings are value-typed in JS — equal strings compare equal — but run the probe at object granularity to keep the standard). Demotes to **needs-restart** if any API hands out backing-store references (identity probe governs). |
| **Upstream PR shape** | **U2** (substrate adoption behind the existing Storage/session interfaces — needs maintainer buy-in for the default) with U3 mechanics separable. Rides the durable compaction+overflow momentum (Package 20) — the natural upstream home is `packages/durable` storage substrate + `packages/agent` harness session state. Issue first + `lgtm` per CONTRIBUTING; the codec flag (on/off + codec choice) keeps it revertible. |
| **Dependencies** | `node:zlib` (brotli/deflate — zero new deps) or V8 external-string backing; the kill-9 conformance harness (exists, `storage-conformance` class); the held-reference identity probe (exists, S3 standard); Package 20 durable overflow (landed). Calm-window measurement run (host protocol). |
| **GO/NO-GO** | **CONDITIONAL-GO.** The ceiling is the largest single attackable class left (25–30 MiB/seat vs the ~40 MiB stack already banked), the matrix row is invisible with a proven test standard, and kill-9 byte-identity is achievable by construction (below). Conditions: (1) compressibility experiment measures ≥ 2× on real worked-session payloads (else the class compresses to nothing and it is NO-GO); (2) the object-granularity identity probe passes; (3) the decompress-at-turn cost shows ≤ S latency impact. **NO-GO** for any lossy variant (byte-identity forbids it) and NO-GO without the binding trio at claim time. |

### Assessment against the three required axes

**Kill-9 byte-identical conformance — YES, achievable by construction.**
The JSONL on disk is the source of truth and its write path does not
change: compression/off-heap backing is a memory-retention substrate, not
a serialization change. kill -9 loses memory state equally in both
variants; resume rebuilds from the JSONL; the transcript comparison is
byte-identical iff the facade serializes value-equal (deflate is
byte-lossless; external strings are exact). The kill-9 harness + the
capture/restore identity probe (already proven 4/4 on the S9 class)
enforce it. One real seam: kill -9 mid-append has identical torn-write
semantics as today (unchanged code path) — no new failure mode.

**Plugin-visible state — INVISIBLE, under the S3 identity standard.**
The conversation surface is value-typed (message objects + strings);
the backing swap is unobservable unless an API exposes backing-store
identity. Strings are value-typed in JS, so equal-content swaps are
invisible even to `===`. The demotion test (held-reference probe across
a compress cycle at object granularity) is the gate: it passing keeps
the row invisible; any reference escape demotes to needs-restart
(plugin-visible; arbitration). The render-cache precedent (S9/S11, 14
seams clean) is the closest sibling — same discipline.

**Upstream durable path — CLEAR, U2 on the Package 20 rail.** The
durable compaction+overflow work (upstream, just landed) is the
substrate conversation state should ride: compressed retention slots
into the same overflow/spill story (cold payload → compressed/off-heap,
hot tail → live). The PR is a substrate option behind existing
interfaces (no new required hooks, no signature changes) — the U2 ask is
adoption/default policy, not architecture. Fork-first proof via the
binding trio; upstream issue cites the measured table.

### Experiment (recipe-ready, one calm window)

3 arms × n≥3 worked sessions (the +45.8 class needs transcript-length
scaling — the S11 lesson: one-turn synthetic understates; use the
seeded 485-entry/2 MB class, then a 2×-seed arm to confirm scaling):
A = base, B = deflate-backed facade, C = external-string backing.
Measure: mem-probe idle+mid table (PSS+SwapPss, SwapPss separate),
compress-ratio + decompress-latency counters, kill-9 conformance +
object-granularity identity probe + custom-component smoke per arm.
Bars: class-point rule (gate run sets the point; this table informs it).
