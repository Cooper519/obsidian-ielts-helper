import { PluginSettingTab, Setting, Notice, type App } from "obsidian";
import path from "node:path";
import { UserError } from "../user-error";
import type IELTSPlugin from "../main";
import type { MachineProfile } from "../types";
import { importLegacy } from "../config/machine-config";
import {
  getGcmToken,
  getManifest,
  readInstalled,
  compareVersions,
  type FeedManifest,
} from "../updater";
import { resourceStatus } from "../config/resource-status";

/** 三分区设置；草稿须显式保存，密钥只经本机配置持久化。 */
export class HelperSettings extends PluginSettingTab {
  private draft?: MachineProfile;
  private verified?: FeedManifest;
  private baseline = "";
  private generation = 0;
  constructor(
    app: App,
    private helper: IELTSPlugin,
  ) {
    super(app, helper);
  }
  hide() {
    if (this.draft && JSON.stringify(this.draft) !== this.baseline)
      new Notice("未保存的配置更改已放弃");
    this.generation++;
    this.draft = undefined;
    this.verified = undefined;
  }
  display() {
    const generation = ++this.generation;
    const root = this.containerEl;
    root.empty();
    const content = root.createDiv({ cls: "ielts-helper-settings" });
    content.createEl("h2", { cls: "ielts-helper-title", text: "IELTS Helper" });
    const heading = (text: string) =>
      content.createEl("h2", { cls: "ielts-helper-section-title", text });
    const vault = this.helper.config.vaultRoot;
    const fresh = !this.draft;
    this.draft ??= this.helper.profile
      ? structuredClone(this.helper.profile)
      : {
          vaultRoot: vault,
          studyRoot: path.join(vault, "0-IELTS"),
          appRoot: "",
          dataDir: "",
          pythonPath: "",
          port: 8766,
          openBrowserOnStart: true,
          autoUpgradePlugin: false,
          autoCheckUpdates: true,
          updateSource: {
            mode: "vps",
            vpsUrl: "",
            pluginRepo: "Cooper519/obsidian-ielts-helper",
          },
        };
    const p = this.draft;
    if (fresh) this.baseline = JSON.stringify(p);
    const dirty = content.createDiv({ cls: "ielts-helper-dirty" });
    dirty.setAttribute("role", "status");
    const showDirty = () => {
      dirty.textContent =
        JSON.stringify(p) !== this.baseline ? "有未保存的更改" : "";
    };
    content.addEventListener("input", showDirty);
    content.addEventListener("change", showDirty);
    showDirty();
    const prepare = async () => {
      if (
        !this.helper.profile ||
        JSON.stringify(this.helper.profile) !== JSON.stringify(p)
      )
        await this.helper.save(p);
      this.baseline = JSON.stringify(p);
    };
    const action = (
      name: string,
      description: string,
      label: string,
      fn: () => Promise<unknown>,
      parent: HTMLElement = content,
    ) => {
      return new Setting(parent)
        .setName(name)
        .setDesc(description)
        .addButton((b) =>
          b.setButtonText(label).onClick(async () => {
            b.setDisabled(true);
            try {
              await this.helper.run(fn);
            } finally {
              if (generation === this.generation) this.display();
            }
          }),
        );
    };
    heading("运行状态");
    const init = content.createDiv();
    init.hidden = true;
    const online = p.updateSource.mode !== "local";
    const current = this.helper.profile;
    const service = action(
      "学习服务",
      current ? "正在检查…" : "尚未初始化",
      "打开学习页",
      () => this.helper.openStudy(),
    );
    service.controlEl.querySelector("button")?.classList.add("mod-cta");
    if (!current) service.settingEl.hidden = true;
    const compatibility = content.createDiv();
    if (this.helper.service)
      void this.helper.service.version().then((v) => {
        if (generation !== this.generation) return;
        service.setDesc(
          v ? `运行中 · 端口 ${current?.port} · Helper ${v.version}` : "未运行",
        );
        if (v)
          service.addButton((b) =>
            b.setButtonText("停止服务").onClick(async () => {
              await this.helper.run(() => this.helper.needService().stop());
              if (generation === this.generation) this.display();
            }),
          );
        if (
          v?.pluginUpgradeRequired ||
          v?.pluginUpgradeRecommended ||
          [v?.recommendedPluginVersion, v?.minPluginVersion].some(
            (ver) =>
              ver && compareVersions(this.helper.manifest.version, ver) < 0,
          )
        )
          compatibility.createEl("p", {
            cls: "ielts-helper-warning",
            text: "请升级 Obsidian 插件。你仍可打开学习页和启停服务。",
          });
      });
    let legacy = "";
    const migration = new Setting(init)
      .setName("从旧版导入配置")
      .setDesc(
        "导入旧版路径即可继续学习。更新程序时请另选新目录，保留旧版供回退。",
      );
    migration.addText((t) =>
      t.setPlaceholder("runtime-config.json 路径").onChange((v) => {
        legacy = v.trim();
      }),
    );
    migration.addButton((b) =>
      b.setButtonText("导入配置").onClick(async () => {
        await this.helper.run(async () => {
          const file =
            legacy ||
            process.env.IELTS_HELPER_LEGACY_CONFIG ||
            (p.appRoot && path.join(p.appRoot, "runtime-config.json")) ||
            (process.platform === "win32" &&
            process.env.IELTS_HELPER_ISOLATED !== "1"
              ? path.join(
                  path.parse(vault).root,
                  "Apps",
                  "IELTS-Helper",
                  "runtime-config.json",
                )
              : "");
          if (!file)
            throw new UserError("请填写旧版 runtime-config.json 的完整路径");
          let imported;
          try {
            imported = await importLegacy(file, p);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT")
              throw new UserError(
                "未找到旧配置，请填写 runtime-config.json 的完整路径",
              );
            throw e;
          }
          const saved = await this.helper.save(imported);
          new Notice(
            saved ? "旧版配置已导入并保存" : "路径已导入，首次安装成功后保存",
          );
          this.draft = undefined;
          this.display();
        });
      }),
    );
    if (online)
      action(
        "首次在线安装",
        "填好下方路径和更新源后，下载程序与学习资源。",
        "初始化安装",
        async () => {
          await prepare();
          await this.helper.installOnline(["helper", "resources"]);
        },
        init,
      );
    heading("版本与更新");
    if (current && online)
      action(
        "检查更新",
        "检查已保存更新源中的版本，不会中断学习。",
        "立即检查",
        async () => {
          this.verified = undefined;
          await this.helper.checkUpdates();
        },
      );
    const pluginRow = online
      ? action("Obsidian 插件", "", "升级插件", () =>
          this.helper.upgradePlugin(true, { ...p.updateSource }),
        )
      : new Setting(content).setName("Obsidian 插件");
    const toggles = (
      key: "autoCheckUpdates" | "autoUpgradePlugin" | "openBrowserOnStart",
      label: string,
      desc = "",
    ) => {
      new Setting(content)
        .setName(label)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(p[key] ?? key === "autoCheckUpdates").onChange((v) => {
            p[key] = v;
            showDirty();
          }),
        );
    };
    if (online) {
      toggles("autoCheckUpdates", "自动检查更新");
      toggles(
        "autoUpgradePlugin",
        "自动升级插件",
        "仅升级插件；Helper 和资源仍由你手动更新。",
      );
    }
    const programRow = online
      ? action("IELTS Helper 程序", "", "更新 Helper", async () => {
          await prepare();
          await this.helper.installOnline(["helper"]);
        })
      : new Setting(content).setName("IELTS Helper 程序");
    const resourceRow = online
      ? action("学习资源包", "", "更新资源", async () => {
          await prepare();
          await this.helper.installOnline(["resources"]);
        })
      : new Setting(content).setName("学习资源包");
    let installed = "未安装",
      resources = "未安装",
      dbStatus = "";
    const showVersions = () => {
      const applied =
        JSON.stringify(current?.updateSource) ===
        JSON.stringify(p.updateSource);
      const latest = this.verified ?? (applied ? this.helper.feed : undefined);
      const plugin =
        this.verified?.plugin ??
        (applied ? this.helper.pluginRelease : undefined);
      const text = (v: string, latest?: string) =>
        online ? `当前 ${v} · 最新 ${latest || "未检查"}` : `当前 ${v}`;
      pluginRow.setDesc(text(this.helper.manifest.version, plugin?.version));
      programRow.setDesc(text(installed, latest?.helper.version));
      resourceRow.setDesc(
        [text(resources, latest?.resources.version), dbStatus]
          .filter(Boolean)
          .join(" · "),
      );
    };
    showVersions();
    if (current) {
      void readInstalled(current.appRoot)
        .then((v) => {
          if (generation !== this.generation) return;
          init.hidden = !!v.version;
          installed = v.version || "未安装";
          resources = v.resourcesVersion || "未知";
          if (v.previousVersion)
            programRow.addButton((b) =>
              b
                .setButtonText(`回退至 ${v.previousVersion}`)
                .onClick(async () => {
                  await this.helper.run(() => this.helper.rollback());
                  if (generation === this.generation) this.display();
                }),
            );
          showVersions();
        })
        .catch(() => {
          if (generation === this.generation) {
            installed = "无法读取版本";
            showVersions();
          }
        });
      void resourceStatus(current.dataDir)
        .then((rows) => {
          if (generation !== this.generation) return;
          const missing = rows.filter((r) => !r.present).map((r) => r.name);
          dbStatus = missing.length
            ? `缺少 ${missing.join("、")}`
            : "数据库 4/4 已就绪";
          showVersions();
        })
        .catch(() => {
          if (generation === this.generation) {
            dbStatus = "无法读取数据库目录";
            showVersions();
          }
        });
    } else init.hidden = false;
    const offline = content.createEl("details", { cls: "ielts-helper-local" });
    offline.open = !online;
    offline.createEl("summary", { text: "导入本地 ZIP" });
    let localFiles: { file: string; sha256?: string }[] = [];
    const local = new Setting(offline)
      .setName("选择安装包")
      .setDesc(
        "程序包与资源包可一起选择；旧版完整包请单独选择。已收录的 3.8.0 完整包可直接导入，其他包请附校验清单或填写发布方 SHA-256。",
      );
    const input = local.controlEl.createEl("input", {
      attr: { type: "file", accept: ".zip", multiple: "" },
    });
    let explicitZip = "";
    input.onchange = () => {
      const electron = require("electron") as {
        webUtils?: { getPathForFile(file: File): string };
      };
      localFiles = Array.from(input.files || []).map((f) => ({
        file:
          electron.webUtils?.getPathForFile(f) ||
          (f as File & { path?: string }).path ||
          "",
      }));
      fallback.settingEl.hidden = !localFiles.some((f) => !f.file);
      explicitZip = "";
    };
    let manual = "";
    local.addText((t) =>
      t.setPlaceholder("可选：单包 SHA-256").onChange((v) => {
        manual = v.trim();
      }),
    );
    local.addButton((b) =>
      b.setButtonText("导入 ZIP").onClick(
        () =>
          void this.helper.run(async () => {
            const selected = explicitZip ? [{ file: explicitZip }] : localFiles;
            if (!selected.length) throw new UserError("请先选择 ZIP 文件");
            if (selected.some((f) => !f.file))
              throw new UserError("无法读取文件位置，请在下方填写完整路径");
            if (manual && selected.length !== 1)
              throw new UserError("手动摘要仅支持单包导入");
            await prepare();
            await this.helper.installLocal(
              selected.map((f) => ({ ...f, sha256: manual || undefined })),
            );
            if (generation === this.generation) this.display();
          }),
      ),
    );
    const fallback = new Setting(offline)
      .setName("ZIP 完整路径")
      .setDesc("无法读取所选文件位置，请每次输入一个 ZIP 路径。")
      .addText((t) =>
        t.onChange((v) => {
          explicitZip = v.trim();
        }),
      );
    fallback.settingEl.hidden = true;
    heading("更新源与本机路径");
    new Setting(content).setName("更新源").addDropdown((d) =>
      d
        .addOptions({
          vps: "VPS 订阅（推荐）",
          github: "GitHub 直连",
          gitee: "Gitee 直连",
          local: "仅本地 ZIP",
        })
        .setValue(p.updateSource.mode)
        .onChange((v) => {
          p.updateSource.mode = v as MachineProfile["updateSource"]["mode"];
          this.verified = undefined;
          this.display();
        }),
    );
    const sourceText = (
      key:
        | "vpsUrl"
        | "vpsToken"
        | "githubRepo"
        | "giteeRepo"
        | "githubToken"
        | "giteeToken"
        | "pluginRepo",
      label: string,
      secret = false,
      changed?: () => void,
    ) => {
      const row = new Setting(content).setName(label);
      if (key === "vpsToken")
        row.setDesc(
          "用于查询版本和下载更新，由订阅服务管理员提供。密钥只保存在本机；本地学习无需填写。",
        );
      row.addText((t) => {
        t.setValue(p.updateSource[key] || "").onChange((v) => {
          p.updateSource[key] = v;
          changed?.();
        });
        if (secret) {
          t.inputEl.type = "password";
          t.inputEl.autocomplete = "off";
        }
      });
    };
    if (p.updateSource.mode === "vps") {
      let revision = 0;
      const hint =
        "使用 HTTPS 根地址或 /manifest.json；验证只读取版本，不下载。";
      const changed = () => {
        revision++;
        this.verified = undefined;
        row.setDesc(hint);
        showVersions();
      };
      sourceText("vpsUrl", "VPS HTTPS 地址", false, changed);
      sourceText("vpsToken", "VPS 访问密钥", true, changed);
      const row = new Setting(content).setName("订阅清单").setDesc(hint);
      row.descEl.setAttribute("aria-live", "polite");
      row.addButton((b) =>
        b.setButtonText("测试连接").onClick(async () => {
          // 仅验证此刻填写的源；编辑或关闭后丢弃旧请求结果，不保存草稿或凭据。
          const current = revision;
          const show = (text: string) => {
            if (current === revision && generation === this.generation)
              row.setDesc(text);
          };
          b.setDisabled(true);
          this.verified = undefined;
          showVersions();
          show("正在读取订阅清单…");
          try {
            const feed = await getManifest({ ...p.updateSource }, true);
            if (current !== revision || generation !== this.generation) return;
            this.verified = feed;
            showVersions();
            const { plugin, helper, resources } = feed;
            show(
              `插件 ${plugin.version} · Helper ${helper.version} · 资源 ${resources.version}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : "";
            show(
              msg === "更新源返回 HTTP 401"
                ? "401：请核对 VPS 访问密钥。"
                : msg === "更新源返回 HTTP 502"
                  ? "502：VPS 未取到完整 Release，请检查仓库权限与附件。"
                  : "无法验证：请检查 HTTPS 订阅链接、密钥、证书和清单格式。",
            );
          } finally {
            b.setDisabled(false);
          }
        }),
      );
    }
    if (p.updateSource.mode === "github" || p.updateSource.mode === "gitee") {
      const provider = p.updateSource.mode;
      sourceText(
        provider === "github" ? "githubRepo" : "giteeRepo",
        "私有仓库",
      );
      sourceText(
        provider === "github" ? "githubToken" : "giteeToken",
        "只读 Token",
        true,
      );
      action(
        "Git 凭据管理器",
        "读取系统中保存的令牌。",
        "读取 Git 凭据",
        async () => {
          const token = await getGcmToken(provider);
          if (!token) {
            new Notice("未找到可用的 Git 凭据");
            return;
          }
          p.updateSource[provider === "github" ? "githubToken" : "giteeToken"] =
            token;
          new Notice("令牌已填入表单，请保存配置");
        },
      );
      sourceText("pluginRepo", "公开插件仓库");
    }
    for (const [key, label] of [
      ["appRoot", "外部程序目录"],
      ["dataDir", "外部数据目录"],
      ["studyRoot", "学习目录"],
      ["pythonPath", "Python 解释器"],
    ] as const) {
      const row = new Setting(content).setName(label);
      row.addText((t) => {
        t.setValue(p[key]).onChange((v) => {
          p[key] = v;
        });
      });
      if (key === "pythonPath")
        row.addButton((b) =>
          b.setButtonText("自动检测").onClick(async () => {
            await this.helper.run(async () => {
              p.pythonPath = (await this.helper.detectPython()).path;
              if (generation === this.generation) this.display();
            });
          }),
        );
    }
    const portRow = new Setting(content).setName("服务端口");
    portRow.addText((t) =>
      t
        .setValue(Number.isFinite(p.port) ? String(p.port) : "")
        .onChange((v) => {
          p.port = /^\d+$/.test(v) ? Number(v) : NaN;
          const ok =
            Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535;
          portRow.setDesc(ok ? "" : "请输入 1024–65535 之间的整数");
          t.inputEl.setAttribute("aria-invalid", String(!ok));
        }),
    );
    toggles("openBrowserOnStart", "安装或更新后自动打开学习页");
    action(
      "保存本机配置",
      "路径和密钥只保存在本机，不写入笔记库。",
      "保存",
      async () => {
        const saved = await this.helper.save(p);
        this.baseline = JSON.stringify(p);
        new Notice(saved ? "配置已保存" : "配置已暂存，首次安装成功后保存");
      },
    );
  }
}
