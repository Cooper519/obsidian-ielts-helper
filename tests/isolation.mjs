import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
// 业务夹具只放系统临时目录；插件工程本身需可读，其他目录一律不探测。
const roots = [os.tmpdir(), fileURLToPath(new URL("../", import.meta.url))];
function guard(value) {
  if (value === undefined || typeof value === "number") return;
  const name =
    value instanceof URL
      ? fileURLToPath(value)
      : Buffer.isBuffer(value)
        ? value.toString()
        : String(value);
  const target = path.resolve(name);
  if (!roots.some((root) => {
    const rel = path.relative(root, target);
    return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  })) throw Error("测试禁止访问临时目录和插件工程以外的路径");
}
const names = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "createReadStream",
  "createWriteStream",
  "exists",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "watch",
  "writeFile",
];
for (const name of names) {
  for (const key of [name, name + "Sync"]) {
    if (typeof fs[key] !== "function") continue;
    const original = fs[key];
    fs[key] = function (...args) {
      guard(args[0]);
      if (["copyFile", "cp", "rename", "symlink"].includes(name))
        guard(args[1]);
      return original.apply(this, args);
    };
  }
  if (typeof fs.promises[name] === "function") {
    const original = fs.promises[name];
    fs.promises[name] = async function (...args) {
      guard(args[0]);
      if (["copyFile", "cp", "rename", "symlink"].includes(name))
        guard(args[1]);
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();
