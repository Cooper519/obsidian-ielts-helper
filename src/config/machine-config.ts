import { UserError } from "../user-error";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { MachineProfile } from "../types";

export function assertIsolatedPath(file: string): void {
  if (process.env.IELTS_HELPER_ISOLATED !== "1") return;
  const allowed =
    process.env.IELTS_HELPER_TEST_ROOT ||
    (process.env.IELTS_HELPER_CONFIG_ROOT &&
      path.dirname(process.env.IELTS_HELPER_CONFIG_ROOT));
  if (!allowed || !contains(allowed, file))
    throw new UserError("隔离模式只允许访问指定测试目录");
}

export function contains(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export function configRoot(): string {
  if (
    process.env.IELTS_HELPER_ISOLATED === "1" &&
    !process.env.IELTS_HELPER_CONFIG_ROOT
  )
    throw new UserError("隔离模式必须显式设置 IELTS_HELPER_CONFIG_ROOT");
  return (
    process.env.IELTS_HELPER_CONFIG_ROOT ||
    (process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
          "ielts-helper",
        )
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library/Application Support/ielts-helper")
        : path.join(
            process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
            "ielts-helper",
          ))
  );
}
export function vaultKey(root: string): string {
  const normalized = path.resolve(root).replace(/\\/g, "/").replace(/\/$/, "");
  return createHash("sha256")
    .update(
      process.platform === "win32" ? normalized.toLowerCase() : normalized,
    )
    .digest("hex")
    .slice(0, 16);
}
export function validateProfile(p: MachineProfile): void {
  const labels = {
    vaultRoot: "笔记库",
    studyRoot: "学习目录",
    appRoot: "外部程序目录",
    dataDir: "外部数据目录",
  };
  for (const key of ["vaultRoot", "studyRoot", "appRoot", "dataDir"] as const) {
    assertIsolatedPath(p[key]);
    if (!path.isAbsolute(p[key]))
      throw new UserError(labels[key] + "必须为绝对路径");
  }
  if (!contains(p.vaultRoot, p.studyRoot))
    throw new UserError("学习目录必须位于当前 Vault 内");
  if (contains(p.vaultRoot, p.appRoot) || contains(p.vaultRoot, p.dataDir))
    throw new UserError("程序和数据目录必须位于 Vault 外");
  if (contains(p.appRoot, p.dataDir) || contains(p.dataDir, p.appRoot))
    throw new UserError("程序和数据目录不能互相包含");
  if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535)
    throw new UserError("端口必须为 1024–65535");
  if (!p.pythonPath.trim())
    throw new UserError("请填写或自动检测 Python 解释器");
}
async function canonical(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return path.join(await canonical(path.dirname(file)), path.basename(file));
  }
}
/** 显式根覆盖用于隔离验收；构造和读取不会探测旧安装或真实数据目录。 */
export class MachineConfig {
  readonly file: string;
  constructor(
    readonly vaultRoot: string,
    readonly root = configRoot(),
  ) {
    if (contains(vaultRoot, root))
      throw new UserError("本机配置不能存入 Vault");
    assertIsolatedPath(root);
    this.file = path.join(root, "config.json");
  }
  private async read(): Promise<{
    schema: number;
    vaults: Record<string, MachineProfile>;
  }> {
    try {
      if (contains(await canonical(this.vaultRoot), await canonical(this.root)))
        throw new UserError("本机配置目录不能经符号链接进入 Vault");
      try {
        const stat = await fs.lstat(this.file);
        if (!stat.isFile() || stat.nlink > 1)
          throw new UserError("本机配置不是独立普通文件");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (value.schema !== 1 || !value.vaults)
        throw new UserError("不支持的本机配置");
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { schema: 1, vaults: {} };
      throw e;
    }
  }
  async load(): Promise<MachineProfile | undefined> {
    const p = (await this.read()).vaults[vaultKey(this.vaultRoot)];
    if (p) {
      validateProfile(p);
      if (vaultKey(p.vaultRoot) !== vaultKey(this.vaultRoot))
        throw new UserError("Vault 映射不一致");
    }
    return p;
  }
  async save(profile: MachineProfile): Promise<void> {
    validateProfile(profile);
    if (path.resolve(profile.vaultRoot) !== path.resolve(this.vaultRoot))
      throw new UserError("Vault 映射不一致");
    const data = await this.read();
    data.vaults[vaultKey(this.vaultRoot)] = profile;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(data, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
/** 只在用户点击接管后读取指定文件；不枚举真实机器目录、不改写四库。 */
export async function importLegacy(
  file: string,
  base: MachineProfile,
): Promise<MachineProfile> {
  assertIsolatedPath(file);
  const old = JSON.parse(
    (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""),
  ) as Record<string, unknown>;
  if (
    typeof old.vaultRoot === "string" &&
    vaultKey(old.vaultRoot) !== vaultKey(base.vaultRoot)
  )
    throw new UserError(
      "该配置属于其他 Vault（笔记库），请选择当前笔记库的旧配置文件",
    );
  // 用户选择的旧配置决定被接管安装；不能沿用无关向导草稿的程序根。
  // 真实旧格式没有 appRoot，此时 runtime-config 与 current.json 同处安装根。
  const p = {
    ...base,
    appRoot:
      typeof old.appRoot === "string" && old.appRoot.trim()
        ? old.appRoot
        : path.dirname(path.resolve(file)),
    updateSource: { ...base.updateSource },
  };
  for (const key of ["dataDir", "studyRoot", "pythonPath"] as const)
    if (typeof old[key] === "string") p[key] = old[key];
  if (old.releaseProvider === "github" || old.releaseProvider === "gitee") {
    p.updateSource.mode = old.releaseProvider;
    if (typeof old.repository === "string")
      p.updateSource[
        old.releaseProvider === "github" ? "githubRepo" : "giteeRepo"
      ] = old.repository;
  }
  if (typeof old.port === "number") p.port = old.port;
  validateProfile(p);
  return p;
}
