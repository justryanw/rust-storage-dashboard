{ config, lib, pkgs, ... }:

let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    mkPackageOption
    types
    ;

  cfg = config.services.rust-storage-dashboard;
in
{
  options.services.rust-storage-dashboard = {
    enable = mkEnableOption "Rust+ storage monitor dashboard";

    package = mkPackageOption pkgs "rust-storage-dashboard" { };

    port = mkOption {
      type = types.port;
      default = 3000;
      description = "Port the dashboard HTTP server listens on.";
    };

    dataDir = mkOption {
      type = types.path;
      default = "/var/lib/rust-storage-dashboard";
      description = "Directory used for persistent state (config.json).";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the firewall for the dashboard port.";
    };
  };

  config = mkIf cfg.enable {
    systemd.services.rust-storage-dashboard = {
      description = "Rust+ Storage Dashboard";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        PORT = toString cfg.port;
        RUST_STORAGE_DASHBOARD_DATA_DIR = cfg.dataDir;
        NODE_ENV = "production";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        WorkingDirectory = cfg.dataDir;

        # State
        StateDirectory = "rust-storage-dashboard";
        StateDirectoryMode = "0750";

        # Identity
        DynamicUser = true;
        User = "rust-storage-dashboard";
        Group = "rust-storage-dashboard";

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
        MemoryDenyWriteExecute = true;
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
