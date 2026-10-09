#!/usr/bin/env bash
# fleet-install.sh — MS-25 fleet packaging: ONE shared, bit-pinned pi install.
#
# Materializes an immutable shared install from a pinned prebuilt bundle and
# switches the `current` symlink atomically. Verification is fail-closed: the
# source must match every hash in packaging/fleet/fleet-pin.json or nothing is
# installed. U1 fork wiring — behavior-neutral; the launcher contract lives in
# fleet-wrapper.sh and the rollout path (pi.nix consuming this) is MS-31.
#
# Usage:
#   fleet-install.sh install --source DIR [--root DIR] [--force]
#   fleet-install.sh verify --source DIR             # fail-closed check vs the pin
#   fleet-install.sh compute --source DIR            # print pin JSON for a source
#
#   --source  an unpacked @earendil-works/pi-coding-agent package directory
#             (e.g. a warm npx-cache copy or an extracted npm tarball)
#   --root    shared install root (default: ${XDG_DATA_HOME:-~/.local/share}/pi-fleet)
#
# Layout:  <root>/<version>-<manifest8>/   immutable install (a-w)
#          <root>/current -> <version>-<manifest8>   atomic symlink switch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_FILE="$SCRIPT_DIR/fleet-pin.json"

die() { echo "fleet-install: $*" >&2; exit 1; }

json_get() { # json_get <file> <key>  — flat string/number values only
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}[,}]\{0,1\}.*/\1/p' "$1" | head -n1
}

# manifest_lines <src> — canonical bundle listing: "relpath<TAB>sha512" lines,
# globally sorted (LC_ALL=C). The pin's bundle_manifest_sha512 is sha512 over
# this listing joined by \n (no trailing newline).
manifest_lines() {
  ( cd "$1" && find dist -type f -print0 \
      | LC_ALL=C sort -z | xargs -0 -P 8 -n 16 sha512sum ) \
    | awk '{h=$1; $1=""; sub(/^  /,""); print $0 "\t" h}' | LC_ALL=C sort
}

manifest_digest() {
  local listing; listing="$(manifest_lines "$1")"
  printf '%s' "$listing" | sha512sum | cut -d' ' -f1
}

# install_lock_digest <src> — upstream v1.1.0 replaced npm-shrinkwrap.json with
# the checked-in install-lock/ dir (package.json + package-lock.json for the
# install unit). Same canonical listing discipline as manifest_lines.
install_lock_digest() {
  ( cd "$1/install-lock" && find . -type f -print0 \
      | LC_ALL=C sort -z | xargs -0 -P 8 -n 16 sha512sum ) \
    | sha512sum | cut -d' ' -f1
}

file_sha() { sha512sum "$1" | cut -d' ' -f1; }

verify_source() { # verify_source <src> <pin> — full-pin check of a bundle dir
  local src="$1" pin="$2"
  [ -f "$src/package.json" ] || die "no package.json in $src"
  [ -d "$src/install-lock" ] || die "no install-lock/ in $src (upstream v1.1.0 replaced npm-shrinkwrap.json)"
  [ -f "$src/dist/cli.js" ] || die "no dist/cli.js in $src"

  local got want
  got="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$src/package.json" | head -n1)"
  want="$(json_get "$pin" version)"
  [ "$got" = "$want" ] || die "version drift: source $got != pin $want"

  got="$(file_sha "$src/package.json")"
  want="$(json_get "$pin" package_json_sha512)"
  [ "$got" = "$want" ] || die "package.json hash mismatch"

  got="$(install_lock_digest "$src")"
  want="$(json_get "$pin" install_lock_sha512)"
  [ "$got" = "$want" ] || die "install-lock digest mismatch (dependency tree not the pinned one)"

  got="$(file_sha "$src/dist/cli.js")"
  want="$(json_get "$pin" dist_cli_sha512)"
  [ "$got" = "$want" ] || die "dist/cli.js hash mismatch"

  got="$(manifest_digest "$src")"
  want="$(json_get "$pin" bundle_manifest_sha512)"
  [ "$got" = "$want" ] || die "bundle manifest mismatch"
  echo "fleet-install: source verified against $(basename "$pin")"
}

cmd_compute() {
  local src="$1"
  [ -d "$src/dist" ] || die "no dist/ in $src"
  local version m8 pj sw cli
  version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$src/package.json" | head -n1)"
  pj="$(file_sha "$src/package.json")"
  sw="$(install_lock_digest "$src")"
  cli="$(file_sha "$src/dist/cli.js")"
  local manifest; manifest="$(manifest_digest "$src")"
  m8="${manifest:0:8}"
  cat <<EOF
{
  "schema": 1,
  "package": "@earendil-works/pi-coding-agent",
  "version": "$version",
  "bundle_manifest_sha512": "$manifest",
  "bundle_manifest_short": "$m8",
  "package_json_sha512": "$pj",
  "install_lock_sha512": "$sw",
  "dist_cli_sha512": "$cli",
  "node_flags": "",
  "wrapper_rev": 1
}
EOF
}

cmd_install() {
  local src="" root="${XDG_DATA_HOME:-$HOME/.local/share}/pi-fleet" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) src="$2"; shift 2 ;;
      --root) root="$2"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [ -n "$src" ] || die "--source required"
  [ -d "$src" ] || die "source not a directory: $src"

  verify_source "$src" "$PIN_FILE"

  local version manifest id target
  version="$(json_get "$PIN_FILE" version)"
  manifest="$(json_get "$PIN_FILE" bundle_manifest_sha512)"
  id="$version-${manifest:0:8}"
  target="$root/$id"

  if [ -d "$target" ] && [ "$force" = 0 ]; then
    echo "fleet-install: $target already installed; switching current"
  else
    rm -rf "$target.tmp"
    mkdir -p "$root" "$target.tmp"
    cp -a "$src/." "$target.tmp/"
    # Self-describing install: the verified pin travels with the install so
    # fleet-wrapper.sh can verify + identify ANY installed pin. This is what
    # makes the MS-30 rollback flip (current -> pre-pin) mechanically sound.
    cp "$PIN_FILE" "$target.tmp/.fleet-pin.json"
    rm -rf "$target"
    mv "$target.tmp" "$target"
    chmod -R a-w "$target"
  fi

  ln -sfn "$id" "$root/.current.tmp"
  mv -Tf "$root/.current.tmp" "$root/current"
  echo "fleet-install: current -> $id"
  echo "fleet-install: PI_FLEET_INSTALL=$root/current"
}

case "${1:-}" in
  compute) shift; [ "${1:-}" = "--source" ] && shift; cmd_compute "${1:?--source dir}" ;;
  verify) shift; [ "${1:-}" = "--source" ] && shift; verify_source "${1:?--source dir}" "$PIN_FILE" ;;
  install) shift; cmd_install "$@" ;;
  *) die "usage: fleet-install.sh {compute|verify|install} --source DIR" ;;
esac
