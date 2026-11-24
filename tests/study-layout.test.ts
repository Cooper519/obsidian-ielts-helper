import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureStudyLayout } from "../src/config/study-layout";
import { profile } from "./fixtures";
test("空白临时 Vault 由产品初始化入口建立学习布局，可重复调用", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-study-empty-"));
  try {
    const p = profile(root);
    await assert.rejects(fs.access(p.studyRoot));
    await ensureStudyLayout(p);
    assert.equal(
      (await fs.stat(path.join(p.studyRoot, "02-Areas"))).isDirectory(),
      true,
    );
    await ensureStudyLayout(p);
    assert.deepEqual(await fs.readdir(p.studyRoot), ["02-Areas"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("接管既有 2.Areas 不额外创建 02-Areas，也不覆盖既有笔记", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-study-old-"));
  try {
    const p = profile(root);
    await fs.mkdir(path.join(p.studyRoot, "2.Areas"), { recursive: true });
    const note = path.join(p.studyRoot, "2.Areas/review.md");
    await fs.writeFile(note, "已有复盘");
    await ensureStudyLayout(p);
    await assert.rejects(fs.access(path.join(p.studyRoot, "02-Areas")));
    assert.equal(await fs.readFile(note, "utf8"), "已有复盘");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("学习根 junction 逃逸在创建内容前拒绝", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-study-link-"));
  try {
    const p = profile(root);
    await fs.mkdir(p.vaultRoot);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      p.studyRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(ensureStudyLayout(p), /符号链接/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
