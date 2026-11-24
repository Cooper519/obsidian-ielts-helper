import { UserError } from "../user-error";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
/** 返回真实解释器路径，拒绝 Store 占位符；候选可注入以隔离测试。 */
export async function detectPython(
  candidates?: string[],
): Promise<{ path: string; version: string }> {
  let list = candidates;
  if (!list) {
    list = ["python", "python3", "py"];
    const root = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
      "mise/installs/python",
    );
    try {
      for (const v of await fs.readdir(root))
        list.push(path.join(root, v, "python.exe"));
    } catch {
      /* 未安装 mise。 */
    }
  }
  for (const command of [...new Set(list)]) {
    if (/Microsoft[/\\]WindowsApps/i.test(command)) continue;
    if (process.platform === "win32" && /^python3?$/.test(command)) {
      let alias = false;
      for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        try {
          await fs.access(path.join(dir, command + ".exe"));
          alias = /Microsoft[/\\]WindowsApps/i.test(dir);
          break;
        } catch {}
      }
      if (alias) continue;
    }
    const result = await new Promise<string | undefined>((resolve) =>
      execFile(
        command,
        [
          ...(command === "py" ? ["-3"] : []),
          "-c",
          'import sys,json; print(json.dumps({"path":sys.executable,"version":list(sys.version_info[:3])}))',
        ],
        { windowsHide: true, timeout: 5000 },
        (err, out) => resolve(err ? undefined : out),
      ),
    );
    if (result)
      try {
        const value = JSON.parse(result);
        const [major, minor] = value.version;
        if (major === 3 && minor >= 8)
          return { path: value.path, version: value.version.join(".") };
      } catch {
        /* 非 Python 输出继续检查下一候选。 */
      }
  }
  throw new UserError("未找到 Python 3.8+，请指定解释器完整路径");
}
