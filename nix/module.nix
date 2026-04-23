{ config, lib, pkgs, ... }:

let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    mkPackageOption
    types
    ;

  cfg = config.services.rust-plus-dashboard;
in
{
  options.services.rust-plus-dashboard = {
    enable = mkEnableOption "Rust+ Dashboard";

    package = mkPackageOption pkgs "rust-plus-dashboard" { };

    port = mkOption {
      type = types.port;
      default = 7867;
      description = "Port the dashboard HTTP server listens on.";
    };

    dataDir = mkOption {
      type = types.path;
      default = "/var/lib/rust-plus-dashboard";
      description = "Directory used for persistent state (config.json).";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the firewall for the dashboard port.";
    };
  };

  config = mkIf cfg.enable {
    systemd.services.rust-plus-dashboard = {
      description = "Rust+ Dashboard";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        PORT = toString cfg.port;
        RUST_PLUS_DASHBOARD_DATA_DIR = cfg.dataDir;
        NODE_ENV = "production";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        WorkingDirectory = cfg.dataDir;

        # State
        StateDirectory = "rust-plus-dashboard";
        StateDirectoryMode = "0750";

        # Identity
        DynamicUser = true;
        User = "rust-plus-dashboard";
        Group = "rust-plus-dashboard";

        # Restart
        Restart = "on-failure";
        RestartSec = "5s";

        # Hardening
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectHostname = true;
        ProtectClock = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        RestrictNamespaces = true;
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" "~@privileged" "~@resources" ];
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
  };
}
