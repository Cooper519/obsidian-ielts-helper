import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { assertServiceContext } from "../src/launcher/service-context";
import { profile } from "./fixtures";
import type { ServiceVersion } from "../src/types";
test("写路由前必须同时匹配数据根与学习根，不能写入另一 Vault", () => {
  const p = profile(path.join(os.tmpdir(), "ielts-context"));
  const version: ServiceVersion = {
    version: "4.0.0",
    serviceIdentity: {
      instanceId: "external",
      pid: 123,
      port: 18766,
      dataRoot: p.dataDir,
      vaultRoot: p.studyRoot,
    },
  };
  assert.doesNotThrow(() => assertServiceContext(p, version));
  assert.throws(
    () =>
      assertServiceContext(p, {
        ...version,
        serviceIdentity: {
          ...version.serviceIdentity!,
          vaultRoot: path.join(os.tmpdir(), "other-vault/0-IELTS"),
        },
      }),
    /其他/,
  );
  assert.throws(
    () =>
      assertServiceContext(p, {
        ...version,
        serviceIdentity: {
          ...version.serviceIdentity!,
          dataRoot: path.join(os.tmpdir(), "other-data"),
        },
      }),
    /其他/,
  );
  assert.throws(() => assertServiceContext(p, { version: "4.0.0" }), /无法确认服务使用的学习目录/);
});
test("Windows 服务身份兼容大小写、反斜杠和尾部分隔符", () => {
  const p = {
    ...profile(path.join(os.tmpdir(), "ielts-context")),
    dataDir: "X:/临时/data",
    studyRoot: "X:/临时/Vault/0-IELTS",
  };
  assert.doesNotThrow(() =>
    assertServiceContext(p, {
      version: "4.0.0",
      serviceIdentity: {
        instanceId: null,
        pid: 1,
        port: 1,
        dataRoot: "x:\\临时\\data\\",
        vaultRoot: "x:/临时/vault/0-ielts/",
      },
    }),
  );
});
