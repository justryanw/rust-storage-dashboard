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

    # Relax `required` fields and add the Note icon/colour/label fields that
    # newer Rust+ emits but the bundled proto lacks. Mirrors server.js.
    proto=$out/lib/rust-plus-dashboard/node_modules/@liamcottle/rustplus.js/rustplus.proto
    sed -i 's/\brequired\b/optional/g' "$proto"
    sed -i '/^\t\toptional float y = 4;$/a\
\t\toptional int32 icon = 5;\
\t\toptional int32 colourIndex = 6;\
\t\toptional string label = 7;' "$proto"

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
