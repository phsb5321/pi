{
  autoPatchelfHook,
  esbuild,
  fd,
  fetchurl,
  importNpmLock,
  lib,
  libxcb,
  makeWrapper,
  nodejs_22,
  ripgrep,
  source,
  stdenv,
  wl-clipboard,
  xclip,
}:

let
  nodejs = nodejs_22;
  packageJson = lib.importJSON (source + "/packages/coding-agent/package.json");
  # Lockfile root used by the pi.dev installer. It pins the coding agent's
  # runtime dependency tree and is kept in sync with package-lock.json by
  # `npm run check`.
  installLock = source + "/packages/coding-agent/install-lock";
  modelCatalogPin = lib.importJSON ./model-catalog.json;
  modelCatalog = fetchurl {
    name = "pi-model-catalog.json";
    # The typed catalog is the representation whose bytes the revision hashes.
    url = "https://pi.dev/api/models/revisions/${modelCatalogPin.revision}?types=chat,image,classifier";
    sha256 = lib.removePrefix "sha256-" modelCatalogPin.revision;
  };

  workspacePackages = stdenv.mkDerivation {
    pname = "pi-workspace-packages";
    inherit (packageJson) version;
    src = source;

    npmDeps = importNpmLock { npmRoot = source; };
    npmRebuildFlags = [ "--ignore-scripts" ];

    nativeBuildInputs = [
      nodejs
      importNpmLock.npmConfigHook
    ];

    buildPhase = ''
      runHook preBuild
      node packages/ai/scripts/hydrate-model-catalog.ts ${modelCatalog}
      npm run build:offline
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      pack_package() {
        local package_dir="$1"
        local output_name="$2"
        local tarball

        tarball="$(cd "$package_dir" && npm pack --ignore-scripts --silent --pack-destination "$TMPDIR")"
        mv "$TMPDIR/$tarball" "$out/$output_name.tgz"
      }

      mkdir -p "$out"
      pack_package packages/telemetry telemetry
      pack_package packages/ai ai
      pack_package packages/tui tui
      pack_package packages/agent agent
      pack_package packages/codemode codemode
      pack_package packages/mcp mcp
      pack_package packages/coding-agent coding-agent

      runHook postInstall
    '';
  };

  npmDeps = importNpmLock {
    npmRoot = installLock;
    # The install lock points internal packages at registry releases. Replace
    # them with the packages built from this checkout.
    packageSourceOverrides = {
      "node_modules/@earendil-works/pi-agent-core" = workspacePackages + "/agent.tgz";
      "node_modules/@earendil-works/pi-ai" = workspacePackages + "/ai.tgz";
      "node_modules/@earendil-works/pi-codemode" = workspacePackages + "/codemode.tgz";
      "node_modules/@earendil-works/pi-coding-agent" = workspacePackages + "/coding-agent.tgz";
      "node_modules/@earendil-works/pi-mcp" = workspacePackages + "/mcp.tgz";
      "node_modules/@earendil-works/pi-telemetry" = workspacePackages + "/telemetry.tgz";
      "node_modules/@earendil-works/pi-tui" = workspacePackages + "/tui.tgz";
    };
  };
in
stdenv.mkDerivation {
  pname = "pi";
  inherit (packageJson) version;
  src = installLock;
  inherit npmDeps;

  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeWrapper
    esbuild
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = [ nodejs ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    libxcb
  ];

  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    cp -R . "$out/lib/pi"

    # V8 keeps the full source text of every loaded module on the JS heap for
    # lazy compilation. Comments, indentation and non-Latin-1 characters (which
    # turn a whole source string into two-byte) are pure cost there. Measured on
    # the 1.4.0 fleet layout, 5 x 301 s per arm: heap -4.6 MiB, median per-pi
    # PSS+swap -10.3 MiB, CPU and startup unchanged. Whitespace/syntax/ASCII
    # escaping only: identifiers, module format and behaviour are untouched.
    # A file esbuild rejects keeps its original text. PI_SKIP_MINIFY=1 is for
    # builds that need readable stack columns.
    if [ -z "''${PI_SKIP_MINIFY:-}" ]; then
      find "$out/lib/pi/node_modules" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
        -not -name '*.min.*' -print0 |
        xargs -0 -P "$NIX_BUILD_CORES" -n 20 sh -c '
          for f in "$@"; do
            [ "$(head -c 2 "$f")" = "#!" ] && continue
            tmp="$f.min.tmp"
            if esbuild --minify-whitespace --minify-syntax --charset=ascii --legal-comments=none \
                 --target=node22 --log-level=error "$f" --outfile="$tmp" 2>/dev/null; then
              chmod --reference="$f" "$tmp"; mv -f "$tmp" "$f"
            else
              rm -f "$tmp"
            fi
          done' sh
    fi

    # The wrapper runs Pi with an absolute Node path. Node is only on PATH so Pi can
    # find npm for package installs; append it so that shells started by the
    # bash tool keep the user's node/npm (e.g. from mise or nvm). fd, ripgrep,
    # and the clipboard tools are Pi's own dependencies and take precedence.
    makeWrapper ${nodejs}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
      --suffix PATH : ${lib.makeBinPath [ nodejs ]} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            fd
            ripgrep
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [
            wl-clipboard
            xclip
          ]
        )
      }

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$("$out/bin/pi" --version)" = "${packageJson.version}"
    # Load host-platform TUI helpers directly so missing native dependencies
    # fail the build rather than silently disabling clipboard support.
    ${nodejs}/bin/node -e \
      "const fs = require('node:fs');
       const path = require('node:path');
       const dir = '$out/lib/pi/node_modules/@earendil-works/pi-tui/native/' + process.platform + '/prebuilds/' + process.platform + '-' + process.arch;
       if (fs.existsSync(dir)) {
         for (const file of fs.readdirSync(dir)) {
           if (file.endsWith('.node')) require(path.join(dir, file));
         }
       }"
    ${nodejs}/bin/node -e \
      "require('$out/lib/pi/node_modules/@silvia-odwyer/photon-node')"
    # The minified install must still load extensions, report their errors and
    # name the throwing function in stack frames (line:column then refer to the
    # minified file).
    ${nodejs}/bin/node ${source}/scripts/smoke-installed-js.mjs "$out/lib/pi" "$out/bin/pi"
    runHook postInstallCheck
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://pi.dev";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
}
