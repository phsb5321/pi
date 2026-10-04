#!/usr/bin/env bash
# test-mem-probe-bounded — minimal exact tests for the bounded wrapper.
# All external inputs are deterministic PATH stubs (pgrep/shuf) and a stub
# mem-probe that writes capture files. Never enumerates real seats; never
# runs a fleet probe. Cases: real exit 0/3/2, timeout, invalid values (64),
# leading-zero canonicalization, stream + per-file overflow caps, receipt.
set -u
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d "${TMPDIR:-/tmp}/mpb-test.XXXXXX"); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/bin"
cp "$here/mem-probe-bounded" "$t/w"; chmod +x "$t/w"

# Deterministic PATH stubs: no real seat enumeration.
cat > "$t/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
printf '1001\n1002\n1003\n'
EOF
cat > "$t/bin/shuf" <<'EOF'
#!/usr/bin/env bash
n=999
while [ "$#" -gt 0 ]; do case "$1" in -n) n="$2"; shift 2 ;; *) shift ;; esac; done
head -n "$n"
EOF
chmod +x "$t/bin/pgrep" "$t/bin/shuf"
PATH="$t/bin:$PATH"; export PATH

# Stub probe: honors --out (writes a capture file), env-driven rc/out/err.
cat > "$t/mem-probe" <<'EOF'
#!/usr/bin/env bash
sleep "${STUB_SLEEP:-0}"
outp=""
while [ "$#" -gt 0 ]; do case "$1" in --out) outp="$2"; shift 2 ;; *) shift ;; esac; done
if [ -n "$outp" ]; then
  dd if=/dev/zero of="$outp.jsonl" bs=4096 count="${STUB_CAP_BLOCKS:-50}" 2>/dev/null
fi
head -c "${STUB_OUT_BYTES:-4}" /dev/zero | tr '\0' 'x'
head -c "${STUB_ERR_BYTES:-0}" /dev/zero | tr '\0' 'e' >&2
exit "${STUB_RC:-0}"
EOF
chmod +x "$t/mem-probe"

fails=0
ok()  { echo "ok  - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails+1)); }
run() { ( cd "$t" && "$t/w" --out "$t/receipt" "$@" >/dev/null 2>&1 ); echo $?; }

# --- real exit codes: probe exit preserved exactly ---
[ "$(STUB_RC=0 run --cohort 1)" = 0 ] && ok "exit 0 passthrough" || bad "exit 0 passthrough"
[ "$(STUB_RC=3 run --cohort 1)" = 3 ] && ok "exit 3 passthrough" || bad "exit 3 passthrough"
[ "$(STUB_RC=2 run --cohort 1)" = 2 ] && ok "exit 2 passthrough" || bad "exit 2 passthrough"

# --- timeout: bound fires (0 rejected — it would disable it) ---
rc=$(STUB_SLEEP=5 run --cohort 1 --timeout 1); [ "$rc" = 124 ] && ok "timeout fires (rc 124)" || bad "timeout fires (got $rc)"

# --- invalid values: all exit 64 ---
for a in "--cohort abc" "--cohort 0" "--cohort -3" "--cohort 26" "--timeout 0" "--timeout abc" "--seed x" "--seed 12\",\"z" "--condition bogus" "--condition idle\",\"x"; do
  # shellcheck disable=SC2086
  [ "$(run $a)" = 64 ] && ok "invalid: $a -> 64" || bad "invalid: $a"
done
[ "$(run --cohort)" = 64 ] && ok "missing operand -> 64" || bad "missing operand"

# --- leading zeros: accepted + canonicalized to valid JSON numbers ---
( cd "$t" && "$t/w" --out "$t/receipt" --cohort 08 --timeout 007 >/dev/null 2>&1 )
python3 - "$t/receipt" <<'EOF' && ok "leading zeros canonicalized (08->8, 007->7)" || bad "leading zeros canonicalized"
import json,sys
r=[json.loads(l) for l in open(sys.argv[1]) if l.strip()][-1]
assert r["cohort"]==8 and r["timeout_s"]==7, r
EOF

# --- stream overflow: both capped at 64 KiB ---
( cd "$t" && STUB_OUT_BYTES=200000 STUB_ERR_BYTES=200000 STUB_RC=1 "$t/w" --out "$t/receipt" --cohort 1 --advisory >"$t/big.out" 2>"$t/big.err" )
[ "$(wc -c < "$t/big.out")" -le 65536 ] && ok "stdout capped" || bad "stdout capped"
[ "$(wc -c < "$t/big.err")" -le 65536 ] && ok "stderr capped" || bad "stderr capped"

# --- per-file overflow: RLIMIT_FSIZE hard-caps capture files (dd blocks
# until the 64 KiB limit, then EFBIG/SIGXFSZ); rc passes through honest.
( cd "$t" && STUB_CAP_BLOCKS=50 STUB_RC=1 "$t/w" --out "$t/receipt" --cohort 1 --condition idle >/dev/null 2>&1 )
python3 - "$t/receipt" <<'EOF' && ok "capture file hard-capped at 64 KiB + honest rc" || bad "capture file hard-capped at 64 KiB + honest rc"
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
last=rows[-1]
assert last["exit"]==1, last                          # probe rc passthrough unchanged under overflow
assert last["capture_bytes"]==65536, last             # hard RLIMIT_FSIZE bound = bounded overflow evidence
assert rows[0]["exit"]==0, rows[0]                    # clean row honest too
EOF

echo "---"; [ "$fails" = 0 ] && echo "ALL PASS" || echo "$fails FAILURES"; exit "$fails"
