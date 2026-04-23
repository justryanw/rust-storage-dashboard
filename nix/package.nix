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

  npmDepsHash = "sha256-WHwrAg/2LVMpTah1W1K2oC2QRa8nKIeN86RA1O+Fvk4=";

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/rust-plus-dashboard $out/bin

    cp -r . $out/lib/rust-plus-dashboard/

    # Relax `required` fields and add the Note icon/colour/label fields that
    # newer Rust+ emits but the bundled proto lacks. Mirrors server.js.
    # The Note insertion is range-limited to the Note message — both Member
    # and Note share `optional float y = 4;` so a global match would also
    # clobber Member's isOnline=5 with a duplicate icon=5.
    proto=$out/lib/rust-plus-dashboard/node_modules/@liamcottle/rustplus.js/rustplus.proto
    sed -i 's/\brequired\b/optional/g' "$proto"
    grep -q colourIndex "$proto" || sed -i '/message Note {/,/^\t}/{
      s|^\t\toptional float y = 4;$|&\n\t\toptional int32 icon = 5;\n\t\toptional int32 colourIndex = 6;\n\t\toptional string label = 7;|
    }' "$proto"

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
