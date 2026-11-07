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
        pkgs.callPackage ./nix/package.nix {
          # A measured pin describes these bytes; it must not feed back into them.
          source = pkgs.lib.cleanSourceWith {
            src = self;
            filter = path: _type:
              !(pkgs.lib.hasPrefix "${self}/packaging/fleet/fleet-pin." path
                && pkgs.lib.hasSuffix ".json" path);
          };
        };
    in
    {
      packages = forAllSystems (system: {
        default = packageFor system;
        pi = packageFor system;
        fleet-source = (import (nixpkgsFor system) { inherit system; }).callPackage ./nix/fleet-source.nix {
          pi = packageFor system;
        };
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/pi";
          meta.description = "Pi coding agent";
        };
        pi = self.apps.${system}.default;
      });

      overlays.default = final: _previous: {
        pi = final.callPackage ./nix/package.nix { source = self; };
      };
    };
}
