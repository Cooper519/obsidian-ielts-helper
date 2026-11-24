import { UserError } from "../user-error";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MachineProfile } from "../types";
import { contains, validateProfile } from "./machine-config";
import { log } from "../launcher/service-manager";

async function target(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return path.join(await target(path.dirname(file)), path.basename(file));
  }
}
/** 仅显式首次安装调用：为空白学习根补最小布局，不移动、改名或覆盖已有学习内容。 */
export async function ensureStudyLayout(
  profile: MachineProfile,
): Promise<void> {
  validateProfile(profile);
  const vault = await target(profile.vaultRoot),
    study = await target(profile.studyRoot);
  if (!contains(vault, study))
    throw new UserError("学习目录不能经符号链接离开当前 Vault");
  await fs.mkdir(profile.studyRoot, { recursive: true });
  for (const name of ["02-Areas", "2.Areas", ".obsidian"]) {
    const file = path.join(profile.studyRoot, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isDirectory()) throw new UserError("学习布局标识不是目录：" + name);
      if (!contains(study, await fs.realpath(file)))
        throw new UserError("学习布局目录不能指向 Vault 外");
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await fs.mkdir(path.join(profile.studyRoot, "02-Areas"));
  log("首次初始化已建立最小学习目录");
}
