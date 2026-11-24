import { UserError } from "../user-error";
import { promises as fs } from "node:fs";
import path from "node:path";
export interface PluginManager {
  disablePlugin(id: string): Promise<unknown>;
  enablePlugin(id: string): Promise<unknown>;
  manifests: Record<string, unknown>;
  plugins: Record<
    string,
    {
      manifest: { version: string; dir?: string; [key: string]: unknown };
      _loaded?: boolean;
    }
  >;
}
/** 同一回调也用于回滚重载：每次以磁盘当前 manifest 为期望，不沿用新版缓存。 */
export async function reloadAndVerify(
  manager: PluginManager,
  id: string,
  dir: string,
): Promise<void> {
  const expected = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  );
  if (expected.id !== id || typeof expected.version !== "string")
    throw new UserError("待加载插件身份无效");
  // dir 等宿主归属字段不在磁盘 manifest 中；必须在 disable 清理实例前保存。
  // 回滚再次调用时仍从当前缓存/实例恢复这些字段，不能退回 vault/undefined/main.js。
  const runtime = {
    ...(manager.manifests[id] as Record<string, unknown> | undefined),
    ...manager.plugins[id]?.manifest,
  };
  if (typeof runtime.dir !== "string" || !runtime.dir)
    throw new UserError("无法定位当前插件目录，已取消自动重载");
  const next = { ...runtime, ...expected, dir: runtime.dir };
  await manager.disablePlugin(id);
  manager.manifests[id] = next;
  const enabled = await manager.enablePlugin(id);
  const loaded = manager.plugins[id];
  if (
    enabled === false ||
    !loaded ||
    loaded._loaded === false ||
    loaded.manifest.version !== expected.version ||
    loaded.manifest.dir !== runtime.dir
  )
    throw new UserError("Obsidian 未加载目标插件版本");
}
