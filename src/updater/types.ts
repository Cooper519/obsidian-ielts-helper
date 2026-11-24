import { UserError } from "../user-error";
/** 清单与本机状态的公共契约；密钥不进入清单、进度或错误对象。 */
export type Provider = "github" | "gitee";
export interface SourceConfig {
  mode: Provider | "vps" | "local";
  vpsUrl?: string;
  vpsToken?: string;
  pluginRepo?: string;
  githubRepo?: string;
  giteeRepo?: string;
  githubToken?: string;
  giteeToken?: string;
  fallbackProvider?: string;
}
export const pluginFiles = ["main.js", "manifest.json", "styles.css"] as const;
export type PluginFile = (typeof pluginFiles)[number];
export interface Asset {
  url: string;
  size: number;
  sha256: string;
}
export interface Release {
  version: string;
  tag: string;
  publishedAt: string;
  notes: string;
}
export interface FeedManifest {
  schema: 1;
  generatedAt: string;
  source: string;
  plugin: Release & { assets: Record<PluginFile, Asset> };
  helper: Release & {
    minPluginVersion: string;
    recommendedPluginVersion: string;
    asset: Asset & { filename: string };
  };
  resources: Release & {
    audioMode: string;
    asset: Asset & { filename: string };
  };
}
export type PackageFeed = Omit<FeedManifest, "plugin">;
export interface UpdatePaths {
  appRoot: string;
  dataDir: string;
  vaultRoot: string;
}
export interface ServiceHooks {
  state(): Promise<"owned" | "external" | "stopped">;
  stop(): Promise<void>;
  start(): Promise<void>;
}
export type Kind = "helper" | "resources";
export interface PackageInput {
  kind: Kind;
  /** 仅本地迁移入口使用；线上独立程序包始终只允许 terminal/。 */
  format?: "bundle" | "legacy-program";
  version: string;
  file: string;
  sha256: string;
}
export interface Installed {
  version?: string;
  previousVersion?: string;
  resourcesVersion?: string;
  updatedAt?: string;
}
export const stable = /^\d+\.\d+\.\d+$/;
export function compareVersions(a: string, b: string): number {
  if (!stable.test(a) || !stable.test(b))
    throw new UserError("需要稳定版本号 x.y.z");
  const x = a.split(".").map(BigInt),
    y = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function archiveName(kind: Kind, version: string): string {
  return `ielts-helper-${kind === "resources" ? "resources-" : ""}${version}.zip`;
}
export function updateLog(event: string) {
  console.info(`[${new Date().toISOString()}] IELTS 更新：${event}`);
}
