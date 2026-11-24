import { readFile } from "node:fs/promises";
// 样式表只使用普通选择器与条件分组；不认识的结构拒绝通过，避免漏审嵌套块。
const css = (await readFile(new URL("../styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [];
let start = 0;
for (const m of css.matchAll(/[{}]/g)) {
  if (m[0] === "{") {
    const header = css.slice(start, m.index).trim();
    if (blocks.at(-1) === "rule") throw Error("请将嵌套选择器展开后审计");
    if (/^@(container|media|supports)\s/.test(header)) blocks.push("group");
    else {
      for (const selector of header.split(",")) {
        if (!/^\.ielts-helper-[\w-]+(?:[\s.#[:>]|$)/.test(selector.trim())) throw Error("未隔离选择器：" + selector);
      }
      blocks.push("rule");
    }
  } else if (!blocks.pop()) throw Error("样式块不匹配");
  start = m.index + 1;
}
if (blocks.length || css.slice(start).trim()) throw Error("样式块未结束");
if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css)) throw Error("样式必须使用宿主主题变量");
console.log(`[${new Date().toISOString()}] CSS 专属前缀与主题变量审计通过`);
