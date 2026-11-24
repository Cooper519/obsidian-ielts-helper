# IELTS Helper 独立 Obsidian 插件

插件版本为 **2.0.1**。GitHub 直连遇到同一版本的传统包与轻量包时，下载并校验轻量包。插件只分发 `main.js`、`manifest.json`、`styles.css`；Python 程序和学习数据位于 Vault 外。

## 用一个订阅地址更新三项内容

在「设置 → IELTS Helper → 更新源与本机路径」选 **VPS 订阅**，填运营者提供的 HTTPS 链接，在单独的密钥框填订阅密钥，然后点 **测试连接**。看到「插件 · Helper · 资源」三个版本后，首次设备用 **初始化安装**；已经安装的设备只需点 **更新 Helper** 或 **更新资源**，不必手工下载 ZIP。后台检查不打断当前学习，只有插件自身可以开启「自动升级插件」。

维护者：本工程作为独立插件仓时，把[通知工作流](.github/workflows/notify-vps.yml)和[订阅刷新脚本](scripts/notify_vps.py)纳入默认分支及发布版本。到仓库 Settings → Secrets and variables → Actions，设置变量 `VPS_FEED_URL`（完整 HTTPS `/manifest.json`，不带查询参数）和 Secret `VPS_FEED_TOKEN`（订阅密钥）。正式发布稳定版 `vX.Y.Z` 后，工作流刷新同一清单并确认 `plugin.tag`；它不上传附件。Release 仍需包含插件三文件及 `checksums.txt` 或 `SHA256SUMS`。若只发布 Helper 或学习资源，由对应私仓通知同一个地址。

## 构建与检查

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm run audit:css
# 生成本地试用 ZIP（先构建，再封装三文件）
npm run pack:local
# 生成公开 Release 所需的四个附件，不创建标签、不上传
npm run pack:release
```

`yauzl` 及其类型是构建依赖。esbuild 将 ZIP 库及其依赖打入 `main.js`；外部引用只有 Obsidian、Electron 和 Node 内置模块。`build-meta.json` 可检查产物导入图。

`npm test` 使用 Node test runner + tsx，并预加载 `tests/isolation.mjs`。该门禁禁止包括只读存在性检查在内的真实 data/Vault 文件访问。测试只创建系统临时目录，Python 生命周期用临时模拟程序；用 `IELTS_TEST_PYTHON` 指定测试解释器，未指定时只尝试显式候选 `python`，不会运行机器默认路径探测。

## 在独立 Obsidian 环境初始化

让独立启动的 Obsidian 进程继承以下环境变量（下列路径均替换为同一个临时根）：

```text
IELTS_HELPER_ISOLATED=1
IELTS_HELPER_CONFIG_ROOT=<临时根>/machine-config
IELTS_HELPER_LEGACY_CONFIG=<临时根>/legacy/runtime-config.json
```

隔离模式必须提供配置根，不会回落到操作系统默认目录。旧配置变量可不设置；未设置时可填写临时旧配置的完整路径，隔离模式不探测真实安装。无配置启用插件时自动打开初始化弹窗；也可从设置 → IELTS Helper 进入同一套控件。

1. 在「更新源与本机路径」填写 `<临时根>/app`、`<临时根>/data`、`<临时Vault>/0-IELTS`、Python 完整路径与独立端口。可选择「仅本地 ZIP」，避免在线请求。
2. 在线初始化选择「初始化安装」；本地初始化同时选择官方命名的程序和资源 ZIP，并附带同目录 `checksums.txt` / `SHA256SUMS`。新版 Electron 使用 `webUtils.getPathForFile` 取得多选文件路径；无法取得文件路径时才显示手动路径输入。旧版 `ielts-helper-full-<版本>.zip` 单独导入；已收录的 3.8.0 构建可直接选择，其他构建需同目录校验清单或手填发布方 SHA-256。
3. 用户确认后才开始安装。首次安装会建立最小学习布局；服务健康就绪后才保存本机配置。失败时保留内存草稿，可修改后重试。

「保存本机配置」在首次安装前只应用草稿；已有安装的配置保存要求服务已停止。凭据和本机绝对路径不写插件 `data.json`。本机配置按 Vault 路径哈希隔离，并防止配置根经 junction 进入 Vault。

### 非 UI 初始化调用

```ts
import { ensureStudyLayout } from './src/config/study-layout';
import { installFromFeed, installPackages } from './src/updater';

// 仅在用户显式确认首次初始化后调用，不放入后台检查。
await ensureStudyLayout(profile);
await installFromFeed(paths, source, manifest, ['helper', 'resources'], service);
// 本地 ZIP 则调用 installPackages(paths, packages, service)。
// service.start() 必须等待 /api/version 的实例健康检查通过。
```

`ensureStudyLayout(profile)` 创建尚不存在的 studyRoot，只有缺少 `02-Areas`、`2.Areas`、`.obsidian` 三种目录标识时才补 `02-Areas`。已有旧布局不改名、不迁移、不覆盖。符号链接逃逸会在创建内容前拒绝。

### 用临时旧安装夹具接管

旧 `runtime-config.json` 的真实字段包括 `vaultRoot`、`studyRoot`、`dataDir`、`pythonPath`、`port`、`releaseProvider`、`repository`；没有 `appRoot`。将这些路径改为临时副本后，在「从旧版导入配置」输入完整路径并点「导入配置」。旧 `vaultRoot` 必须与当前临时 Vault 匹配。

接管优先采用旧配置显式 appRoot；真实旧格式没有该字段时，从所选 runtime-config 所在目录推导安装根，不沿用当前向导草稿的 appRoot。旧 `current.json` 的 `schema`、`version`、`previousVersion` 及额外摘要字段可兼容读取；启动直接进入 `releases/<version>/terminal`，不会加载其中的旧 `main.js`。接管不读取四库内容，也不写旧配置或改变数据库。若要更新，先停止服务、另选新的外部程序目录；不要改用新的数据目录。

## 保留的日常入口

- 两个 Ribbon：首页、仪表盘。
- 六个命令：`open-terminal`、`open-vocabulary-center`、`stop-service`、`open-dashboard`、`route-inbox`、`check-updates`。
- 首页仍为 `/`；词汇中心仍为 `/vocabulary-center.html`。
- inbox 仅在用户执行命令时读取 Study-Plan 并 POST `topic_id`；首个未完成 Day、旧 wikilink、新纯 Topic 单元格及全完成时最后一天的语义保持一致。
- 仪表盘只读扫描新旧 Reviews 目录，绘制四图；点击图形区域跳笔记，多篇时弹菜单。主题变化会重绘。

在线手动更新使用 `installFromFeed`：先核验并停止自有服务，再下载、安装、重启；下载失败恢复旧服务。后台检查不进入安装路径。自升级重载会刷新宿主 manifest 缓存并验证实际插件实例，加载失败抛给更新器回滚。只有存在 previousVersion 时显示回退按钮。

服务管理器只关闭所持有子进程的 stdin。非 Helper HTTP、TCP 超时或无法确认归属均视为外部占用；只有明确连接拒绝才判空闲，不会按端口清理进程。

## 可观测 UI 夹具

```bash
node scripts/preview.mjs
```

打开 `http://127.0.0.1:18769/`；`?dark` 为深色，`?test` 自动验证阅读筛选、Canvas 点击笔记跳转、VPS 控件切换并写入 `document.body.dataset.test`。夹具使用实际仪表盘和设置类，宿主和所有业务 I/O 使用内存模拟。它不能代替真实 Obsidian + File Color 的样式验收。
