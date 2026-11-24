import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MachineConfig,
  importLegacy,
  validateProfile,
  configRoot,
} from "../src/config/machine-config";
import { parseStudyPlan } from "../src/features/inbox-router";
import {
  scanReviews,
  buildTrend,
  streak,
} from "../src/features/review-scanner";
import { detectPython } from "../src/config/python-detect";
import { profile } from "./fixtures";
import { readInstalled } from "../src/updater";
import { resourceStatus } from "../src/config/resource-status";

test("四库状态只检查显式临时根，缺失库不创建文件", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ielts-resource-status-"),
  );
  try {
    await fs.writeFile(path.join(root, "content.db"), "临时夹具");
    const result = await resourceStatus(root);
    assert.equal(result.find((r) => r.name === "content.db")?.present, true);
    assert.equal(
      result.find((r) => r.name === "learning-progress.db")?.present,
      false,
    );
    assert.deepEqual(await fs.readdir(root), ["content.db"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("隔离模式缺省配置根不回落、隔离根外路径在 I/O 前拒绝", async () => {
  const isolated = process.env.IELTS_HELPER_ISOLATED,
    config = process.env.IELTS_HELPER_CONFIG_ROOT;
  try {
    process.env.IELTS_HELPER_ISOLATED = "1";
    delete process.env.IELTS_HELPER_CONFIG_ROOT;
    assert.throws(() => configRoot(), /必须显式/);
    const p = profile(path.join(os.tmpdir(), "ielts-isolation"));
    process.env.IELTS_HELPER_CONFIG_ROOT = path.join(os.tmpdir(), "ielts-isolation", "config");
    assert.doesNotThrow(() => validateProfile(p));
    const outside = path.join(os.tmpdir(), "ielts-unrelated");
    assert.throws(
      () => new MachineConfig(p.vaultRoot, outside),
      /隔离模式/,
    );
    await assert.rejects(
      importLegacy(path.join(outside, "runtime-config.json"), p),
      /隔离模式/,
    );
    assert.throws(
      () => validateProfile({ ...p, dataDir: outside }),
      /隔离模式/,
    );
  } finally {
    if (isolated === undefined) delete process.env.IELTS_HELPER_ISOLATED;
    else process.env.IELTS_HELPER_ISOLATED = isolated;
    if (config === undefined) delete process.env.IELTS_HELPER_CONFIG_ROOT;
    else process.env.IELTS_HELPER_CONFIG_ROOT = config;
  }
});

test("本机配置根的 junction 不得改道进入临时 Vault", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-config-link-"));
  try {
    const p = profile(root);
    await fs.mkdir(p.vaultRoot);
    const link = path.join(root, "config-link");
    await fs.symlink(
      p.vaultRoot,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const store = new MachineConfig(p.vaultRoot, link);
    await assert.rejects(store.save(p), /符号链接/);
    assert.deepEqual(await fs.readdir(p.vaultRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("按真实旧发布字段接管：安装根来自 runtime-config 所在目录，current 指针兼容额外摘要字段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-legacy-shape-"));
  try {
    const p = profile(root);
    const legacyRoot = path.join(root, "old-install");
    await fs.mkdir(legacyRoot);
    const legacy = {
      authProvider: "git-credential",
      autoUpdate: true,
      dataDir: p.dataDir,
      gitPath: "临时-git",
      port: 18766,
      pythonPath: "临时-python",
      releaseProvider: "github",
      repository: "owner/helper",
      studyRoot: p.studyRoot,
      tokenEnv: "GITHUB_TOKEN",
      vaultRoot: p.vaultRoot,
    };
    const file = path.join(legacyRoot, "runtime-config.json");
    await fs.writeFile(file, JSON.stringify(legacy));
    await fs.writeFile(
      path.join(legacyRoot, "current.json"),
      JSON.stringify({
        schema: 1,
        version: "3.7.4",
        previousVersion: "3.7.3",
        metadataSha256: "旧发布元数据摘要",
        sha256: "旧发布程序摘要",
      }),
    );
    assert.notEqual(p.appRoot, legacyRoot);
    const imported = await importLegacy(file, p);
    assert.equal(imported.appRoot, legacyRoot);
    assert.equal(imported.updateSource.githubRepo, "owner/helper");
    assert.equal(imported.dataDir, p.dataDir);
    assert.equal((await readInstalled(imported.appRoot)).version, "3.7.4");
    const explicitRoot = path.join(root, "explicit-old-app");
    await fs.writeFile(
      file,
      JSON.stringify({ ...legacy, appRoot: explicitRoot }),
    );
    assert.equal((await importLegacy(file, p)).appRoot, explicitRoot);
    await assert.rejects(
      importLegacy(file, { ...p, vaultRoot: path.join(root, "other-vault") }),
      /其他 Vault/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("配置按 Vault 隔离并且只写显式临时配置根", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-config-"));
  try {
    const p = profile(root),
      store = new MachineConfig(p.vaultRoot, path.join(root, "config"));
    assert.equal(await store.load(), undefined);
    await store.save(p);
    assert.deepEqual(await store.load(), p);
    assert.equal(
      await new MachineConfig(
        path.join(root, "other-vault"),
        path.join(root, "config"),
      ).load(),
      undefined,
    );
    await assert.rejects(fs.access(p.vaultRoot));
    assert.throws(
      () => new MachineConfig(p.vaultRoot, path.join(p.vaultRoot, "config")),
    );
    assert.throws(() =>
      validateProfile({ ...p, dataDir: path.join(p.vaultRoot, "data") }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("临时旧配置接管不读取或写入四库，旧配置保持原样", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-legacy-"));
  try {
    const p = profile(root);
    await fs.mkdir(p.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(p.dataDir, "learning-progress.db"),
      "临时学习记录",
    );
    const file = path.join(root, "runtime-config.json");
    const text = JSON.stringify(p);
    await fs.writeFile(file, text);
    const imported = await importLegacy(file, { ...p, pythonPath: "" });
    assert.equal(imported.pythonPath, "python");
    assert.equal(await fs.readFile(file, "utf8"), text);
    assert.equal(
      await fs.readFile(path.join(p.dataDir, "learning-progress.db"), "utf8"),
      "临时学习记录",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("Study-Plan 保留新旧 Topic、首未完成与全完成语义", () => {
  const source =
    "| 1 | T01 | ✅ |\n| 2 | [[Topics/T02|T02 环境]] + T03 | ⬜ |\n| 3 | T04 | ⬜ |";
  assert.deepEqual(parseStudyPlan(source), {
    day: 2,
    topics: [
      { id: "T02", label: "T02 环境" },
      { id: "T03", label: "T03" },
    ],
  });
  assert.equal(parseStudyPlan(source.replaceAll("⬜", "✅"))?.day, 3);
  assert.equal(parseStudyPlan("| 11/21 | T09 | ⬜ |"), undefined);
});
test("Reviews 兼容新旧目录、受管区、标签说明隔离与机考最新分数", () => {
  const data = scanReviews([
    {
      path: "0-IELTS/02-Areas/Reading/Reviews/a.md",
      text: "---\ndate: 2026-11-23\nielts_data_kind: machine_exam\nquestion_types: [TFNG]\n---\n<!-- IELTS_AUTO_REVIEW_START -->\nScore `2/4`\nScore `3/4`\n#error/synonym\n### Tag Reference\n#error/vocab\n<!-- IELTS_AUTO_REVIEW_END -->\n人工区 #error/rush",
    },
    {
      path: "2.Areas/Listening/Reviews/b.md",
      text: "---\ndate: 2026-11-22\nscore: 8/10\npassage: P1\n---\n#spelling",
    },
    { path: "other.md", text: "[score:: 10/10]" },
  ]);
  assert.equal(data.records.length, 2);
  assert.equal(data.records[0].num, 3);
  assert.deepEqual(data.errorCounts, { 同义替换未识别: 1, 粗心: 1 });
  assert.equal(data.qType["判断"].t, 4);
  assert.equal(data.qType.P1.c, 8);
  assert.equal(
    scanReviews(
      [{ path: "02-Areas/Listening/x.md", text: "[score:: 1/2]" }],
      "reading",
    ).records.length,
    0,
  );
  const trend = buildTrend(data.records, 2, new Date(2026, 10, 23));
  assert.deepEqual(
    trend.points.map((p) => p.value),
    [80, 75],
  );
  assert.equal(trend.ma[1], 78);
  assert.equal(streak(["2026-11-22", "2026-11-21"], new Date(2026, 10, 23)), 2);
});
test("Python 测试仅使用注入候选，不进行机器默认探测", async () => {
  await assert.rejects(detectPython([]));
  await assert.rejects(detectPython(["C:/Microsoft/WindowsApps/python.exe"]));
});

test("自定义学习目录只统计本目录并保留笔记跳转路径", () => {
  const files = [
    "学习/雅思/02-Areas/Reading/Reviews/a.md",
    "0-IELTS/02-Areas/Reading/Reviews/b.md",
    "02-Areas/Reading/Reviews/c.md",
  ].map((path) => ({ path, text: "[score:: 1/2]" }));
  assert.deepEqual(
    scanReviews(files, "all", "学习/雅思").records.map((r) => r.file),
    [files[0].path],
  );
  assert.deepEqual(
    scanReviews(files, "all", "").records.map((r) => r.file),
    [files[2].path],
  );
});
