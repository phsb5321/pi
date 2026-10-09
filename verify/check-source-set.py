#!/usr/bin/env python3
"""Source-set equality (stdlib only): path SET + mode + blob vs the frozen
index manifest. Symlinks are Git mode 120000 with blob = readlink bytes.
Unsupported modes fail explicitly. Extras = failure (deletions enforced).
Usage: check-source-set.py <manifest.json> <target> [--allow-prefix P ...]
  --allow-prefix: declared old input/artifact paths excluded from the
  EXTRA set (old-projection only; the new pure target runs strict)."""
import json, sys, hashlib, os, stat

def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()

def check(manifest_path: str, target: str, allow) -> int:
    expected = {e["path"]: (e["mode"], e["blob"]) for e in json.load(open(manifest_path))["entries"]}
    actual = {}
    unsupported = []
    for root, dirs, files in os.walk(target, followlinks=False):
        for name in dirs + files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, target).replace(os.sep, "/")
            if os.path.islink(full):
                actual[rel] = ("120000", blob_sha(os.readlink(full).encode()))
            elif os.path.isdir(full):
                continue
            else:
                mode = os.stat(full).st_mode
                if not stat.S_ISREG(mode):
                    unsupported.append(rel)
                    continue
                actual[rel] = ("100755" if mode & stat.S_IXUSR else "100644", blob_sha(open(full, "rb").read()))
    missing = sorted(set(expected) - set(actual))
    extra_all = sorted(set(actual) - set(expected))
    # STRICT by default: ONLY explicit --allow-prefix overrides (no
    # automatic node_modules/dist/.git patterns — an extra source symlink
    # inside any node_modules folder must be REJECTED unless declared).
    def declared_path(p):
        return any(p == a or p.startswith(a.rstrip("/") + "/") for a in allow)
    extra = [p for p in extra_all if not declared_path(p)]
    declared = [p for p in extra_all if declared_path(p)]
    wrong = sorted(p for p in set(expected) & set(actual) if expected[p] != actual[p])
    print(f"CHECK {os.path.basename(os.path.abspath(target))}: expected={len(expected)} actual={len(actual)} missing={len(missing)} extra={len(extra)} declared-extra={len(declared)} mode/blob-mismatch={len(wrong)} unsupported-mode={len(unsupported)}")
    for label, rows in (("MISSING", missing[:8]), ("EXTRA", extra[:8]), ("MISMATCH", wrong[:8]), ("UNSUPPORTED", unsupported[:4])):
        for r in rows:
            print(f"  {label} {r}")
    ok = not missing and not extra and not wrong and not unsupported
    print("RESULT", "PASS" if ok else "FAIL")
    return 0 if ok else 1

if __name__ == "__main__":
    args = sys.argv[1:]
    allow, positional = [], []
    i = 0
    while i < len(args):
        if args[i] == "--allow-prefix":
            allow.append(args[i + 1]); i += 2
        else:
            positional.append(args[i]); i += 1
    sys.exit(check(positional[0], positional[1], allow))
