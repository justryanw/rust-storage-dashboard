{
  description = "Rust+ dashboard — storage, switches, and live map";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (system: rec {
        rust-plus-dashboard = (pkgsFor system).callPackage ./nix/package.nix { };
        default = rust-plus-dashboard;
      });

      nixosModules = rec {
        rust-plus-dashboard = { pkgs, ... }@args: {
          imports = [ ./nix/module.nix ];
          nixpkgs.overlays = [
            (_: _: { rust-plus-dashboard = self.packages.${pkgs.system}.default; })
          ];
        };
        default = rust-plus-dashboard;
      };

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs pkgs.nodePackages.npm ];
          };
        });
    };
}
