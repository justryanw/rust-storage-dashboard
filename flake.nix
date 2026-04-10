{
  description = "Rust+ storage monitor combined inventory dashboard";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (system: rec {
        rust-storage-dashboard = (pkgsFor system).callPackage ./nix/package.nix { };
        default = rust-storage-dashboard;
      });

      nixosModules = rec {
        rust-storage-dashboard = { pkgs, ... }@args: {
          imports = [ ./nix/module.nix ];
          nixpkgs.overlays = [
            (_: _: { rust-storage-dashboard = self.packages.${pkgs.system}.default; })
          ];
        };
        default = rust-storage-dashboard;
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
