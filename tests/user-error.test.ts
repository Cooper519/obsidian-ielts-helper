import test from "node:test";
import assert from "node:assert/strict";
import { UserError, userMessage } from "../src/user-error";
import { localPackage } from "../src/updater/archive";
test("只展示已标记的业务报错，英文开头不会被吞掉", async () => {
  assert.equal(
    userMessage(new UserError("ZIP SHA-256 校验失败")),
    "ZIP SHA-256 校验失败",
  );
  assert.ok(!userMessage(new Error("上游返回敏感响应")).includes("敏感"));
  await assert.rejects(localPackage("不是安装包"), (e) =>
    userMessage(e).includes("原文件名"),
  );
});
