import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadAndVerify, type PluginManager } from "../src/ui/host-reload";
test("宿主吞加载错误或保留旧实例均失败；成功与回滚分别验证磁盘期望版本", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-host-"));
  try {
    await fs.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ id: "ielts-helper", version: "2.0.1" }),
    );
    const manager: PluginManager = {
      manifests: {
        "ielts-helper": {
          id: "ielts-helper",
          version: "2.0.0",
          dir: ".obsidian/plugins/ielts-helper",
          hostOwned: "宿主归属字段",
        },
      },
      plugins: {},
      disablePlugin: async () => {},
      enablePlugin: async () => {},
    };
    await assert.rejects(
      reloadAndVerify(manager, "ielts-helper", root),
      /未加载目标插件版本/,
    );
    manager.plugins["ielts-helper"] = { manifest: { version: "2.0.0" } };
    await assert.rejects(
      reloadAndVerify(manager, "ielts-helper", root),
      /未加载目标插件版本/,
    );
    manager.enablePlugin = async (id) => {
      const manifest = manager.manifests[id] as Record<string, unknown>;
      assert.equal(
        manifest.dir,
        ".obsidian/plugins/ielts-helper",
        "不得将宿主加载路径变成 vault/undefined/main.js",
      );
      assert.equal(manifest.hostOwned, "宿主归属字段");
      manager.plugins[id] = {
        manifest: manager.manifests[id] as { version: string },
        _loaded: true,
      };
    };
    await reloadAndVerify(manager, "ielts-helper", root);
    assert.equal(manager.plugins["ielts-helper"].manifest.version, "2.0.1");
    await fs.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ id: "ielts-helper", version: "2.0.0" }),
    );
    await reloadAndVerify(manager, "ielts-helper", root);
    assert.equal(manager.plugins["ielts-helper"].manifest.version, "2.0.0");
    assert.equal(
      (manager.manifests["ielts-helper"] as Record<string, unknown>).dir,
      ".obsidian/plugins/ielts-helper",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("宿主按 manifest.dir 读取 main.js：正向及失败后回滚保留目录和其他运行期字段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-host-dir-"));
  try {
    const id = "ielts-helper",
      relative = ".obsidian/plugins/ielts-helper",
      dir = path.join(root, relative);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "main.js"), "临时插件");
    const host = {
      id,
      version: "2.0.0",
      dir: relative,
      hostOwned: { vault: "临时 Vault" },
    };
    const manager: PluginManager = {
      manifests: { [id]: host },
      plugins: { [id]: { manifest: host, _loaded: true } },
      disablePlugin: async (name) => {
        delete manager.plugins[name];
        delete manager.manifests[name];
      },
      enablePlugin: async (name) => {
        const manifest = manager.manifests[name] as typeof host;
        assert.equal(
          await fs.readFile(path.join(root, manifest.dir, "main.js"), "utf8"),
          "临时插件",
        );
        assert.deepEqual(manifest.hostOwned, { vault: "临时 Vault" });
        manager.plugins[name] = { manifest, _loaded: true };
      },
    };
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ id, version: "2.0.1", dir: "不允许由磁盘覆盖的目录" }),
    );
    await reloadAndVerify(manager, id, dir);
    assert.equal(manager.plugins[id].manifest.dir, relative);
    // 模拟新版 enable 被宿主吞掉；更新器恢复磁盘旧 manifest 后复用同一回调。
    const enable = manager.enablePlugin;
    manager.enablePlugin = async () => false;
    await assert.rejects(reloadAndVerify(manager, id, dir), /未加载目标插件版本/);
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ id, version: "2.0.0" }),
    );
    manager.enablePlugin = enable;
    await reloadAndVerify(manager, id, dir);
    assert.equal(manager.plugins[id].manifest.version, "2.0.0");
    assert.equal(manager.plugins[id].manifest.dir, relative);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
