import { UserError, userMessage } from "./user-error";
import { Plugin, Notice, Menu, FileSystemAdapter } from "obsidian";
import path from "node:path";
import { reloadAndVerify, type PluginManager } from "./ui/host-reload";
import { MachineConfig, validateProfile } from "./config/machine-config";
import { detectPython } from "./config/python-detect";
import { ensureStudyLayout } from "./config/study-layout";
import { assertServiceContext } from "./launcher/service-context";
import { ServiceManager, localApi, log } from "./launcher/service-manager";
import { DashboardView, DASHBOARD } from "./features/dashboard-view";
import { parseStudyPlan } from "./features/inbox-router";
import { HelperSettings } from "./ui/settings-tab";
import { ConfirmModal } from "./ui/confirm-modal";
import { OnboardingModal } from "./ui/onboarding-modal";
import type { MachineProfile } from "./types";
import * as updater from "./updater";

/** 标准插件入口；安装和更新只由显式动作进入，启动仅检查版本。 */
export default class IELTSPlugin extends Plugin {
  profile?: MachineProfile;
  config!: MachineConfig;
  service?: ServiceManager;
  feed?: updater.PackageFeed;
  pluginRelease?: Awaited<ReturnType<typeof updater.getPluginRelease>>;
  private status!: HTMLElement;
  private busy = false;
  private routeBusy = false;
  private alive = true;
  private onboarding?: OnboardingModal;
  async onload() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("IELTS Helper 仅支持桌面本地 Vault");
      return;
    }
    this.config = new MachineConfig(adapter.getBasePath());
    try {
      this.profile = await this.config.load();
      if (this.profile)
        this.service = new ServiceManager(this.profile, this.manifest.version);
    } catch {
      new Notice("本机配置无效，请检查 Vault 外 config.json");
    }
    this.registerView(DASHBOARD, (leaf) => new DashboardView(leaf, this));
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD))
          if (leaf.view instanceof DashboardView) void leaf.view.refresh();
      }),
    );
    this.addSettingTab(new HelperSettings(this.app, this));
    this.addRibbonIcon(
      "rocket",
      "打开 IELTS Helper",
      () => void this.run(() => this.openStudy()),
    );
    this.addRibbonIcon(
      "bar-chart",
      "打开 IELTS 仪表盘",
      () => void this.openDashboard(),
    );
    const commands: [string, string, () => Promise<unknown>][] = [
      ["open-terminal", "打开 IELTS Helper 首页", () => this.openStudy()],
      ["open-vocabulary-center", "打开词汇中心", () => this.openStudy(true)],
      [
        "stop-service",
        "停止 IELTS Helper 后台服务",
        () => this.needService().stop(),
      ],
      ["open-dashboard", "打开 IELTS 仪表盘", () => this.openDashboard()],
      [
        "route-inbox",
        "分配数据库待处理词到今日 Topic",
        () => this.routeInbox(),
      ],
      [
        "check-updates",
        "检查插件与 IELTS Helper 更新",
        () => this.checkUpdates(),
      ],
    ];
    for (const [id, name, action] of commands)
      this.addCommand({ id, name, callback: () => void this.run(action) });
    this.status = this.addStatusBarItem();
    this.status.addClass("ielts-helper-status");
    this.registerDomEvent(
      this.status,
      "click",
      () => void this.run(() => this.openStudy()),
    );
    this.registerDomEvent(this.status, "contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      for (const [title, action] of [
        ["打开首页", () => this.openStudy()],
        ["打开词汇中心", () => this.openStudy(true)],
        ["停止服务", () => this.needService().stop()],
        ["打开设置", async () => this.openSettings()],
      ] as const)
        menu.addItem((item) =>
          item.setTitle(title).onClick(() => void this.run(action)),
        );
      menu.showAtMouseEvent(e);
    });
    await this.refreshStatus();
    this.registerInterval(
      window.setInterval(() => void this.refreshStatus(), 15000),
    );
    if (!this.profile) {
      this.onboarding = new OnboardingModal(this.app, this);
      this.onboarding.open();
    }
    else if (
      this.profile.autoCheckUpdates !== false &&
      this.profile.updateSource.mode !== "local"
    )
      void this.checkUpdates(false).catch(() => {
        /* 静默离线检查不打扰学习。 */
      });
  }
  onunload() {
    this.alive = false;
    this.onboarding?.close();
    this.service?.dispose();
  }
  needProfile(): MachineProfile {
    if (!this.profile)
      throw new UserError("请先在插件设置中初始化或接管本机安装");
    return this.profile;
  }
  needService(): ServiceManager {
    this.needProfile();
    if (!this.service) throw new UserError("服务管理器尚未初始化");
    return this.service;
  }
  async api<T>(route: string, body?: unknown): Promise<T> {
    return localApi(this.needProfile().port, route, body);
  }
  async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      /* 不输出可能含 Token 的网络错误或配置。 */ new Notice(
        userMessage(error),
        8000,
      );
      log("操作未完成");
    } finally {
      await this.refreshStatus();
    }
  }
  openSettings() {
    const app = this.app as unknown as {
      setting: { open(): void; openTabById(id: string): void };
    };
    app.setting.open();
    app.setting.openTabById(this.manifest.id);
  }
  async save(p: MachineProfile) {
    validateProfile(p);
    if (this.service && (await this.service.state()) !== "stopped")
      throw new UserError("修改配置前请先停止服务；外部服务需手动停止");
    const persisted = !!(await updater.readInstalled(p.appRoot)).version;
    if (persisted) await this.config.save(p);
    this.service?.dispose();
    this.profile = structuredClone(p);
    this.service = new ServiceManager(this.profile, this.manifest.version);
    this.feed = undefined;
    this.pluginRelease = undefined;
    log(persisted ? "本机配置已保存" : "首次安装配置已暂存");
    return persisted;
  }
  async openStudy(vocabulary = false) {
    await this.needService().start();
    const version = await this.needService().version();
    if (version?.serviceIdentity?.dataRoot && version.serviceIdentity.vaultRoot)
      assertServiceContext(this.needProfile(), version);
    const url = `http://127.0.0.1:${this.needProfile().port}/${vocabulary ? "vocabulary-center.html" : ""}`;
    const { shell } = require("electron") as {
      shell: { openExternal(url: string): Promise<void> };
    };
    await shell.openExternal(url);
  }
  async openDashboard() {
    let leaf = this.app.workspace.getLeavesOfType(DASHBOARD)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: DASHBOARD, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  studyPrefix(): string | undefined {
    return (
      this.profile &&
      path
        .relative(this.profile.vaultRoot, this.profile.studyRoot)
        .split(path.sep)
        .join("/")
    );
  }
  async routeInbox() {
    if (this.routeBusy) throw new UserError("正在分配待处理词，请稍候");
    this.routeBusy = true;
    try {
      await this.needService().start();
      const version = await this.needService().version();
      assertServiceContext(this.needProfile(), version);
      if (
        version?.pluginUpgradeRequired ||
        (version?.minPluginVersion &&
          updater.compareVersions(
            this.manifest.version,
            version.minPluginVersion,
          ) < 0)
      )
        throw new UserError(
          "请先升级插件以使用 inbox 分配；学习页仍可正常打开",
        );
      const file = this.app.vault.getFileByPath(
        [this.studyPrefix(), "vocabulary/00-Study-Plan.md"]
          .filter(Boolean)
          .join("/"),
      );
      if (!file) throw new UserError("未找到 Study-Plan");
      const day = parseStudyPlan(await this.app.vault.read(file));
      if (!day?.topics.length)
        throw new UserError("Study-Plan 中未找到当前 Day Topic");
      const result = await this.api<{
        ok: boolean;
        moved?: number;
        skipped?: number;
      }>("/api/vocabulary/route-inbox", { topic_id: day.topics[0].id });
      if (!result.ok) throw new UserError("数据库待处理词分配失败");
      new Notice(
        `已分配 ${result.moved || 0} 个词，跳过 ${result.skipped || 0} → ${day.topics[0].id}（Day ${day.day}）`,
      );
    } finally {
      this.routeBusy = false;
    }
  }
  async checkUpdates(interactive = true) {
    const p = this.needProfile();
    if (p.updateSource.mode === "vps") {
      const feed = await updater.getManifest(p.updateSource, interactive);
      this.feed = feed;
      this.pluginRelease = feed.plugin;
    } else if (p.updateSource.mode === "local") {
      if (interactive) new Notice("仅本地 ZIP 模式不检查在线版本");
      return;
    } else {
      const [programs, plugin] = await Promise.allSettled([
        updater.getPackageFeed(p.updateSource),
        updater.getPluginRelease(p.updateSource),
      ]);
      this.feed = programs.status === "fulfilled" ? programs.value : undefined;
      this.pluginRelease =
        plugin.status === "fulfilled" ? plugin.value : undefined;
      if (!this.feed && !this.pluginRelease)
        throw programs.status === "rejected" ? programs.reason : plugin;
      if (interactive && (!this.feed || !this.pluginRelease))
        new Notice(
          this.feed
            ? "已检查 Helper 和资源；公开插件仓暂不可用"
            : "已检查插件；Helper 和资源未能检查",
        );
    }
    if (interactive && this.feed && this.pluginRelease)
      new Notice("版本检查完成，请在设置页查看");
    if (
      !interactive &&
      p.autoUpgradePlugin &&
      this.pluginRelease &&
      updater.compareVersions(
        this.pluginRelease.version,
        this.manifest.version,
      ) > 0
    )
      await this.upgradePlugin(false);
    await this.refreshStatus();
  }
  async exclusive(action: () => Promise<void>) {
    if (this.busy) throw new UserError("正在执行另一项安装或更新");
    this.busy = true;
    const progress = new Notice("正在校验并执行操作，请勿关闭 Obsidian…", 0);
    try {
      await action();
    } finally {
      progress.hide();
      this.busy = false;
    }
  }
  paths() {
    const p = this.needProfile();
    return { appRoot: p.appRoot, dataDir: p.dataDir, vaultRoot: p.vaultRoot };
  }
  async installOnline(kinds: ("helper" | "resources")[]) {
    if (
      !(await ConfirmModal.ask(
        this.app,
        "安装 / 更新",
        "请先保存学习进度。将停止本插件服务，再下载、校验并安装；失败恢复旧版，保留上一程序版本。",
      ))
    )
      return;
    await this.exclusive(async () => {
      const p = this.needProfile();
      const feed = await updater.getPackageFeed(p.updateSource, true);
      if (!(await updater.readInstalled(p.appRoot)).version)
        await ensureStudyLayout(p);
      await updater.installFromFeed(
        this.paths(),
        p.updateSource,
        feed,
        kinds,
        this.needService(),
      );
      await this.config.save(p);
      new Notice("安装完成，学习服务已就绪");
      if (p.openBrowserOnStart) await this.openStudy();
    });
  }
  async installLocal(files: { file: string; sha256?: string }[]) {
    if (!files.length) throw new UserError("请选择本地 ZIP");
    if (
      !(await ConfirmModal.ask(
        this.app,
        "导入本地 ZIP",
        files.some((f) => /^ielts-helper-full-/.test(path.basename(f.file)))
          ? "将更新 Helper，按需安装包内资源，不覆盖学习进度。请先保存当前练习，确认后会重启学习服务。"
          : "请先保存当前练习。确认后会校验安装包并重启学习服务。",
      ))
    )
      return;
    await this.exclusive(async () => {
      const packages = await Promise.all(
        files.map((f) => updater.localPackage(f.file, f.sha256)),
      );
      if (!(await updater.readInstalled(this.needProfile().appRoot)).version)
        await ensureStudyLayout(this.needProfile());
      await updater.installPackages(this.paths(), packages, this.needService());
      await this.config.save(this.needProfile());
      new Notice("本地安装完成，学习服务已就绪");
      if (this.needProfile().openBrowserOnStart) await this.openStudy();
    });
  }
  async rollback() {
    if (
      await ConfirmModal.ask(
        this.app,
        "回退 Helper",
        "将停止本插件服务并切换到上一程序版本，学习数据不回退。",
      )
    )
      await this.exclusive(() =>
        updater.rollbackHelper(this.paths(), this.needService()),
      );
  }
  async upgradePlugin(confirm = true, selectedSource?: updater.SourceConfig) {
    if (
      confirm &&
      !(await ConfirmModal.ask(
        this.app,
        "升级插件",
        "插件将校验并替换标准三文件，然后重新加载。",
      ))
    )
      return;
    await this.exclusive(async () => {
      // 首次使用也可从表单指定的订阅升级插件，不要求先安装 Python 服务。
      const source = selectedSource ?? this.needProfile().updateSource;
      const release = await updater.getPluginRelease(source, confirm);
      if (
        updater.compareVersions(release.version, this.manifest.version) <= 0
      ) {
        new Notice("当前已是最新版，无需升级插件");
        return;
      }
      const manager = (this.app as unknown as { plugins: PluginManager })
        .plugins;
      if (!manager?.disablePlugin || !manager.enablePlugin)
        throw new UserError("当前 Obsidian 不支持自动重载，请手动升级插件");
      const adapter = this.app.vault.adapter as FileSystemAdapter;
      const dir = path.join(
        adapter.getBasePath(),
        this.manifest.dir ||
          `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      );
      await updater.updatePlugin(source, release, dir, () =>
        reloadAndVerify(manager, this.manifest.id, dir),
      );
    });
  }
  async refreshStatus() {
    if (!this.status || !this.alive) return;
    const version = await this.service?.version();
    const installed = this.profile
      ? await updater
          .readInstalled(this.profile.appRoot)
          .catch(() => ({}) as { resourcesVersion?: string })
      : undefined;
    const newer =
      (!!this.pluginRelease &&
        updater.compareVersions(
          this.pluginRelease.version,
          this.manifest.version,
        ) > 0) ||
      (!!this.feed?.helper &&
        !!version &&
        updater.compareVersions(this.feed.helper.version, version.version) >
          0) ||
      (!!this.feed?.resources &&
        !!installed?.resourcesVersion &&
        updater.compareVersions(
          this.feed.resources.version,
          installed.resourcesVersion,
        ) > 0);
    if (this.alive)
      this.status.setText(
        newer ? "IELTS: 有新版" : version ? "IELTS: 在线" : "IELTS: 离线",
      );
  }
  async detectPython() {
    return detectPython();
  }
}
