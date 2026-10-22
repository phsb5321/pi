# Animation variant measurement — P6-ANIM (P5-ANIM-SOURCE2 lineage)

11/10/2026 00:5x–01:0x BRT · ms-ux · shared instrument
`1615-pi-footprint-research-task-20261010/harness/footprint-probe.py`, `--idle-seconds 12
--turn-seconds 17` (same phases as P5-ANIM-SOURCE2), source runners `pi-source-base.sh`
(worktree at 88e2d4210 + slice-1-only state = the pre-policy status line) and
`pi-source-variant.sh` (this branch). Raw: `P6-ANIM-BASE1/`, `P6-ANIM-POLICY1/`
(table.json, result.json, pty-capture.bin).

| state | run | s | PTY B | B/s | ANSI | braille frames (recounted) | spark | CPU % | RSS kB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pre | base | 0 | 3 880 | – | 196 | – | 0 | 0.00 | 4 204 |
| pre | variant | 0 | 3 685 | – | 196 | – | 0 | 0.00 | 4 288 |
| idle | base | 12 | **0** | 0 | 0 | 0 | 0 | 0.00 | 4 204 |
| idle | variant | 12 | **0** | 0 | 0 | 0 | 0 | 0.00 | 4 288 |
| mid_turn | base | 19 | 8 099 | 426 | 363 | – | 0 | 0.00 | 4 204 |
| mid_turn | variant | 19 | 4 503 | 237 | 228 | – | 0 | 0.00 | 4 288 |
| tool_turn | base | 19 | 7 540 | 397 | 341 | – | 0 | 0.00 | 4 204 |
| tool_turn | variant | 19 | 4 293 | 226 | 221 | – | 0 | 0.00 | 4 288 |
| tail | both | 3 | 29 | 10 | 4 | 0 | 0 | 0.00 | – |
| **whole run** | base | – | **15 951** | – | – | **21** | 0 | – | – |
| **whole run** | variant | – | **11 293** | – | – | **4** | 0 | – | – |

Deltas: spinner frames **−81 %** (21→4 at 2 Hz policy vs 80 ms default), mid_turn PTY **−44 %**,
tool_turn PTY **−43 %**, ANSI escapes −37/−35 %, whole-run PTY **−29 %**, idle **0 → 0**
(the idle ⇒ zero-animation contract, held by both and pinned in
`test/status-line-animation.test.ts`), spark 0→0 (readout dormant; semantics pinned as
byte-identical passthrough in `test/status-line-counters.test.ts`), CPU 0.00 everywhere in
this wrapper class (the tick reduction's CPU effect is below this instrument's resolution —
not claimed).

**Instrument caveat (correction to P5-ANIM-SOURCE2's table):** the probe's `SPINNER` regex
includes ASCII `|/-\`, which counts ordinary text (`pi-context-lean.ts`, dashes) as spinner
frames. P5's "idle: 35 spinner frames" was this artifact: the capture holds 21 real braille
frames, all inside `── ⠙ Working ───` busy paints. Spinner counts above are braille-only,
recomputed from the captures; bytes/ANSI/CPU/RSS come from the probe unchanged.
