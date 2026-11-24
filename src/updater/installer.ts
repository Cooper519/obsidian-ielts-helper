import { UserError } from "../user-error";
import * as fs from "node:fs/promises";
import * as p from "node:path";
import { randomUUID } from "node:crypto";
import { bundleParts, unpack } from "./archive";
import { withDownloadedPackage } from "./feed-client";
import {
  stable,
  compareVersions,
  updateLog,
  type UpdatePaths,
  type ServiceHooks,
  type PackageInput,
  type Installed,
  type PackageFeed,
  type SourceConfig,
  type Kind,
} from "./types";

async function stat(file: string) {
  try {
    return await fs.lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function readInstalled(appRoot: string): Promise<Installed> {
  const f = p.join(appRoot, "current.json");
  if (!(await stat(f))) return {};
  if (!(await fs.lstat(f)).isFile())
    throw new UserError("版本指针不是普通文件");
  const record = JSON.parse(await fs.readFile(f, "utf8"));
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new UserError("版本指针无效");
  for (const k of ["version", "previousVersion", "resourcesVersion"])
    if (
      record[k] != null &&
      (typeof record[k] !== "string" || !stable.test(record[k]))
    )
      throw new UserError("版本指针包含无效版本号");
  return record;
}
async function pointer(app: string, record: Installed | Buffer) {
  const file = p.join(app, "current.json"),
    tmp = p.join(app, `.current-${randomUUID()}`);
  try {
    await fs.writeFile(
      tmp,
      Buffer.isBuffer(record)
        ? record
        : JSON.stringify(
            { ...record, updatedAt: new Date().toISOString() },
            null,
            2,
          ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
function contains(parent: string, child: string) {
  const r = p.relative(parent, child);
  return !r || (!p.isAbsolute(r) && r !== ".." && !r.startsWith(".." + p.sep));
}
async function canonical(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "ENOENT" ||
      p.dirname(file) === file
    )
      throw e;
    return p.join(await canonical(p.dirname(file)), p.basename(file));
  }
}
/** 接受尚未创建的安装目录，但拒绝与 Vault 重叠或被软链接改道的目的地。 */
async function safeRoots(paths: UpdatePaths) {
  for (const s of [paths.appRoot, paths.dataDir, paths.vaultRoot])
    if (!p.isAbsolute(s))
      throw new UserError("安装、数据与 Vault 必须使用绝对路径");
  const [app, data, vault] = await Promise.all(
    [paths.appRoot, paths.dataDir, paths.vaultRoot].map(canonical),
  );
  for (const d of [app, data])
    if (contains(vault, d) || contains(d, vault) || d === p.parse(d).root)
      throw new UserError("外部目录不能与 Vault 重叠或使用磁盘根目录");
  if (contains(app, data) || contains(data, app))
    throw new UserError("程序和数据目录必须彼此独立");
  await fs.mkdir(app, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  return { app, data };
}
async function checkedChild(root: string, name: string) {
  let at = root;
  for (const part of name.split("/")) {
    at = p.join(at, part);
    const s = await stat(at);
    if (s?.isSymbolicLink())
      throw new UserError("目标路径含符号链接，已停止更新");
  }
  return at;
}
type Undo = () => Promise<void>;
class RecoveryIncomplete extends UserError {}
/** 二次独占检查避免两个恢复者删除彼此的新锁；有未完成事务材料时保留现场。 */
async function acquireLock(file: string) {
  const create = () =>
    fs.writeFile(file, `${new Date().toISOString()} ${process.pid}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  try {
    await create();
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const busy = () =>
    new UserError("安装目录已有更新锁，请在上一更新结束后重试");
  const guard = file + ".recovery";
  try {
    await fs.mkdir(guard);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw busy();
    throw e;
  }
  try {
    // 持锁者可能已正常退出；先重试独占创建，再检查旧锁。
    try {
      await create();
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const record = /^(\S+) ([1-9]\d*)\s*$/.exec(
      await fs.readFile(file, "utf8"),
    );
    if (!record || !Number.isFinite(Date.parse(record[1]))) throw busy();
    try {
      process.kill(Number(record[2]), 0);
      throw busy();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw busy();
    }
    if (
      (await fs.readdir(p.dirname(file))).some((n) =>
        n.startsWith(".ielts-stage-"),
      )
    )
      throw new UserError(
        "上次安装中断，暂存目录已保留。请先核对版本指针和备份，再清理遗留锁。",
      );
    await fs.unlink(file);
    try {
      await create();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw busy();
      throw e;
    }
    updateLog("已接管退出进程留下的更新锁");
  } finally {
    await fs.rmdir(guard);
  }
}
async function locked<T>(
  roots: string[],
  action: () => Promise<T>,
): Promise<T> {
  const locks: string[] = [];
  try {
    for (const root of [...new Set(roots)].sort()) {
      const file = p.join(root, ".ielts-update.lock");
      await acquireLock(file);
      locks.push(file);
    }
    return await action();
  } finally {
    for (const f of locks.reverse()) await fs.unlink(f);
  }
}
/** 程序以目录切换；资源按文件提交，不以替换数据目录的方式触碰学习库。 */
export async function installPackages(
  paths: UpdatePaths,
  packages: PackageInput[],
  service: ServiceHooks,
) {
  if (
    !packages.length ||
    (packages.some((x) => x.format === "bundle") && packages.length !== 1) ||
    new Set(packages.map((x) => x.kind)).size !== packages.length ||
    packages.some(
      (x) =>
        !["helper", "resources"].includes(x.kind) || !stable.test(x.version),
    )
  )
    throw new UserError("安装包类别重复或版本号无效");
  const { app, data } = await safeRoots(paths);
  await locked([app, data], async () => {
    if (await stat(p.join(app, "runtime-config.json")))
      throw new UserError(
        "这是旧启动器的程序目录。请在设置中选择新的外部程序目录，再安装程序；现有学习数据可以继续使用。",
      );
    const old = await readInstalled(app),
      ptr = p.join(app, "current.json"),
      hadPointer = !!(await stat(ptr));
    if ((await service.state()) === "external")
      throw new UserError("端口由外部服务占用，请先手动停止");
    const temps: string[] = [],
      undo: Undo[] = [],
      prepared: {
        pkg: PackageInput;
        tmp: string;
        root: string;
        files: string[];
      }[] = [];
    let stopped = false,
      starting = false,
      keep = false;
    try {
      const prepare = async (pkg: PackageInput): Promise<void> => {
        const tmp = await fs.mkdtemp(
          p.join(pkg.kind === "helper" ? app : data, ".ielts-stage-"),
        );
        temps.push(tmp);
        const extracted = await unpack(pkg, tmp);
        if (pkg.format === "bundle") {
          for (const part of await bundleParts(extracted.root, pkg.version))
            await prepare(part);
        } else prepared.push({ pkg, tmp, ...extracted });
      };
      for (const pkg of packages) await prepare(pkg);
      // 旧完整包经常沿用同一套资源。已装相同或更高版本时只换程序；显式独立资源包仍可重装。
      if (packages[0].format === "bundle" && old.resourcesVersion) {
        const i = prepared.findIndex((x) => x.pkg.kind === "resources");
        if (
          i >= 0 &&
          compareVersions(old.resourcesVersion, prepared[i].pkg.version) >= 0
        ) {
          const dbs = await Promise.all(
            ["content.db", "vocabulary.db", "dictation.db"].map(async (name) =>
              stat(await checkedChild(data, name)),
            ),
          );
          if (dbs.every((s) => s?.isFile())) prepared.splice(i, 1);
          else if (old.resourcesVersion !== prepared[i].pkg.version)
            throw new UserError(
              "已安装的资源版本较高但数据库不完整，请单独导入对应版本的资源包",
            );
        }
      }
      const owner = await service.state();
      if (owner === "external")
        throw new UserError("出现外部服务，请先手动停止");
      if (owner === "owned") {
        await service.stop();
        stopped = true;
      }
      const next = { ...old };
      for (const { pkg, tmp, root, files } of prepared) {
        if (pkg.kind === "helper") {
          const release = await checkedChild(app, `releases/${pkg.version}`);
          await fs.mkdir(p.dirname(release), { recursive: true });
          if (await stat(release)) {
            const save = p.join(tmp, "old-release");
            await fs.rename(release, save);
            undo.push(() => fs.rename(save, release));
          }
          await fs.rename(root, release);
          undo.push(() => fs.rename(release, root));
          if (next.version !== pkg.version) {
            next.previousVersion = next.version;
            next.version = pkg.version;
          }
        } else {
          for (const name of files) {
            const dest = await checkedChild(data, name),
              before = await stat(dest);
            if (before && (!before.isFile() || before.nlink > 1))
              throw new UserError("资源目标不是独立普通文件");
            if (name.endsWith(".db"))
              for (const suffix of ["-wal", "-shm", "-journal"])
                if (await stat(dest + suffix))
                  throw new UserError(
                    "资源库仍有 SQLite 日志，请关闭所有使用它的程序",
                  );
            await fs.mkdir(p.dirname(dest), { recursive: true });
            // 同盘保留旧文件副本，再以 rename 原子替换；不打开现有数据库写数据。
            const save = p.join(tmp, "before", name);
            if (before) {
              await fs.mkdir(p.dirname(save), { recursive: true });
              await fs.copyFile(dest, save, fs.constants.COPYFILE_FICLONE);
            }
            await fs.rename(p.join(root, name), dest);
            undo.push(
              before ? () => fs.rename(save, dest) : () => fs.unlink(dest),
            );
          }
          next.resourcesVersion = pkg.version;
        }
      }
      if (!next.version) throw new UserError("请先安装或接管 Helper 程序");
      if (hadPointer) {
        const prior = await fs.readFile(ptr);
        await pointer(app, next);
        undo.push(() => pointer(app, prior));
      } else {
        await pointer(app, next);
        undo.push(() => fs.unlink(ptr));
      }
      starting = true;
      await service.start();
      if ((await service.state()) !== "owned")
        throw new UserError("未能确认新服务归属，已取消激活");
      updateLog("已激活并启动服务");
    } catch (error) {
      try {
        if (starting && (await service.state()) === "owned")
          await service.stop();
        for (const f of undo.reverse()) await f();
        if (stopped) await service.start();
      } catch {
        keep = true;
        throw new RecoveryIncomplete(
          `更新失败，自动恢复未完成；保留恢复材料：${temps.join("、")}`,
        );
      }
      throw error;
    } finally {
      if (!keep)
        for (const t of temps) await fs.rm(t, { recursive: true, force: true });
    }
  });
}
/** 用户确认后的在线更新：先确认归属并停服，再下载；即使网络中断也恢复原服务。 */
export async function installFromFeed(
  paths: UpdatePaths,
  source: SourceConfig,
  manifest: PackageFeed,
  kinds: Kind[],
  service: ServiceHooks,
) {
  if (!kinds.length || new Set(kinds).size !== kinds.length)
    throw new UserError("请选择要安装的程序或资源包");
  const owner = await service.state();
  if (owner === "external")
    throw new UserError("端口由外部服务占用，请先手动停止");
  if (owner === "owned") await service.stop();
  const collect = async (
    index: number,
    packages: PackageInput[],
  ): Promise<void> => {
    if (index === kinds.length)
      return installPackages(paths, packages, service);
    await withDownloadedPackage(source, manifest, kinds[index], (pkg) =>
      collect(index + 1, [...packages, pkg]),
    );
  };
  try {
    await collect(0, []);
  } catch (e) {
    if (
      !(e instanceof RecoveryIncomplete) &&
      owner === "owned" &&
      (await service.state()) === "stopped"
    )
      await service.start();
    throw e;
  }
}
export async function rollbackHelper(
  paths: UpdatePaths,
  service: ServiceHooks,
) {
  const { app, data } = await safeRoots(paths);
  await locked([app, data], async () => {
    if (await stat(p.join(app, "runtime-config.json")))
      throw new UserError("请用旧启动器回退旧安装，或先切换到新的外部程序目录");
    const old = await readInstalled(app);
    if (!old.version || !old.previousVersion)
      throw new UserError("没有可回退的上一版");
    const entry = await checkedChild(
      app,
      `releases/${old.previousVersion}/terminal/IELTS_Vocab_Helper.py`,
    );
    if (!(await stat(entry))?.isFile())
      throw new UserError("上一版本程序不完整");
    const owner = await service.state();
    if (owner === "external") throw new UserError("请先手动停止外部服务");
    if (owner === "owned") await service.stop();
    try {
      await pointer(app, {
        ...old,
        version: old.previousVersion,
        previousVersion: old.version,
      });
      await service.start();
      updateLog("已回退并启动服务");
    } catch (e) {
      if ((await service.state()) === "owned") await service.stop();
      await pointer(app, old);
      if (owner === "owned") await service.start();
      throw e;
    }
  });
}
