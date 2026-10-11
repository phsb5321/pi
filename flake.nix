{
  description = "Pi coding agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable no longer supports Intel macOS. Keep using the final
    # Darwin branch that does so for pi's x86_64-darwin package.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin-x64,
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs;
      packageFor =
        system:
        let
          pkgs = import (nixpkgsFor system) { inherit system; };
        in
        pkgs.callPackage ./nix/package.nix { source = self; };

      # The directory shape packaging/fleet/fleet-install.sh consumes
      # (package.json + dist/ + install-lock/ + node_modules), assembled from
      # the Nix build instead of from a host `npm run build`. That is what makes
      # the deploy reproducible and cacheable:
      #
      #   nix build .#fleet-source
      #   packaging/fleet/fleet-install.sh install --source result
      #
      # or, in one step, `nix run .#install`.
      fleetSourceFor =
        system:
        let
          pkgs = import (nixpkgsFor system) { inherit system; };
          pi = packageFor system;
        in
        pkgs.runCommand "pi-fleet-source-${pi.version}" { } ''
          set -euo pipefail
          # The pi output is the install-lock closure (node_modules + the
          # installer package.json); the coding-agent dist and its own
          # package.json live one level down in node_modules.
          ca=${pi}/lib/pi/node_modules/@earendil-works/pi-coding-agent
          mkdir -p "$out"

          cp -a "$ca/dist" "$out/dist"
          cp -a "$ca/package.json" "$out/package.json"
          for f in docs examples CHANGELOG.md containerization.md; do
            [ -e "$ca/$f" ] && cp -a "$ca/$f" "$out/$f"
          done

          # install-lock/ is not carried into the pi output, so it comes from
          # the flake source. fleet-install's install_lock_digest hashes it, and
          # the tree it describes must travel with the bundle.
          cp -a ${./packages/coding-agent/install-lock} "$out/install-lock"
          chmod -R u+w "$out/install-lock"
          cp -a ${pi}/lib/pi/node_modules "$out/node_modules"
          # The store copies arrive read-only; the swap below must be writable.
          chmod -R u+w "$out/node_modules"

          # The nested copy must be the build made here, not whatever the
          # install lock resolved from the registry — that is the whole point.
          rm -rf "$out/node_modules/@earendil-works/pi-coding-agent"
          mkdir -p "$out/node_modules/@earendil-works/pi-coding-agent"
          cp -a "$ca/dist" "$out/node_modules/@earendil-works/pi-coding-agent/dist"
          cp -a "$ca/package.json" "$out/node_modules/@earendil-works/pi-coding-agent/package.json"
        '';
    in
    {
      packages = forAllSystems (system: {
        default = packageFor system;
        pi = packageFor system;
        fleet-source = fleetSourceFor system;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/pi";
          meta.description = "Pi coding agent";
        };
        pi = self.apps.${system}.default;

        # `nix run .#install` builds the Chord-capable bundle and installs it
        # into the fleet root, flipping `current` atomically. Rollback is the
        # symlink flip fleet-install.sh prints.
        install = {
          type = "app";
          program = "${
            (import (nixpkgsFor system) { inherit system; }).writeShellApplication {
              name = "pi-fleet-install";
              runtimeInputs = [ (import (nixpkgsFor system) { inherit system; }).coreutils ];
              text = ''
                exec ${self}/packaging/fleet/fleet-install.sh \
                  install --source ${fleetSourceFor system} "$@"
              '';
            }
          }/bin/pi-fleet-install";
          meta.description = "Build the Chord-capable pi and install it into the fleet root";
        };
      });

      overlays.default = final: _previous: {
        pi = final.callPackage ./nix/package.nix { source = self; };
      };

      # A NixOS/Home-Manager module so a host can take the Chord-capable build
      # declaratively. It only ADDS the package and the stable binary path; the
      # fleet launcher keeps deciding which build a pane runs.
      nixosModules.default = { config, pkgs, lib, ... }: {
        options.programs.pi-chord.enable = lib.mkEnableOption "the home-grown pi build with the experimental Chord layer";
        config = lib.mkIf config.programs.pi-chord.enable {
          nixpkgs.overlays = [ self.overlays.default ];
          environment.systemPackages = [ pkgs.pi ];
        };
      };
    };
}
