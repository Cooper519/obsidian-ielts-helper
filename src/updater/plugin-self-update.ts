import { UserError } from "../user-error";
import * as fs from "node:fs/promises";
import * as p from "node:path";
import {
  pluginFiles,
  stable,
  updateLog,
  type FeedManifest,
  type SourceConfig,
  type PluginFile,
} from "./types";
import { download, providerAccess, vpsAccess } from "./network";

const busy = new Set<string>();
/** 先在同盘备齐、校验三文件。宿主只能在三件全部替换后重载；重载失败时恢复旧版。 */
export async function updatePlugin(
  s: SourceConfig,
  release: FeedManifest["plugin"],
  pluginDir: string,
  reload: () => Promise<void>,
) {
  if (s.mode === "local") throw new UserError("仅本地模式不下载插件更新");
  if (!stable.test(release.version)) throw new UserError("不是稳定插件版本");
  const root = await fs.realpath(pluginDir);
  if (busy.has(root)) throw new UserError("插件正在更新");
  busy.add(root);
  let stage: string | undefined,
    retain = false;
  try {
    stage = await fs.mkdtemp(p.join(root, ".ielts-self-"));
    const backup = p.join(stage, "before");
    await fs.mkdir(backup);
    const access =
      s.mode === "vps"
        ? vpsAccess(s)
        : await providerAccess(s, "github", false);
    for (const name of pluginFiles) {
      const old = p.join(root, name);
      if (!(await fs.lstat(old)).isFile())
        throw new UserError("原插件文件不是普通文件");
      await download(release.assets[name], access, p.join(stage, name));
    }
    const manifest = JSON.parse(
      await fs.readFile(p.join(stage, "manifest.json"), "utf8"),
    );
    const oldManifest = JSON.parse(
      await fs.readFile(p.join(root, "manifest.json"), "utf8"),
    );
    if (
      manifest.id !== oldManifest.id ||
      manifest.id !== "ielts-helper" ||
      manifest.version !== release.version
    )
      throw new UserError("新插件身份或版本不符");
    for (const name of pluginFiles)
      await fs.copyFile(
        p.join(root, name),
        p.join(backup, name),
        fs.constants.COPYFILE_EXCL,
      );
    const changed: PluginFile[] = [];
    let reloading = false;
    try {
      for (const name of pluginFiles) {
        await fs.rename(p.join(stage, name), p.join(root, name));
        changed.push(name);
      }
      reloading = true;
      await reload();
      updateLog("插件三文件已更新并重载");
    } catch (e) {
      try {
        for (const name of changed.reverse())
          await fs.rename(p.join(backup, name), p.join(root, name));
      } catch {
        retain = true;
        throw new UserError(`插件恢复失败；请从 ${backup} 恢复原三文件`);
      }
      if (reloading) {
        try {
          await reload();
        } catch {
          throw new UserError("原插件文件已恢复；请手动重开 Obsidian");
        }
      }
      throw e;
    }
  } finally {
    busy.delete(root);
    if (stage && !retain) await fs.rm(stage, { recursive: true, force: true });
  }
}
