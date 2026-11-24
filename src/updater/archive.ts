import { UserError } from "../user-error";
import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import * as yauzl from "yauzl";
import { stable, type PackageInput } from "./types";

export function checksum(text: string, name: string): string {
  const sums = text
    .split(/\r?\n/)
    .map((l) => /^([a-f\d]{64})\s+\*?(.+?)\s*$/i.exec(l))
    .filter((m) => m && m[2] === name);
  if (sums.length !== 1) throw new UserError("校验清单缺少对应文件或记录重复");
  return sums[0]![1].toLowerCase();
}
// 旧打包器只将整包摘要写入构建回执，不随 ZIP 生成校验文件。
// 已核对的迁移批次按发布端回执固定；不从待安装 ZIP 本身推导可信摘要。
const legacyBuildReceipts: Readonly<Record<string, string>> = {
  "ielts-helper-full-3.8.0.zip":
    "9a83ffb988e43bdc925bac1a362611e40e295e43ef5a8398b752ac272818deb9",
};
export async function localPackage(
  file: string,
  expectedSha256?: string,
): Promise<PackageInput> {
  const name = path.basename(file),
    parts = /^ielts-helper-(resources-|full-)?(\d+\.\d+\.\d+)\.zip$/.exec(name);
  if (!parts)
    throw new UserError(
      "请选择保留原文件名的 Helper 程序包、资源包或旧版完整包",
    );
  let digest = expectedSha256?.trim();
  if (!digest) {
    for (const n of ["checksums.txt", "SHA256SUMS"]) {
      try {
        const f = path.join(path.dirname(file), n);
        if ((await fs.stat(f)).size > 1024 * 1024)
          throw new UserError("校验清单过大");
        digest = checksum(await fs.readFile(f, "utf8"), name);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  if (!digest && parts[1] === "full-") digest = legacyBuildReceipts[name];
  if (!digest || !/^[a-f\d]{64}$/i.test(digest))
    throw new UserError(
      "请提供发布方 SHA-256 或同目录的 checksums.txt / SHA256SUMS",
    );
  return {
    kind: parts[1] === "resources-" ? "resources" : "helper",
    ...(parts[1] === "full-" ? { format: "bundle" as const } : {}),
    version: parts[2],
    file,
    sha256: digest.toLowerCase(),
  };
}
const dbNames = ["content.db", "vocabulary.db", "dictation.db"];
// 仅允许业务明确读取的媒体类型；数据库以外的用户数据不参与替换。
const mediaRoots = [
  "listening",
  "audio_cache",
  "cambridge-assets",
  "images",
  "study-books",
];
function resourcePath(name: string): string | undefined {
  const p = name.replace(/^data\//, "");
  if (dbNames.includes(p)) return p;
  if (
    [
      "source-profiles/providers.json",
      "listening_index.json",
      "reading_exams.json",
      "reading_explanations.json",
    ].includes(p)
  )
    return p;
  if (
    p
      .split("/")
      .some(
        (n) =>
          n.startsWith(".") ||
          /backup|cookie|token|credential|secret|progress|settings|session|device/i.test(
            n,
          ),
      ) ||
    p.startsWith("audio_cache/on-demand/")
  )
    return undefined;
  if (
    mediaRoots.includes(p.split("/")[0]) &&
    /\.(zip|mp3|m4a|wav|ogg|png|jpe?g|webp|svg|avif|gif|json|pdf)$/i.test(p)
  )
    return p;
  return undefined;
}
function entryPath(entry: yauzl.Entry, pkg: PackageInput) {
  const dir = entry.fileName.endsWith("/"),
    name = entry.fileName.replace(/\/$/, "");
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (
    (type !== 0 && type !== (dir ? 0o040000 : 0o100000)) ||
    (entry.externalFileAttributes & 0x400) !== 0 ||
    entry.extraFields.some(
      (f) =>
        ![0x0001, 0x000a, 0x5455, 0x7875, 0x7075, 0x5855, 0x7855].includes(
          f.id,
        ),
    )
  )
    throw new UserError("ZIP 含链接、特殊文件或不支持的扩展属性");
  if (
    entry.generalPurposeBitFlag & 1 ||
    name
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[\\:<>"|?*\x00-\x1f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new UserError("ZIP 含无效路径或加密条目");
  if (pkg.format === "bundle") {
    if (dir || !["bundle.json", "program.zip", "resources.zip"].includes(name))
      throw new UserError("完整包包含未识别的文件");
    if (name === "bundle.json" && entry.uncompressedSize > 65536)
      throw new UserError("完整包清单过大");
    return name;
  }
  if (
    pkg.format === "legacy-program" &&
    ["main.js", "styles.css", "manifest.json", "release.json"].includes(name)
  )
    return undefined;
  if (pkg.kind === "helper" && name.split("/")[0] !== "terminal")
    throw new UserError("程序包只允许 terminal/");
  if (dir) return undefined;
  return pkg.kind === "helper" ? name : resourcePath(name);
}
/** 先将输入固定为私有暂存副本并完成 SHA-256，随后才允许逐条解压。 */
export async function unpack(
  pkg: PackageInput,
  scratch: string,
): Promise<{ root: string; files: string[] }> {
  const zipPath = path.join(scratch, "archive.zip"),
    root = path.join(scratch, "files"),
    hash = createHash("sha256");
  await pipeline(
    createReadStream(pkg.file),
    new Transform({
      transform(chunk, _encoding, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    }),
    createWriteStream(zipPath, { flags: "wx", mode: 0o600 }),
  );
  if (hash.digest("hex") !== pkg.sha256.toLowerCase())
    throw new UserError("ZIP SHA-256 校验失败");
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        strictFileNames: true,
        autoClose: false,
        validateEntrySizes: true,
      },
      (err, z) => (err ? reject(err) : resolve(z!)),
    ),
  );
  const files: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  try {
    if (zip.entryCount > 100000) throw new UserError("ZIP 条目过多");
    await fs.mkdir(root);
    await new Promise<void>((resolve, reject) => {
      zip.once("error", reject);
      zip.once("end", resolve);
      zip.on("entry", (e: yauzl.Entry) => {
        void (async () => {
          const name = entryPath(e, pkg);
          if (name) {
            const key = name.normalize("NFC").toLowerCase();
            if (seen.has(key)) throw new UserError("ZIP 包含重名条目");
            seen.add(key);
            total += e.uncompressedSize;
            if (total > 8 * 1024 ** 3)
              throw new UserError("ZIP 展开体积超出限制");
            const f = path.join(root, name);
            await fs.mkdir(path.dirname(f), { recursive: true });
            const stream = await new Promise<NodeJS.ReadableStream>(
              (ok, fail) =>
                zip.openReadStream(e, (err, s) => (err ? fail(err) : ok(s!))),
            );
            await pipeline(
              stream,
              createWriteStream(f, { flags: "wx", mode: 0o600 }),
            );
            files.push(name);
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (
    pkg.kind === "helper" &&
    pkg.format !== "bundle" &&
    !files.includes("terminal/IELTS_Vocab_Helper.py")
  )
    throw new UserError("程序包缺少 Python 入口");
  if (pkg.kind === "resources" && !dbNames.every((n) => files.includes(n)))
    throw new UserError("资源包缺少题库、词汇或听写数据库");
  return { root, files };
}

/** 外层经发布方摘要校验后，按清单将两个子包交给同一安装事务。 */
export async function bundleParts(
  root: string,
  version: string,
): Promise<PackageInput[]> {
  const invalid = () => new UserError("完整包清单、组件大小或版本不匹配");
  let m;
  try {
    m = JSON.parse(await fs.readFile(path.join(root, "bundle.json"), "utf8"));
  } catch {
    throw invalid();
  }
  if (
    m?.kind !== "ielts-install-bundle" ||
    m.schema !== 1 ||
    m.version !== version ||
    typeof m.resourceVersion !== "string" ||
    !stable.test(m.resourceVersion)
  )
    throw invalid();
  const parts: PackageInput[] = [];
  for (const kind of ["helper", "resources"] as const) {
    const name = kind === "helper" ? "program.zip" : "resources.zip",
      file = path.join(root, name);
    const meta = m.components?.[name];
    if (
      typeof meta?.sha256 !== "string" ||
      !/^[a-f\d]{64}$/i.test(meta.sha256) ||
      !Number.isSafeInteger(meta.size) ||
      meta.size !== (await fs.stat(file).catch(() => undefined))?.size
    )
      throw invalid();
    parts.push({
      kind,
      file,
      version: kind === "helper" ? version : m.resourceVersion,
      sha256: meta.sha256,
      ...(kind === "helper" ? { format: "legacy-program" as const } : {}),
    });
  }
  return parts;
}
