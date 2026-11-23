#!/usr/bin/env python3
"""Refuse to pin a fleet revision that Forgejo cannot vouch for.

Run this before a consumer (the NixOS flake) is pointed at a pi revision:

    python3 -B packaging/fleet/pin-ref-guard.py <40-hex sha>

It exits 0 only when BOTH hold on Forgejo, the fork's forge of record:

  1. a branch contains the commit, so the object cannot be garbage-collected and the
     GitHub mirror (which prunes to Forgejo's branch set) carries it;
  2. the two CI-of-record contexts, `ci / generate` and `ci / build-check-test`, are
     green on that exact commit.

Why it exists (11/11/2026): the fleet pin moved to 3650f4348, a commit pushed to GitHub
only. The mirror pruned its branch within a day, leaving every fleet build dependent on an
unreferenced object, and the commit had never been through CI: it was missing 67 accepted
fleet commits and nothing said so.

Exit codes: 0 pinnable, 1 refused, 2 could not decide (network, auth, bad argument). An
undecided run is not a pass.

`--self-test` checks the decision rule against canned forge answers; it needs no network.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

URL = os.environ.get("PIN_GUARD_FORGEJO_URL", "https://server.tailf59220.ts.net:13001")
REPO = os.environ.get("PIN_GUARD_FORGEJO_REPO", "pedro/pi")
TOKEN_FILE = os.environ.get("PIN_GUARD_TOKEN_FILE", os.path.expanduser("~/.config/pi-forgejo/token"))
REQUIRED = ("ci / generate", "ci / build-check-test")


def verdict(branches, statuses):
    """Pure rule. `branches`: names containing the commit. `statuses`: the combined-status
    entries for the commit, each with `context` and `status`. Returns (ok, reasons)."""
    reasons = []
    if not branches:
        reasons.append("no Forgejo branch contains this commit")
    for want in REQUIRED:
        # Forgejo appends the triggering event: "ci / generate (push)".
        seen = [s for s in statuses if re.fullmatch(re.escape(want) + r"( \([a-z_]+\))?", s.get("context") or "")]
        if not seen:
            reasons.append(f"no `{want}` status on this commit")
        elif any((s.get("status") or s.get("state")) != "success" for s in seen):
            got = ", ".join(sorted({str(s.get("status") or s.get("state")) for s in seen}))
            reasons.append(f"`{want}` is {got}, not success")
    return (not reasons, reasons)


def api(path):
    with open(TOKEN_FILE) as f:
        token = f.read().strip()
    req = urllib.request.Request(f"{URL}/api/v1/{path}", headers={"Authorization": f"token {token}"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)


def containing_branches(sha):
    """Commit-graph-only fetch of every branch head, then ask git. Trees and blobs are not
    downloaded, so this costs a few megabytes however large the repository is."""
    with tempfile.TemporaryDirectory(prefix="pin-ref-guard.") as tmp:
        def git(*args, check=True):
            return subprocess.run(["git", "-C", tmp, *args], check=check, capture_output=True, text=True, timeout=600)
        git("init", "-q", "--bare")
        git("fetch", "-q", "--filter=tree:0", "--no-tags", f"{URL}/{REPO}.git", "+refs/heads/*:refs/remotes/forgejo/*")
        if git("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode != 0:
            return []
        out = git("for-each-ref", "--contains", sha, "--format=%(refname:lstrip=3)", "refs/remotes/forgejo").stdout
        return sorted(b for b in out.split("\n") if b)


def self_test():
    ok = {"context": "ci / generate (push)", "status": "success"}
    ok2 = {"context": "ci / build-check-test (push)", "status": "success"}
    cases = [
        ("branch + both green", ["memory-sound"], [ok, ok2], True),
        ("pull_request-event contexts count too", ["x"], [{"context": "ci / generate (pull_request)", "status": "success"},
                                                           {"context": "ci / build-check-test (pull_request)", "status": "success"}], True),
        ("unreferenced commit, never built (3650f4348 on 11/11)", [], [], False),
        ("archive branch only, never built", ["archive/pin-1.5.2-83a4dd90"], [], False),
        ("green but on no branch", [], [ok, ok2], False),
        ("one context missing", ["memory-sound"], [ok], False),
        ("one context failing", ["memory-sound"], [ok, {"context": "ci / build-check-test (push)", "status": "failure"}], False),
        ("still pending", ["memory-sound"], [ok, {"context": "ci / build-check-test (push)", "status": "pending"}], False),
        ("green on push, red on pull_request", ["memory-sound"], [ok, ok2, {"context": "ci / generate (pull_request)", "status": "failure"}], False),
        ("a look-alike context does not satisfy the rule", ["memory-sound"], [ok, {"context": "ci / build-check-test-extra (push)", "status": "success"}], False),
    ]
    bad = 0
    for name, branches, statuses, want in cases:
        got, why = verdict(branches, statuses)
        good = got == want
        bad += not good
        print(f"{'ok  ' if good else 'FAIL'} {name}: pinnable={got}" + (f" ({'; '.join(why)})" if why else ""))
    print("PASS" if not bad else f"FAILED {bad}")
    return 1 if bad else 0


def main(argv):
    if argv[1:] == ["--self-test"]:
        return self_test()
    if len(argv) != 2 or not re.fullmatch(r"[0-9a-f]{40}", argv[1]):
        print("usage: pin-ref-guard.py <40-hex commit sha> | --self-test", file=sys.stderr)
        return 2
    sha = argv[1]
    try:
        branches = containing_branches(sha)
        try:
            statuses = api(f"repos/{REPO}/commits/{sha}/status").get("statuses") or []
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            statuses = []
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        print(f"UNDECIDED {sha[:12]}: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    ok, reasons = verdict(branches, statuses)
    shown = ", ".join(branches[:4]) + (f" (+{len(branches) - 4} more)" if len(branches) > 4 else "") or "none"
    ci = ", ".join(f"{s.get('context')}={s.get('status') or s.get('state')}" for s in statuses) or "none"
    print(f"{'PINNABLE' if ok else 'REFUSED'} {sha[:12]}  branches: {shown}  ci: {ci}")
    for r in reasons:
        print(f"  - {r}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
