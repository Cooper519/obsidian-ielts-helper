import { UserError } from "../user-error";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { connect } from "node:net";
import { request } from "node:http";
import type { MachineProfile, ServiceVersion } from "../types";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function log(event: string): void {
  console.info(`[IELTS Helper ${new Date().toISOString()}] ${event}`);
}
export async function localApi<T>(
  port: number,
  route: string,
  body?: unknown,
): Promise<T> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new UserError("本地接口端口无效");
  if (!/^\/(?!\/)/.test(route) || /[\\\r\n\x00#]/.test(route))
    throw new UserError("本地接口路径无效");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // 不使用 renderer fetch：Node HTTP 不发送 Origin/OPTIONS，也不放宽 Python 的跨域门禁。
  // 固定回环主机，所有 3xx 按失败处理；总期限同时覆盖建连和响应体读取。
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      reject(error);
    };
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: payload === undefined ? "GET" : "POST",
        headers:
          payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              },
      },
      (response) => {
        response.once("error", () => fail(new UserError("本地接口响应读取失败")));
        response.once("aborted", () => fail(new UserError("本地接口响应中断")));
        if (
          !response.statusCode ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          fail(new UserError("本地接口响应 " + response.statusCode));
          return;
        }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.once("end", () => {
          if (settled) return;
          let value: T;
          try {
            value = JSON.parse(text) as T;
          } catch {
            fail(new UserError("本地接口返回无效 JSON"));
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve(value);
        });
      },
    );
    const deadline = setTimeout(() => fail(new UserError("本地接口请求超时")), 3000);
    req.once("error", () => fail(new UserError("无法连接本地学习服务")));
    req.end(payload);
  });
}
/** 只有明确的连接拒绝才视为空闲；非 Helper HTTP、超时和未知错误都保守归外部占用。 */
export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (free: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(free);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ECONNREFUSED"),
    );
    socket.setTimeout(1500, () => finish(false));
  });
}
/** 仅持有本实例 child 和 stdin；没有任何 PID 终止或端口清理命令。 */
export class ServiceManager {
  private child?: ChildProcess;
  private instance?: string;
  private starting?: Promise<void>;
  private closed = false;
  constructor(
    readonly config: MachineProfile,
    readonly pluginVersion: string,
  ) {}
  async version(): Promise<ServiceVersion | undefined> {
    try {
      const v = await localApi<ServiceVersion>(
        this.config.port,
        "/api/version",
      );
      return typeof v?.version === "string" && /^\d+\.\d+\.\d+$/.test(v.version)
        ? v
        : undefined;
    } catch {
      return undefined;
    }
  }
  async state(): Promise<"owned" | "external" | "stopped"> {
    const v = await this.version();
    if (!v) {
      if (this.child && this.child.exitCode === null) return "external";
      return (await portFree(this.config.port)) ? "stopped" : "external";
    }
    const id = v.serviceIdentity;
    return this.child &&
      id?.instanceId === this.instance &&
      id?.pid === this.child.pid
      ? "owned"
      : "external";
  }
  async start(): Promise<void> {
    if (this.closed) throw new UserError("插件已卸载");
    if (this.starting) return this.starting;
    this.starting = this.startReady();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async startReady(): Promise<void> {
    if (await this.version()) return;
    if (!(await portFree(this.config.port)))
      throw new UserError("端口已被外部服务占用或无法确认空闲，请手动处理");
    const c = this.config;
    const current = JSON.parse(
      await fs.readFile(path.join(c.appRoot, "current.json"), "utf8"),
    );
    if (!/^\d+\.\d+\.\d+$/.test(current.version))
      throw new UserError("程序版本指针无效");
    const cwd = path.join(c.appRoot, "releases", current.version, "terminal");
    await fs.access(path.join(cwd, "IELTS_Vocab_Helper.py"));
    this.instance = randomUUID();
    const child = spawn(
      c.pythonPath,
      [
        "-X",
        "utf8",
        "IELTS_Vocab_Helper.py",
        "--port",
        String(c.port),
        "--plugin-instance",
        this.instance,
        "serve",
      ],
      {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...process.env,
          IELTS_DATA_DIR: c.dataDir,
          IELTS_VAULT: c.studyRoot,
          IELTS_DETACHED: "1",
          IELTS_PLUGIN_VERSION: this.pluginVersion,
          PYTHONPYCACHEPREFIX: path.join(c.appRoot, "runtime/pycache"),
          IELTS_DEV_CONFIG: path.join(c.appRoot, "dev-auth.json"),
        },
      },
    );
    this.child = child;
    let failure = false;
    child.on("error", () => {
      failure = true;
    });
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", () => {
      /* 不将服务原始输出写入插件日志，避免凭据泄漏。 */
    });
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
    });
    log("请求启动学习服务");
    for (let i = 0; i < 100; i++) {
      if (this.closed || failure || child.exitCode !== null) break;
      if ((await this.state()) === "owned") {
        log("学习服务健康检查就绪");
        return;
      }
      await wait(200);
    }
    child.stdin?.end();
    throw new UserError(
      "本地学习服务启动超时，请检查 Python 路径、端口占用与程序目录",
    );
  }
  async stop(): Promise<void> {
    const state = await this.state();
    if (state === "stopped") return;
    if (state !== "owned")
      throw new UserError("检测到外部或归属未知服务，请先手动停止");
    const child = this.child!;
    child.stdin?.end();
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (await this.version()) throw new UserError("端口仍有服务运行");
        log("学习服务已停止");
        return;
      }
      await wait(100);
    }
    throw new UserError("服务尚未退出，已保留进程，请稍后重试");
  }
  dispose(): void {
    this.closed = true;
    this.child?.stdin?.end();
  }
}
