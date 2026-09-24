{
  description = "E2E browser wallet extension and local coordinator";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      package = pkgs: pkgs.buildNpmPackage {
        pname = "e2e-wallet";
        version = "1.0.0";
        src = ./.;
        npmDepsHash = "sha256-s3eLTM8nOGn2dFZgOga/Ba71BmZHW7DuztA7bHEtgY8=";
        nodejs = pkgs.nodejs_24;
        nativeBuildInputs = [ pkgs.makeWrapper ];
        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin $out/libexec/e2e-wallet $out/share/e2e-wallet
          cp dist/coordinator.mjs $out/libexec/e2e-wallet/
          cp -r dist/extension $out/share/e2e-wallet/
          makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/e2e-wallet-coordinator \
            --add-flags $out/libexec/e2e-wallet/coordinator.mjs
          makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/e2e-wallet-import \
            --add-flags "$out/libexec/e2e-wallet/coordinator.mjs import"
          runHook postInstall
        '';
      };
    in {
      packages = forAllSystems (system:
        let wallet = package nixpkgs.legacyPackages.${system};
        in {
          default = wallet;
          e2e-wallet = wallet;
        });
    };
}
