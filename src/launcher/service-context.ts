import { UserError } from "../user-error";
import path from "node:path";
import type { MachineProfile, ServiceVersion } from "../types";
function normalized(file: string): string {
  const isWindows = /^[a-z]:[/\\]/i.test(file);
  const value = (isWindows ? path.win32.resolve(file) : path.resolve(file))
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
  return isWindows ? value.toLowerCase() : value;
}
/** 写入接口必须明确匹配当前四库与学习根；缺少身份字段也不允许路由。 */
export function assertServiceContext(
  profile: MachineProfile,
  version: ServiceVersion | undefined,
): void {
  const id = version?.serviceIdentity;
  if (!id?.dataRoot || !id.vaultRoot)
    throw new UserError("无法确认服务使用的学习目录，不能分配待处理词；学习页仍可打开");
  if (
    normalized(id.dataRoot) !== normalized(profile.dataDir) ||
    normalized(id.vaultRoot) !== normalized(profile.studyRoot)
  )
    throw new UserError("当前端口服务属于其他数据目录或 Vault，请手动处理后重试");
}
