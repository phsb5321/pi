# Program rules — binding acceptance gates (01/10/2026)

These rules are not guidance. A change that misses any of them does not merge.

## 1. Memory table — required

Every change ships with a mem-probe before/after table: **PSS + SwapPss per seat
process tree**, idle **and** mid-turn, against the MS-04 baseline
(`docs/MEMORY-BASELINE.md`). No table, no merge.

## 2. Conformance — kill −9 vs clean-exit

Every optimization passes the conformance gate: a seat killed with SIGKILL while
idle must resume **byte-identically** — same transcript, same restored
plugin-visible state (editor draft, tree cursor, tool output) — as a clean
exit/resume. The parity harness lives in
`packages/agent/src/harness/session/testing/conformance/`. Failing this blocks
the change.

## 3. Plugin compatibility matrix — zero breaking rows

Every optimization carries its matrix row:

| class | meaning |
|---|---|
| **invisible** | plugin code cannot observe it (lazy eval, heap caps, off-heap backing) |
| **opt-in hook** | plugins that implement `onQuiesce`/`onResume` benefit; others unaffected |
| **needs restart** | plugin-visible; requires explicit arbitration |
| **breaking** | forbidden — no merge, ever, without a recorded G-ruling and Pedro sign-off |

**The law:** same surface, different substrate. No new *required* hooks, no
signature changes, no timing assumptions. Extensions (`codemode`, `llama`,
`mcp`, `tool-search`, telemetry, parity) must keep working unchanged.

## 4. Behavior-identical

The project stays the same to users and plugins. Deliverables are **PRs back to
`earendil-works/pi`** from `phsb5321/pi`: PR only NEW-CONTENT after merge-main +
tests. Nothing fork-only unless it is fleet wiring.

## 5. Gate owners

- **p6 (Tester)** enforces rules 1–3 at review; verdicts are reported to p2.
- **p2 (Orchestrator)** polices the program and records G-rulings for deviations.
- **p5 (PO)** holds acceptance criteria; items missing any of the three
  artifacts are not prioritizable.

Rules land by amendment (commit on `memory-sound`) — silent drift is not
allowed.
