{ runCommand, pi }:

# Preserve the complete native install closure: the nested coding-agent package
# alone resolves dependencies from its parent node_modules and is not a bundle.
runCommand "pi-fleet-source-${pi.version}" { } ''
  set -euo pipefail
  ca=${pi}/lib/pi/node_modules/@earendil-works/pi-coding-agent
  mkdir -p "$out"
  cp -a "$ca/dist" "$ca/package.json" "$out/"
  for asset in docs examples CHANGELOG.md containerization.md; do
    if [ -e "$ca/$asset" ]; then
      cp -a "$ca/$asset" "$out/$asset"
    fi
  done
  cp -a ${pi.src} "$out/install-lock"
  cp -a ${pi}/lib/pi/node_modules "$out/node_modules"
''
