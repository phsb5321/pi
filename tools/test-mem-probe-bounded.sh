#!/usr/bin/env bash
# test-mem-probe-bounded — minimal exact tests for the bounded wrapper.
# Stubs mem-probe; never touches real seats. Cases: real exit 0/3, timeout,
# invalid values (exit 64), output overflow (64 KiB cap), receipt JSON shape.
set -u
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d "${TMPDIR:-/tmp}/mpb-test.XXXXXX"); trap 'rm -rf "$t"' EXIT
cp "$here/mem-probe-bounded" "$t/w"; chmod +x "$t/w"

# Stub probe: env-driven rc/out/err/sleep.
cat > "$t/mem-probe" <<'EOF'
#!/usr/bin/env bash
sleep "${STUB_SLEEP:-0}"
head -c "${STUB_OUT_BYTES:-4}" /dev/zero | tr '\0' 'x'
head -c "${STUB_ERR_BYTES:-0}" /dev/zero | tr '\0' 'e' >&2
exit "${STUB_RC:-0}"
EOF
chmod +x "$t/mem-probe"

# Deterministic cohort fixture: two short-lived procs whose comm == pi
# (symlinked python3 named pi; kernel comm = exec path basename). Killed
# by the trap — no real seats touched.
ln -s "$(command -v python3)" "$t/pi"
for i in 1 2; do ( "$t/pi" -c 'import time;time.sleep(60)' ) & echo $! >> "$t/fixture.pids"; done
trap 'while read -r p; do kill "$p" 2>/dev/null; done < "$t/fixture.pids"; rm -rf "$t"' EXIT
sleep 0.3

fails=0
ok()   { echo "ok  - $1"; }
bad()  { echo "FAIL - $1"; fails=$((fails+1)); }

run() { ( cd "$t" && "$t/w" --out "$t/receipt" "$@" >/dev/null 2>&1 ); echo $?; }

# --- real exit codes: probe exit preserved exactly ---
[ "$(STUB_RC=0 run --cohort 1)" = 0 ] && ok "exit 0 passthrough (was: returned 1)" || bad "exit 0 passthrough"
[ "$(STUB_RC=3 run --cohort 1)" = 3 ] && ok "exit 3 passthrough" || bad "exit 3 passthrough"
[ "$(STUB_RC=2 run --cohort 1)" = 2 ] && ok "exit 2 passthrough" || bad "exit 2 passthrough"

# --- timeout: bound must FIRE (0 would disable it — rejected) ---
rc=$(STUB_SLEEP=5 run --cohort 1 --timeout 1)
[ "$rc" = 124 ] && ok "timeout fires (rc 124)" || bad "timeout fires (got rc $rc)"

# --- invalid values: all exit 64 ---
for a in "--cohort abc" "--cohort 0" "--cohort -3" "--cohort 26" "--timeout 0" "--timeout abc" "--seed x" "--seed 12\",\"z" "--condition bogus" "--condition idle\",\"x"; do
  # shellcheck disable=SC2086
  [ "$(run $a)" = 64 ] && ok "invalid: $a -> 64" || bad "invalid: $a"
done
[ "$(run --cohort)" = 64 ] && ok "missing operand -> 64" || bad "missing operand"

# --- output overflow: both streams capped at 64 KiB ---
( cd "$t" && STUB_OUT_BYTES=200000 STUB_ERR_BYTES=200000 STUB_RC=1 "$t/w" --out "$t/receipt" --cohort 1 --advisory >"$t/big.out" 2>"$t/big.err" )
[ "$(wc -c < "$t/big.out")" -le 65536 ] && ok "stdout capped" || bad "stdout capped"
[ "$(wc -c < "$t/big.err")" -le 65536 ] && ok "stderr capped" || bad "stderr capped"

# --- receipt: valid JSON, honest exit field ---
( cd "$t" && STUB_RC=3 "$t/w" --out "$t/receipt" --cohort 1 >/dev/null 2>&1 )
python3 - "$t/receipt" <<'EOF' && ok "receipt JSON + honest rc" || bad "receipt JSON + honest rc"
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert rows[-1]["exit"]==3 and rows[-1]["cohort"]==1, rows[-1]
EOF

echo "---"; [ "$fails" = 0 ] && echo "ALL PASS" || echo "$fails FAILURES"; exit "$fails"
