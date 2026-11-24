import { ItemView, Menu, type WorkspaceLeaf } from "obsidian";
import {
  scanReviews,
  frontmatter,
  streak,
  buildTrend,
  dayString,
  reviewPath, studyRelative,
} from "./review-scanner";
import { drawChart } from "./dashboard-charts";
import type IELTSPlugin from "../main";
export const DASHBOARD = "ielts-helper-dashboard";
/** 仅读 Vault Markdown 和本地只读周统计，不触发显式回写或 inbox 路由。 */
export class DashboardView extends ItemView {
  private skill = "all";
  private generation = 0;
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: IELTSPlugin,
  ) {
    super(leaf);
  }
  getViewType() {
    return DASHBOARD;
  }
  getDisplayText() {
    return "IELTS 学习仪表盘";
  }
  getIcon() {
    return "bar-chart";
  }
  async onOpen() {
    await this.refresh();
  }
  async onClose() {
    this.generation++;
    this.contentEl.empty();
  }
  async refresh() {
    const generation = ++this.generation;
    const root = this.contentEl;
    root.empty();
    root.addClass("ielts-helper-dash");
    root.createEl("h2", { text: "学习仪表盘" });
    const controls = root.createDiv({ cls: "ielts-helper-toolbar" });
    for (const [value, title] of [
      ["all", "全部"],
      ["reading", "阅读"],
      ["listening", "听力"],
    ]) {
      const button = controls.createEl("button", { text: title });
      button.setAttribute("aria-pressed", String(this.skill === value));
      button.onclick = () => {
        this.skill = value;
        void this.refresh();
      };
    }
    controls.createEl("button", { text: "刷新" }).onclick = () =>
      void this.refresh();
    const loading = root.createEl("p", { text: "正在读取复盘笔记…" });
    try {
      const prefix = this.plugin.studyPrefix();
      const candidates = this.app.vault.getMarkdownFiles();
      const files = await Promise.all(
        candidates
          .filter((f) => reviewPath(f.path, prefix))
          .map(async (f) => ({
            path: f.path,
            text: await this.app.vault.cachedRead(f),
          })),
      );
      const data = scanReviews(files, this.skill, prefix);
      const daily = await Promise.all(
        candidates
          .filter(
            (f) =>
              studyRelative(f.path, prefix).startsWith("vocabulary/Daily/") &&
              f.name !== "tpl-daily.md",
          )
          .map(async (f) =>
            String(frontmatter(await this.app.vault.cachedRead(f)).date || ""),
          ),
      );
      if (generation !== this.generation) return;
      loading.remove();
      const stats = root.createDiv({ cls: "ielts-helper-stats" });
      const total = data.records.reduce((s, r) => s + r.den, 0),
        correct = data.records.reduce((s, r) => s + r.num, 0);
      const now = new Date(),
        ago = new Date(now);
      ago.setDate(ago.getDate() - 7);
      const week = data.records.filter(
        (r) => r.date >= dayString(ago) && r.date <= dayString(now),
      ).length;
      for (const [label, value] of [
        ["总题数", String(total)],
        ["总正确率", total ? Math.round((correct / total) * 100) + "%" : "—"],
        ["本周练习量", week + " 篇"],
        ["连续打卡", streak(daily) + " 天"],
      ]) {
        const el = stats.createDiv();
        el.createEl("span", { text: label });
        el.createEl("strong", { text: value });
      }
      const grid = root.createDiv({ cls: "ielts-helper-charts" });
      const open = (paths: string[], event: MouseEvent) => {
        if (paths.length === 1) {
          void this.app.workspace.openLinkText(paths[0], "", false);
          return;
        }
        const menu = new Menu();
        for (const p of paths)
          menu.addItem((item) =>
            item.setTitle(p.split("/").at(-1)!).onClick(() => {
              void this.app.workspace.openLinkText(p, "", false);
            }),
          );
        menu.showAtMouseEvent(event);
      };
      const chart = (title: string) => {
        const card = grid.createDiv({ cls: "ielts-helper-chart" });
        card.createEl("h3", { text: title });
        return card.createEl("canvas", {
          attr: { "aria-label": title, role: "img" },
        });
      };
      drawChart(
        chart("错因分布 · 点击跳转笔记"),
        Object.entries(data.errorCounts).map(([label, value]) => ({
          label,
          value,
          files: data.errorFiles[label],
        })),
        "pie",
        open,
      );
      drawChart(
        chart("题型 / Part 正确率"),
        Object.entries(data.qType).map(([label, q]) => ({
          label,
          value: q.t ? Math.round((q.c / q.t) * 100) : 0,
          files: q.files,
        })),
        "bar",
        open,
      );
      const trend = buildTrend(data.records);
      drawChart(
        chart("近 30 天正确率 · 7 日移动平均"),
        trend.points.map((p) => ({
          label: p.date,
          value: p.value,
          files: p.files,
        })),
        "line",
        open,
        trend.ma,
      );
      const weeklyCanvas = chart("听写模块 · 周准确率趋势");
      const weeklyLegend = weeklyCanvas.parentElement!.createEl("p", {
        text: "高频答案词 / 高频听力原文词",
      });
      try {
        const h = await this.plugin.api<{
          answer?: { week_start: string; accuracy: number }[];
          original?: { week_start: string; accuracy: number }[];
        }>("/api/dict/group-training/history");
        if (generation !== this.generation) return;
        const weeks = [
          ...new Set(
            [...(h.answer || []), ...(h.original || [])].map(
              (r) => r.week_start,
            ),
          ),
        ].sort();
        drawChart(
          weeklyCanvas,
          weeks.map((w) => ({
            label: w,
            value: h.answer?.find((r) => r.week_start === w)?.accuracy ?? null,
            files: [],
          })),
          "line",
          open,
          weeks.map(
            (w) =>
              h.original?.find((r) => r.week_start === w)?.accuracy ?? null,
          ),
        );
      } catch {
        weeklyLegend.setText("学习服务离线，周统计暂不可用");
      }
      root.createEl("p", {
        text:
          "最后扫描：" +
          new Date().toLocaleString() +
          " · " +
          data.records.length +
          " 条记录",
        cls: "ielts-helper-muted",
      });
    } catch {
      if (generation === this.generation)
        loading.setText("读取复盘失败，请检查笔记访问权限后刷新");
    }
  }
}
