{
  lib,
  buildNpmPackage,
  nodejs,
  makeWrapper,
}:

buildNpmPackage {
  pname = "rust-plus-dashboard";
  version = "1.0.0";

  src = lib.cleanSource ../.;

  npmDepsHash = "sha256-ryd55aXHQlW9XwlRwL3z7xhAqLIhGYFRpgM10Vndvag=";

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/rust-plus-dashboard $out/bin

    cp -r . $out/lib/rust-plus-dashboard/

    # Patch itemIsBlueprint to optional — Rust+ doesn't always include it
    sed -i 's/required bool itemIsBlueprint/optional bool itemIsBlueprint/g' \
      $out/lib/rust-plus-dashboard/node_modules/@liamcottle/rustplus.js/rustplus.proto

    makeWrapper ${lib.getExe nodejs} $out/bin/rust-plus-dashboard \
      --add-flags "$out/lib/rust-plus-dashboard/server.js"

    runHook postInstall
  '';

  meta = {
    description = "Rust+ dashboard — storage, switches, and live map";
    license = lib.licenses.mit;
    mainProgram = "rust-plus-dashboard";
    platforms = lib.platforms.linux;
  };
}
