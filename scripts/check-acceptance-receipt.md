# Acceptance receipt checker v1

Offline, deterministic, data-only validation. No dependencies beyond Node 22+.

```sh
node --test scripts/check-acceptance-receipt.test.mjs
node scripts/check-acceptance-receipt.mjs \
  "$EXPECTED_FULL_SHA" /trusted/oracle.json /untrusted/receipt.json /evidence \
  build-check-test regression
```

Exit 0 and `{"ok":true,...}` mean only: all explicitly required checks succeeded
in the trusted snapshot at the expected commit, and the receipt matches its
nonempty, SHA-256-verified local evidence. Every error exits 1 with `ok:false`.
It does **not** mean merged, deployed, benchmark improvement, or ledger acceptance.

## Inputs and trust boundary

p2E supplies the expected full lowercase 40-character commit SHA and reviewed
check IDs independently of the receipt. IDs are names, never shell commands.
No implicit defaults: an empty required-check list fails. Both documents must
contain exactly those checks, once each.

The oracle must be independently obtained by p2E from the CI-of-record or a
reviewed local runner, not copied from a worker's receipt. It is a normalized
snapshot, **not an authenticated CI transport**. The checker cannot distinguish
a forged oracle from a genuine one, establish run freshness at the same SHA,
or decide whether a selected test actually proves the claim. p2E must verify
source, latest relevant run, exact head SHA, check meanings and artifact provenance
before supplying it. Do not use an agent-authored oracle as proof.

Oracle and receipt have the same strict schema:

```json
{
  "schemaVersion": 1,
  "sha": "<full commit SHA>",
  "checks": [
    {
      "id": "<reviewed check ID>",
      "sha": "<same full commit SHA>",
      "conclusion": "success",
      "exitCode": 0,
      "evidence": [
        { "path": "relative/check.log", "sha256": "<64 lowercase hex characters>" }
      ]
    }
  ]
}
```

Angle-bracket values above are placeholders, not usable evidence. Tests use
explicitly synthetic fixtures; they are not Forgejo results.

Each required check needs at least one artifact. The oracle pins its paths and
hashes; the receipt must match the exact set. Files must exist, be nonempty and
at most 8 MiB each. Absolute paths and realpath/symlink escapes are rejected.
Run over a stable snapshot: concurrent file mutation is not a supported trust
boundary. The checker is not a sandbox against other processes with the same UID.

A command must actually have completed successfully. Missing/failed/string exit
codes and non-success conclusions are rejected, even when a receipt claims a
pass. CI adapters must preserve failure; do not synthesize `exitCode:0` from
missing data. If CI has no trustworthy process result or artifact, stop rather
than invent one. v1 intentionally does not fetch CI, parse free-form logs,
execute `<acceptance>` recompute text, or interpret benchmark numbers.

Unknown fields (including `passes`, `measured`, `command` and `recompute`) fail.
The checker never executes subprocesses, performs network I/O, writes files,
updates the ledger, or grants permission to merge. Existing prose acceptance
blocks need a separately reviewed normalization step, not shell evaluation.

## p2E integration

1. Pin the proposed head SHA and reviewed check IDs outside worker input.
2. Obtain completed results and artifacts independently; create a stable local
   evidence directory and trusted normalized oracle snapshot.
3. Run the checker with the worker's normalized receipt. Preserve JSON output,
   exit status, oracle provenance, artifacts and exact checker version/hash.
4. Treat failure or unavailable evidence as non-acceptance. Only p2E decides
   whether the verified checks satisfy that row's acceptance and changes the
   real ledger. No `passes`/`measured` value is emitted by this checker.

No wiring to CI or the real ledger is included in this slice. To reverse the
patch, remove the three `scripts/check-acceptance-receipt.*` files.
