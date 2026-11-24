import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fileOps from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import cp, { spawnSync } from "node:child_process";
import https from "node:https";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  compareVersions,
  getManifest,
  getPackageFeed,
  withDownloadedPackage,
  installPackages,
  localPackage,
  readInstalled,
  rollbackHelper,
  updatePlugin,
  pluginFiles,
  type PackageInput,
  type ServiceHooks,
  type FeedManifest,
} from "../src/updater/index";
import { openStream } from "../src/updater/network";

const sum = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
// 夹具仅表达条目元信息；Python 标准库生成跨平台 ZIP，不调用解压程序。
async function pack(
  dir: string,
  version: string,
  kind: "helper" | "resources",
  entries: Record<string, string>,
  symbol = false,
) {
  const file = path.join(
    dir,
    `ielts-helper-${kind === "resources" ? "resources-" : ""}${version}.zip`,
  );
  const script = `import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n,b in json.load(sys.stdin).items():\n  e=zipfile.ZipInfo(n)\n  if sys.argv[2]=='link': e.create_system=3; e.external_attr=0o120777<<16\n  z.writestr(e,b)`;
  const r = spawnSync(
    process.env.IELTS_TEST_PYTHON || "python",
    ["-c", script, file, symbol ? "link" : "plain"],
    { input: JSON.stringify(entries), encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return localPackage(file, sum(await fs.readFile(file)));
}
function fixtureService() {
  let live = false;
  const calls: string[] = [];
  const service: ServiceHooks = {
    state: async () => (live ? "owned" : "stopped"),
    stop: async () => {
      calls.push("stop");
      live = false;
    },
    start: async () => {
      calls.push("start");
      live = true;
    },
  };
  return { service, calls };
}
const program = { "terminal/IELTS_Vocab_Helper.py": "# 测试程序" };
const resources = {
  "content.db": "试题",
  "vocabulary.db": "单词",
  "dictation.db": "听写",
  "learning-progress.db": "不能覆盖",
  "study-books/demo.pdf": "书",
  "source-profiles/device-bindings.json": "不能写",
  "listening/sound.zip": "录音",
};
test("本地初始化、手动升级、启动失败恢复和手动回退使用同一版本指针，学习库不变", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-updater-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    vaultRoot: path.join(root, "vault"),
  };
  await fs.mkdir(paths.dataDir);
  await fs.writeFile(
    path.join(paths.dataDir, "learning-progress.db"),
    "原有记录",
  );
  const a = await pack(root, "3.1.0", "helper", program),
    b = await pack(root, "3.2.0", "helper", program),
    r = await pack(root, "1.0.0", "resources", resources);
  const { service, calls } = fixtureService();
  await fs.writeFile(
    path.join(root, "checksums.txt"),
    `${a.sha256}  ${path.basename(a.file)}\n`,
  );
  assert.deepEqual(await localPackage(a.file), a);
  await installPackages(paths, [a, r], service);
  assert.deepEqual(calls, ["start"]);
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "listening/sound.zip"), "utf8"),
    "录音",
  );
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "learning-progress.db"), "utf8"),
    "原有记录",
  );
  await assert.rejects(
    fs.access(path.join(paths.dataDir, "source-profiles/device-bindings.json")),
  );
  let bad = true;
  const failing = {
    ...service,
    start: async () => {
      if (bad) {
        bad = false;
        throw Error("启动失败");
      }
      await service.start();
    },
  };
  await assert.rejects(installPackages(paths, [b], failing), /启动失败/);
  assert.equal((await readInstalled(paths.appRoot)).version, a.version);
  assert.equal(await service.state(), "owned");
  await installPackages(paths, [b], service);
  assert.equal((await readInstalled(paths.appRoot)).previousVersion, a.version);
  await rollbackHelper(paths, service);
  assert.equal((await readInstalled(paths.appRoot)).version, a.version);
  assert.equal(await service.state(), "owned");
});
test("拒绝摘要不符、目录穿越和链接条目，端口属于外部服务时不调用停止", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-refuse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
      appRoot: path.join(root, "app"),
      dataDir: path.join(root, "data"),
      vaultRoot: path.join(root, "vault"),
    },
    svc = fixtureService();
  const normal = await pack(root, "1.0.0", "helper", program),
    bad: PackageInput = { ...normal, sha256: "f".repeat(64) };
  await assert.rejects(installPackages(paths, [bad], svc.service), /SHA-256/);
  const parent = await pack(root, "1.0.1", "helper", {
    "../sentinel": "仅作拒绝断言",
  });
  await assert.rejects(installPackages(paths, [parent], svc.service));
  const link = await pack(root, "1.0.2", "helper", program, true);
  await assert.rejects(installPackages(paths, [link], svc.service), /链接/);
  assert.deepEqual(await fs.readdir(paths.appRoot), []);
  assert.deepEqual(await fs.readdir(paths.dataDir), []);
  await assert.rejects(
    installPackages(paths, [normal], {
      ...svc.service,
      state: async () => "external",
    }),
    /外部/,
  );
  assert.deepEqual(svc.calls, []);
});
type Reply = { bytes?: string; status?: number; location?: string; contentType?: string };
function mockHttp(
  t: import("node:test").TestContext,
  reply: (url: URL, headers: Record<string, string>) => Reply,
) {
  t.mock.method(
    https,
    "request",
    (
      url: URL,
      opts: { headers: Record<string, string> },
      callback: (v: unknown) => void,
    ) => {
      const o = reply(url, opts.headers),
        res = Object.assign(Readable.from([Buffer.from(o.bytes ?? "")]), {
          statusCode: o.status ?? 200,
          headers: { location: o.location, "content-type": o.contentType },
        });
      return Object.assign(new EventEmitter(), {
        setTimeout() {},
        end() {
          queueMicrotask(() => callback(res));
        },
      });
    },
  );
}
test("跨主机跳转剥离密钥，拒绝白名单外主机和同域不同端口", async (t) => {
  const headers: (string | undefined)[] = [];
  let dest = "https://two.example/download";
  mockHttp(t, (url, h) => {
    headers.push(h.Authorization);
    return url.host === "one.example"
      ? { status: 302, location: dest }
      : { bytes: "附件" };
  });
  const sec = randomUUID(),
    a = {
      origin: "https://one.example",
      allowed: ["https://one.example", "https://two.example"],
      token: sec,
    };
  (await openStream("/asset", a, "application/octet-stream")).destroy();
  assert.deepEqual(headers, [`Bearer ${sec}`, undefined]);
  dest = "https://two.example:9443/file";
  await assert.rejects(openStream("/asset", a, ""), /受信/);
  assert.equal(headers.length, 3);
});
test("公开插件三文件校验、重载失败恢复旧版、成功激活；公开源请求不含凭据", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-plugin-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = {
      "main.js": "新版代码",
      "manifest.json": JSON.stringify({ id: "ielts-helper", version: "2.1.0" }),
      "styles.css": "/* 新版 */",
    },
    old = {
      "main.js": "旧版代码",
      "manifest.json": JSON.stringify({ id: "ielts-helper", version: "2.0.0" }),
      "styles.css": "/* 旧版 */",
    };
  const release = {
    version: "2.1.0",
    tag: "v2.1.0",
    notes: "",
    publishedAt: "",
    assets: Object.fromEntries(
      pluginFiles.map((n) => [
        n,
        {
          url: "https://api.github.com/" + n,
          size: Buffer.byteLength(bytes[n]),
          sha256: sum(bytes[n]),
        },
      ]),
    ),
  } as FeedManifest["plugin"];
  const s = { mode: "github" as const, githubToken: randomUUID() };
  const snapshot = () =>
    Promise.all(
      pluginFiles.map((n) => fs.readFile(path.join(root, n), "utf8")),
    );
  for (const n of pluginFiles) await fs.writeFile(path.join(root, n), old[n]);
  let corrupt = true;
  mockHttp(t, (url, h) => {
    assert.equal(h.Authorization, undefined);
    const n = url.pathname.slice(1) as keyof typeof bytes;
    return { bytes: corrupt && n === "styles.css" ? "损坏" : bytes[n] };
  });
  let loads = 0;
  await assert.rejects(
    updatePlugin(s, release, root, async () => {
      loads++;
    }),
  );
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => old[n]),
  );
  assert.equal(loads, 0);
  corrupt = false;
  const rename = fileOps.rename;
  let failOnce = true;
  const fault = t.mock.method(
    fileOps,
    "rename",
    async (
      from: import("node:fs").PathLike,
      to: import("node:fs").PathLike,
    ) => {
      if (failOnce && String(to) === path.join(root, "manifest.json")) {
        failOnce = false;
        throw new Error("模拟第二文件写入失败");
      }
      return rename(from, to);
    },
  );
  await assert.rejects(
    updatePlugin(s, release, root, async () => {
      loads++;
    }),
    /第二文件/,
  );
  fault.mock.restore();
  assert.equal(loads, 0);
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => old[n]),
  );
  await assert.rejects(
    updatePlugin(s, release, root, async () => {
      if (++loads === 1) throw Error("模拟重载失败");
    }),
  );
  assert.equal(loads, 2);
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => old[n]),
  );
  await updatePlugin(s, release, root, async () => {
    loads++;
  });
  assert.deepEqual(
    await snapshot(),
    pluginFiles.map((n) => bytes[n]),
  );
});
test("离线模式不发出请求；版本比较按数字分段", async () => {
  await assert.rejects(getManifest({ mode: "local" }), /本地/);
  assert.ok(compareVersions("2.10.0", "2.9.9") > 0);
});

test("订阅根地址与清单链接只读同一清单，错误路径或带凭据 URL 不发送请求", async (t) => {
  const token = randomUUID();
  let calls = 0;
  mockHttp(t, (url, headers) => {
    calls++;
    assert.equal(url.href, "https://feed.example/manifest.json");
    assert.equal(headers.Authorization, `Bearer ${token}`);
    assert.equal(headers["Cache-Control"], "no-cache");
    return { status: 401 };
  });
  const check = (url: string) =>
    getManifest({ mode: "vps", vpsUrl: url, vpsToken: token }, true);
  for (const suffix of ["", "/manifest.json"]) {
    await assert.rejects(check("https://feed.example" + suffix), /401/);
  }
  for (const url of [
    "http://feed.example",
    "https://feed.example/owner/repo/releases",
    `https://feed.example/manifest.json?token=${token}`,
  ]) {
    await assert.rejects(check(url), /订阅|HTTPS/);
  }
  assert.equal(calls, 2);
});

test("订阅 502 区分上游发布不可用与网关错误，不回显服务端正文", async (t) => {
  let gateway = false;
  mockHttp(t, () => ({
    status: 502,
    contentType: gateway ? "text/html" : "application/json",
    bytes: gateway ? "内部网关详情" : '{"error":"upstream_unavailable"}',
  }));
  const check = () => getManifest({ mode: "vps", vpsUrl: "https://feed.example", vpsToken: randomUUID() });
  await assert.rejects(check(), /502.*上游.*发布/);
  gateway = true;
  await assert.rejects(check(), /502.*\/health/);
});

test("私有源直连优先静默 GCM、未命中才使用 Vault 外配置，公开插件始终匿名", async (t) => {
  const primary = randomUUID(),
    fallback = randomUUID();
  let have = true;
  let publicDown = false;
  let dualRelease = false;
  let lightChecksum = true;
  const lightName = "ielts-helper-light-3.0.0.zip";
  const seen: string[] = [];
  t.mock.method(
    cp,
    "spawn",
    (_cmd: string, _args: string[], o: { env: NodeJS.ProcessEnv }) => {
      assert.equal(o.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(o.env.GCM_INTERACTIVE, "never");
      const child = Object.assign(new EventEmitter(), {
        stdin: undefined as unknown as Writable,
        stdout: Readable.from(have ? ["password=" + primary + "\n"] : []),
        kill() {},
      });
      child.stdin = new Writable({
        write(chunk, _enc, cb) {
          assert.match(
            String(chunk),
            /^protocol=https\nhost=(github|gitee)\.com\n\n$/,
          );
          cb();
        },
        final(cb) {
          setImmediate(() => child.emit("close", have ? 0 : 1));
          cb();
        },
      });
      return child;
    },
  );
  const names = [
    "main.js",
    "manifest.json",
    "styles.css",
    "ielts-helper-3.0.0.zip",
    "ielts-helper-resources-1.0.0.zip",
  ];
  mockHttp(t, (url, h) => {
    const isPublic = url.pathname.includes("/demo/public/");
    if (isPublic && publicDown) return { status: 503 };
    if (isPublic) assert.equal(h.Authorization, undefined);
    else {
      assert.equal(h.Authorization, `Bearer ${have ? primary : fallback}`);
      seen.push(url.origin);
    }
    assert.ok(!url.href.includes(primary) && !url.href.includes(fallback));
    const make = (tag: string, body: string, ns: readonly string[]) => ({
      tag_name: tag,
      body,
      created_at: "2026-11-23T00:00:00Z",
      assets: [...ns, "checksums.txt"].map((n) => ({
        name: n,
        size: 1,
        browser_download_url:
          url.origin + (isPublic ? "/demo/public/" : "/demo/private/") + n,
      })),
    });
    if (url.pathname.endsWith("/releases"))
      return {
        bytes: JSON.stringify(
          isPublic
            ? [make("v2.0.0", "发布", names.slice(0, 3))]
            : [
                make("resources-v1.0.0", "audioMode: offline", [names[4]]),
                make(
                  "v3.0.0",
                  "minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.1.0",
                  dualRelease ? [names[3], lightName] : [names[3]],
                ),
              ],
        ),
      };
    if (url.pathname.endsWith("/" + lightName)) return { bytes: "L" };
    const checks = names.map((n) => `${sum("x")}  ${n}`);
    if (dualRelease && lightChecksum) checks.push(`${sum("L")}  ${lightName}`);
    return { bytes: checks.join("\n") };
  });
  for (const provider of ["github", "gitee"] as const) {
    const m = await getManifest({
      mode: provider,
      pluginRepo: "demo/public",
      githubRepo: "demo/private",
      giteeRepo: "demo/private",
      githubToken: fallback,
      giteeToken: fallback,
    });
    assert.equal(m.helper.version, "3.0.0");
    assert.equal(m.helper.minPluginVersion, "2.0.0");
    assert.equal(m.resources.audioMode, "offline");
    have = false;
  }
  publicDown = true;
  assert.equal(
    (
      await getPackageFeed({
        mode: "gitee",
        giteeRepo: "demo/private",
        giteeToken: fallback,
      })
    ).helper.version,
    "3.0.0",
  );
  assert.ok(
    seen.includes("https://api.github.com") &&
      seen.includes("https://gitee.com"),
  );
  // 同一标签仍保留旧程序及其摘要；新版必须以轻量附件名取摘要和字节。
  dualRelease = true;
  const source = { mode: "github", githubRepo: "demo/private", githubToken: fallback } as const;
  const feed = await getPackageFeed(source);
  assert.equal(feed.helper.asset.filename, names[3]);
  assert.equal(feed.helper.asset.sha256, sum("L"));
  await withDownloadedPackage(source, feed, "helper", async (pkg) => {
    assert.equal(path.basename(pkg.file), names[3]);
    assert.equal(await fs.readFile(pkg.file, "utf8"), "L");
  });
  lightChecksum = false;
  await assert.rejects(getPackageFeed(source), /校验/);
});

// 与旧版构建器相同的三条目布局；发布摘要取自封装前的发布端，而非安装器。
test("完整包校验内外两层，只安装程序和白名单资源；任一子包失败不停止旧服务", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    vaultRoot: path.join(root, "vault"),
  };
  const old = await pack(root, "3.7.6", "helper", program),
    h = await pack(root, "3.8.0", "helper", {
      ...program,
      "main.js": "旧插件",
      "manifest.json": "{}",
      "release.json": "{}",
      "styles.css": "",
    }),
    r = await pack(root, "1.2.3", "resources", resources);
  const { service, calls } = fixtureService();
  await installPackages(paths, [old], service);
  await fs.writeFile(
    path.join(paths.dataDir, "learning-progress.db"),
    "原记录",
  );
  const file = path.join(root, "ielts-helper-full-3.8.0.zip");
  const make = async (broken: boolean) => {
    const meta = {
      kind: "ielts-install-bundle",
      schema: 1,
      version: h.version,
      resourceVersion: r.version,
      components: {
        "program.zip": { size: (await fs.stat(h.file)).size, sha256: h.sha256 },
        "resources.zip": {
          size: (await fs.stat(r.file)).size,
          sha256: broken ? "0".repeat(64) : r.sha256,
        },
      },
    };
    const z = spawnSync(
      process.env.IELTS_TEST_PYTHON || "python",
      [
        "-c",
        `import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('bundle.json',sys.stdin.read());z.write(sys.argv[2],'program.zip');z.write(sys.argv[3],'resources.zip')`,
        file,
        h.file,
        r.file,
      ],
      { input: JSON.stringify(meta) },
    );
    assert.equal(z.status, 0);
    return localPackage(file, sum(await fs.readFile(file)));
  };
  await assert.rejects(
    localPackage(path.join(root, "ielts-helper-full-3.8.1.zip")),
    /SHA-256/,
  );
  // 文件名命中旧回执也不能放行不同字节。
  await make(false);
  await assert.rejects(
    installPackages(paths, [await localPackage(file)], service),
    /SHA-256/,
  );
  await assert.rejects(
    installPackages(paths, [await make(true)], service),
    /SHA-256/,
  );
  assert.deepEqual(calls, ["start"]);
  assert.equal((await readInstalled(paths.appRoot)).version, "3.7.6");
  const full = await make(false);
  await assert.rejects(installPackages(paths, [full, r], service));
  await assert.rejects(installPackages(paths, [h], service), /terminal/);
  await installPackages(paths, [full], service);
  const installed = await readInstalled(paths.appRoot);
  assert.deepEqual(
    [installed.version, installed.previousVersion, installed.resourcesVersion],
    ["3.8.0", "3.7.6", "1.2.3"],
  );
  assert.deepEqual(
    await fs.readdir(path.join(paths.appRoot, "releases/3.8.0")),
    ["terminal"],
  );
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "learning-progress.db"), "utf8"),
    "原记录",
  );
  await fs.writeFile(
    path.join(paths.dataDir, "content.db"),
    "同版资源保持原样",
  );
  await installPackages(paths, [full], service);
  assert.equal(
    await fs.readFile(path.join(paths.dataDir, "content.db"), "utf8"),
    "同版资源保持原样",
  );
});
test("运行中的锁不能抢占；已退出且没有待恢复材料的锁可接管", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ielts-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    vaultRoot: path.join(root, "vault"),
  };
  await fs.mkdir(paths.appRoot);
  const file = path.join(paths.appRoot, ".ielts-update.lock"),
    pkg = await pack(root, "3.8.0", "helper", program),
    { service } = fixtureService();
  const lock = (pid: number) =>
    fs.writeFile(file, `${new Date().toISOString()} ${pid}\n`);
  await lock(process.pid);
  await assert.rejects(installPackages(paths, [pkg], service), /已有更新锁/);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(dead.status, 0);
  await lock(dead.pid);
  await installPackages(paths, [pkg], service);
  assert.equal((await readInstalled(paths.appRoot)).version, "3.8.0");
});
