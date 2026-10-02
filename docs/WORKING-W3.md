# WORKING-W3 — Mid-turn cache policy (eviction DURING turns), 02/10/2026 (pD)

Direction per `docs/WORKING-INSTANCE-BRIEF.md` (plan bf5659c3e): eviction
**during** a turn (S9 was settle-only on a one-turn cohort); extend the
upstream preview caps.

## What exists (S9 state)

- S9 s1 (`44188c517`, merged in `memory-sound`): tool-execution components
  drop renderer reuse chains, converted images, and image children **after
  the working state quiets 5 s with no active turn**; next render rebuilds
  byte-identically from call + result. Renderer-owned state stays.
  **Explicitly never evicts mid-turn.**
- S9 s2 (`6c68ec148`): capture/restore API = the §3 identity surface
  (value-equality across eviction+rebuild).
- Preview caps today: `VisualLinePreview` (codemode `renderer.ts:85,136`,
  MCP `tools.ts:299`) + durable in-flight truncation
  (`truncate.ts:11-12`: 2000 lines / 50 KB per ToolSlot).

**The gap:** a long turn accumulates per-tool render chains + converted
images + preview copies **while tools stream**. Settle-only eviction frees
the class only after the turn; the mid-turn peak is what swap hits.

## Measured ceiling — worked cohort (02/10, pD)

Baseline rows (plan): mid-turn **185.6 MiB** (fleet) / **244.2**
(home-projects). G4 worked cohort (n=6, 2.1 MB worked seed, mem-probe
v1.2.2, `sleep 45` tool turn, proofs 6/6): mid-turn PSS+SwapPss
**125.2** baseline / **120.1** bundle vs idle 88.6/81.5 ⇒ **mid-turn
working delta above idle ≈ 36.6 / 38.6 MiB** (sampled mid max 128.1/124.1;
142.6 on the E-shape arm). At MS-04 fleet scale the mid delta is
**~46 MiB** (185.6 − 139.7 idle).

Composition (measured elsewhere, summed here as the ceiling bracket):
- tool-result render caches: **7.3 MiB** settle class (S9 bundle rows) —
  re-appliable mid-turn for off-viewport tools;
- UI render caches: **12.5 MiB** TRUE exclusive holder (p8 retainer, 168
  asserts) — mid-turn the previous-lines/copy chains grow with stream;
- tool payload + preview copies: tool bytes are **86–95 %** of worked
  retention (pD corpus, 30 sessions: p50 5.0 MiB of 5.8) — preview caps
  bound the rendered copy, not the retained result.

**Evictable mid-turn ceiling ≈ 7–13 MiB/seat** (stale tool components +
preview copies + image conversions above the live viewport), fleet
**2.1–3.9 GiB at 300 seats**. The rest of the 38.6 delta is active work
(streaming state, live tool exec) — not evictable; that bracket is W4's.

## Policy proposal

1. Extend S9's eviction trigger from "settled 5 s" to **mid-turn LRU**:
   keep live/visible tool components warm; drop reuse chains + converted
   images for components scrolled out of the window beyond K (K≈3), always
   via the s2 capture/restore path (rebuild = byte-identical, proven).
2. Extend preview caps: bound `VisualLinePreview` retained line cache per
   component (bytes) and drop preview caches for off-viewport components
   mid-turn; align codemode/MCP caps with the durable 2000-line/50 KB
   shape so a tool result costs one capped representation, not two.
3. Peak interlock: evict-on-new-tool-start (before the next result
   materializes) so the turn's cache footprint is O(viewport), not
   O(tool count).

## Effort / risk

**Effort S–M.** Risk: custom render components (p3 flagged the
custom-component extension surface) — evidence gate keeps them working
(custom-component smoke, already in the five-artifact set). No timing
assumptions on plugins (eviction is internal; rebuild is synchronous with
render).

## Plugin matrix row

**invisible** (evidence-gated): eviction is internal cache management;
plugin-visible state rebuilds value-equal via the §3 identity probe
(capture/restore 4/4 already proven at S9). If a custom component breaks
the identity probe, the row demotes to **needs restart** — the probe is the
gate, not the claim.

## PR shape

**U3** — extends the S9 eviction trigger + preview caps inside existing
components; one PR (small, single-package `coding-agent` + `tui` as
needed). Changelog `Fixed`/`Changed` per package.

## GO/NO-GO

**GO** with the identity-probe + custom-component evidence gate. The class
is real (7.3 measured settle + 12.5 retainer-held), the mechanism exists
(S9), the extension is trigger+cap policy. Measured ceiling 7–13 MiB/seat
worked (fleet 2.1–3.9 GiB).
