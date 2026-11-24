import { UserError } from "../user-error";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Asset, Provider, SourceConfig } from "./types";

const hosts = {
  github: [
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ],
  gitee: ["gitee.com", "api.gitee.com", "foruda.gitee.com"],
};
export type Access = { origin: string; allowed: string[]; token?: string };
export function vpsAccess(source: SourceConfig): Access {
  let url: URL;
  try {
    url = new URL(source.vpsUrl ?? "");
  } catch {
    throw new UserError("请配置 VPS HTTPS 地址");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !source.vpsToken
  )
    throw new UserError("需要 HTTPS 订阅地址和密钥，密钥不能放在 URL 中");
  if (url.pathname !== "/" && url.pathname !== "/manifest.json")
    throw new UserError("请填写订阅站点根地址或 /manifest.json，不要填写仓库或附件链接");
  return { origin: url.origin, allowed: [url.origin], token: source.vpsToken };
}
/** 静默调用系统凭据助手；不在命令参数、终端或日志中展开凭据。 */
export function getGcmToken(provider: Provider): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-c", "credential.interactive=false", "credential", "fill"],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
        },
      },
    );
    let output = "";
    const timeout = setTimeout(() => child.kill(), 4500);
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      if (output.length + s.length <= 32768) output += s;
      else child.kill();
    });
    const finish = (token?: string) => {
      clearTimeout(timeout);
      resolve(token);
    };
    child.on("error", () => finish());
    child.on("close", (c) =>
      finish(
        c === 0
          ? /^password=([^\r\n]+)$/m.exec(output.replace(/\r/g, ""))?.[1]
          : undefined,
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(`protocol=https\nhost=${provider}.com\n\n`);
  });
}
export async function providerAccess(
  source: SourceConfig,
  provider: Provider,
  privateRepo: boolean,
): Promise<Access> {
  const token = privateRepo
    ? (await getGcmToken(provider)) ||
      (provider === "github"
        ? source.githubToken || process.env.GITHUB_TOKEN
        : source.giteeToken || process.env.GITEE_TOKEN)
    : undefined;
  return {
    origin:
      provider === "github" ? "https://api.github.com" : "https://gitee.com",
    allowed: hosts[provider].map((h) => "https://" + h),
    token,
  };
}
/** 只识别订阅服务约定的错误码；代理的 HTML 和未知正文不进入提示或日志。 */
async function manifest502(res: IncomingMessage): Promise<UserError> {
  try {
    if (res.headers["content-type"]?.startsWith("application/json")) {
      let body = "";
      for await (const chunk of res) {
        if (body.length + chunk.length > 1024) break;
        body += chunk.toString("utf8");
      }
      if (JSON.parse(body)?.error === "upstream_unavailable")
        return new UserError("订阅返回 HTTP 502：上游清单不可用，请维护者检查三类发布附件和私仓读取权限");
    }
  } catch {
    // 网关也可能返回截断或非 JSON 的错误页。
  } finally {
    res.destroy();
  }
  return new UserError("订阅返回 HTTP 502：请检查 /health；若正常，请维护者核对 VPS 源站清单和上游发布");
}

/** 每次跳转重新检查完整 HTTPS origin；认证只发给原始站，跨站后不再恢复。 */
export async function openStream(
  input: string,
  access: Access,
  accept: string,
  refresh = false,
  method: "GET" | "HEAD" = "GET",
): Promise<IncomingMessage> {
  let url: URL;
  try {
    url = new URL(input, access.origin);
  } catch {
    throw new UserError("下载地址无效");
  }
  let token =
    access.token && url.origin === access.origin ? access.token : undefined;
  for (let n = 0; n <= 5; n++) {
    if (
      url.protocol !== "https:" ||
      !access.allowed.includes(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new UserError("拒绝非受信 HTTPS 下载站点");
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          headers: {
            "User-Agent": "ielts-helper-plugin",
            Accept: accept,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(refresh ? { "Cache-Control": "no-cache" } : {}),
          },
        },
        resolve,
      );
      req.setTimeout(30000, () => req.destroy(new UserError("连接超时")));
      req.on("error", () =>
        reject(new UserError("更新源连接失败，请检查网络与证书")),
      );
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
      const location = res.headers.location;
      res.destroy();
      if (!location) throw new UserError("下载源未提供跳转目标");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new UserError("下载跳转地址无效");
      }
      if (next.origin !== url.origin) token = undefined;
      url = next;
      continue;
    }
    if (res.statusCode !== 200) {
      if (input === "/manifest.json" && res.statusCode === 502)
        throw await manifest502(res);
      res.destroy();
      throw new UserError(`更新源返回 HTTP ${res.statusCode}`);
    }
    return res;
  }
  throw new UserError("下载跳转次数过多");
}
export async function text(
  input: string,
  access: Access,
  accept = "application/json",
  refresh = false,
): Promise<string> {
  const response = await openStream(input, access, accept, refresh),
    chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      response.destroy();
      throw new UserError("发布元数据超出限制");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function checkAsset(a: Asset) {
  if (
    !a ||
    !Number.isSafeInteger(a.size) ||
    a.size < 0 ||
    !/^\w/.test(a.sha256) ||
    !/^[a-f\d]{64}$/i.test(a.sha256) ||
    typeof a.url !== "string"
  )
    throw new UserError("清单附件缺少大小、地址或 SHA-256");
}
export async function download(a: Asset, access: Access, file: string) {
  checkAsset(a);
  const res = await openStream(a.url, access, "application/octet-stream");
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    res,
    new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > a.size) return cb(new UserError("附件超过清单大小"));
        hash.update(chunk);
        cb(null, chunk);
      },
    }),
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  if (size !== a.size || hash.digest("hex") !== a.sha256.toLowerCase())
    throw new UserError("附件大小或 SHA-256 校验失败");
}
