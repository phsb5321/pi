#!/usr/bin/env bash
# fleet-wrapper.sh — MS-25 identity-disciplined launcher for the shared install.
#
# Behavior-neutral by construction: argv semantics match the deployed pi.nix
# exec line (`exec -a pi node [--import=bridge] dist/cli.js "$@"`), where the
# nix side passes its wrapper-only args (e.g. --import=<bridge>) via
# PI_FLEET_NODE_ARGS. The wrapper adds exactly two things:
#
#   1. fail-closed identity: the launch refuses a bundle whose version or
#      dist/cli.js does not match packaging/fleet/fleet-pin.json;
#   2. explicit cohort identity env (see COHORT CONTRACT in
#      docs/fleet-packaging.md) so memory probes can group seats by install.
#
# `exec -a pi` is load-bearing: argv[0]=pi is ananicy-cpp's scheduler identity.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${PI_FLEET_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-fleet}"

die() { echo "fleet-wrapper: $*" >&2; exit 70; }

json_get() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}[,}]\{0,1\}.*/\1/p' "$1" | head -n1; }

[ -e "$ROOT/current" ] || die "no shared install at $ROOT/current (run fleet-install.sh install)"
INSTALL="$(readlink -f "$ROOT/current")"
[ -f "$INSTALL/dist/cli.js" ] || die "install has no dist/cli.js: $INSTALL"
# Self-describing install: verify against the pin recorded AT INSTALL TIME
# (fleet-install.sh copies it in), so `current` can flip to any verified
# install — including the rollback pre-pin — without a wrapper change.
PIN_FILE="$INSTALL/.fleet-pin.json"
[ -f "$PIN_FILE" ] || die "install is not self-describing (no .fleet-pin.json): $INSTALL"

want_v="$(json_get "$PIN_FILE" version)"
got_v="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$INSTALL/package.json" | head -n1)"
[ "$got_v" = "$want_v" ] || die "install version $got_v != pin $want_v"

# Fast path: entry-point hash only. Full manifest verification happens at
# install time (fleet-install.sh). Ceiling: a corrupted non-entry file is
# caught at the next install/verify, not at launch. Upgrade path: cache the
# manifest digest beside the install and compare cheaply here.
want_cli="$(json_get "$PIN_FILE" dist_cli_sha512)"
got_cli="$(sha512sum "$INSTALL/dist/cli.js" | cut -d' ' -f1)"
[ "$got_cli" = "$want_cli" ] || die "dist/cli.js does not match pin"

# --- cohort identity (COHORT CONTRACT, docs/fleet-packaging.md) -------------
# PI_FLEET_PIN derivation matches the nix-side wrapper (modules/home/pi.nix,
# ms-25-fleet-wiring): <version>+<sha512(dist/cli.js)[0:8]>. The install dir
# carries the full manifest id (<version>-<manifest8>) via PI_FLEET_INSTALL.
cli8="$(printf '%s' "$got_cli" | cut -c1-8)"
PI_FLEET_PIN="$want_v+$cli8"
PI_FLEET_INSTALL="$INSTALL"
PI_FLEET_WRAPPER_REV="$(json_get "$PIN_FILE" wrapper_rev)"
PI_FLEET_NODE_FLAGS="${PI_FLEET_NODE_FLAGS:-$(json_get "$PIN_FILE" node_flags)}"
# compat: pi's extension bridge discovers the runtime package root from this
PI_CODING_AGENT_RUNTIME_ROOT="$INSTALL"
export PI_FLEET_PIN PI_FLEET_INSTALL PI_FLEET_WRAPPER_REV PI_FLEET_NODE_FLAGS \
  PI_CODING_AGENT_RUNTIME_ROOT

exec -a pi "${PI_FLEET_NODE:-node}" ${PI_FLEET_NODE_ARGS:-} \
  ${PI_FLEET_NODE_FLAGS:+$PI_FLEET_NODE_FLAGS} \
  "$INSTALL/dist/cli.js" "$@"
