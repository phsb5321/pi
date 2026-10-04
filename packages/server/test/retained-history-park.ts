/**
 * retained-history-park — test-side re-export of the canonical wrapper.
 *
 * Provenance: p9's 005 worktree carried this file as a BYTE-IDENTICAL
 * test-local copy of `../src/retained-history.ts` (verified at integration:
 * 0-line diff, PORT-PI-BLOCKERS-1334). The integration keeps ONE canonical
 * copy in src (p9-owned, never edited here) and re-exports it so the
 * committed parity suite's import path resolves without duplicating the
 * module (the duplicate tripped the clone gate: 515-token clone).
 */
export * from "../src/retained-history.ts";
