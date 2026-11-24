import type { SourceConfig } from "./updater";
/** 本机配置字段与 spec 3.3 保持一致，凭据仅由 MachineConfig 保存到 Vault 外。 */
export interface MachineProfile {
  vaultRoot: string;
  studyRoot: string;
  appRoot: string;
  dataDir: string;
  pythonPath: string;
  port: number;
  openBrowserOnStart: boolean;
  autoUpgradePlugin: boolean;
  autoCheckUpdates?: boolean;
  updateSource: SourceConfig;
}
export interface ServiceVersion {
  version: string;
  minPluginVersion?: string;
  recommendedPluginVersion?: string;
  pluginUpgradeRequired?: boolean;
  pluginUpgradeRecommended?: boolean;
  serviceIdentity?: {
    instanceId: string | null;
    pid: number;
    processStartedAt?: string;
    port: number;
    dataRoot: string;
    vaultRoot: string;
  };
}
