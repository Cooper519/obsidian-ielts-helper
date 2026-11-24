export interface ReviewRecord {
  date: string;
  num: number;
  den: number;
  topic: string;
  part: string;
  types: string[];
  skill: "reading" | "listening";
  file: string;
}
export interface ReviewData {
  records: ReviewRecord[];
  errorCounts: Record<string, number>;
  errorFiles: Record<string, string[]>;
  qType: Record<string, { c: number; t: number; files: string[] }>;
}
/** 传入学习根时严格限定扫描范围；离线未配置时仍识别历史两种布局。 */
export function studyRelative(file: string, prefix?: string): string {
  if (prefix === undefined || prefix === "0-IELTS")
    return file.replace(/^0-IELTS\//, "");
  return !prefix
    ? file
    : file.startsWith(prefix + "/")
      ? file.slice(prefix.length + 1)
      : "";
}
export const reviewPath = (file: string, prefix?: string) => {
  const p = studyRelative(file, prefix);
  return (
    /^(?:01-Projects|1\.Projects)\/IELTS-Review\//.test(p) ||
    /^(?:02-Areas|2\.Areas)\/(?:Reading|Listening)\//.test(p)
  );
};
const buckets: Record<string, string> = {
  notfound: "定位失误",
  time: "定位失误",
  missed: "定位失误",
  synonym: "同义替换未识别",
  paraphrase: "同义替换未识别",
  logic: "逻辑推断",
  overthink: "逻辑推断",
  distractor: "逻辑推断",
  distraction: "逻辑推断",
  grammar: "逻辑推断",
  rush: "粗心",
  careless: "粗心",
  misread: "粗心",
  spelling: "粗心",
  plural: "粗心",
  linking_sound: "粗心",
  sound_mapping: "粗心",
  word_limit: "粗心",
  vocab: "词汇不足",
  vocabulary: "词汇不足",
};
const native =
  "missed|paraphrase|distraction|distractor|spelling|plural|linking_sound|sound_mapping|misread|word_limit|vocabulary";
export function frontmatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let key = "";
  for (const line of (
    text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ""
  ).split(/\r?\n/)) {
    const pair = line.match(/^(\w+):\s*(.*)$/);
    if (pair) {
      key = pair[1];
      const v = pair[2].replace(/^["']|["']$/g, "");
      out[key] = v.startsWith("[")
        ? v
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        : v || [];
    } else {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item && Array.isArray(out[key]))
        (out[key] as string[]).push(item[1].replace(/^["']|["']$/g, ""));
    }
  }
  return out;
}
export function bucketType(raw: string): string {
  const t = raw.toLowerCase();
  if (
    /fill|blank|completion|填空|summary|note|table|diagram|flow|short/.test(t)
  )
    return "填空";
  if (/tfng|^tf$|yn|判断|true|false|not given/.test(t)) return "判断";
  if (/heading/.test(t)) return "Heading";
  if (/match|匹配|feature|sentend/.test(t)) return "匹配";
  if (/choice|选择|^mc$|multiple|单选/.test(t)) return "单选";
  if (/title|标题/.test(t)) return "选标题";
  return raw;
}
/** 只解析最后的受管复盘区，人工区不参与重复统计；不写笔记。 */
export function scanReviews(
  files: { path: string; text: string }[],
  skill = "all",
  prefix?: string,
): ReviewData {
  const data: ReviewData = {
    records: [],
    errorCounts: {},
    errorFiles: {},
    qType: {},
  };
  for (const file of files) {
    if (!reviewPath(file.path, prefix)) continue;
    const source = file.text;
    const start = source.indexOf("<!-- IELTS_AUTO_REVIEW_START -->"),
      end = source.indexOf("<!-- IELTS_AUTO_REVIEW_END -->", start);
    const text =
      start >= 0 && end > start
        ? (source.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/)?.[0] || "") +
          "\n" +
          source.slice(start, end)
        : source;
    const fm = frontmatter(text);
    const get = (k: string) => String(fm[k] || "");
    const listening = /listening/i.test(
      file.path +
        " " +
        get("tags") +
        " " +
        get("test_type") +
        " " +
        get("ielts_skill") +
        " " +
        get("ielts_mode"),
    );
    const sk = listening ? "listening" : "reading";
    if (skill !== "all" && skill !== sk) continue;
    let depth = 0;
    for (const line of text.split("\n")) {
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (h && /^Tag Reference\b/i.test(h[2])) {
        depth = h[1].length;
        continue;
      }
      if (h && h[1].length <= depth) depth = 0;
      if (depth) continue;
      for (const m of line.matchAll(
        new RegExp("#(?:error/(\\w+)|(" + native + ")\\b)", "g"),
      )) {
        const label = buckets[m[1] || m[2]] || m[1];
        data.errorCounts[label] = (data.errorCounts[label] || 0) + 1;
        data.errorFiles[label] ??= [];
        if (!data.errorFiles[label].includes(file.path))
          data.errorFiles[label].push(file.path);
      }
    }
    const inline = (key: string) =>
      [
        ...text.matchAll(
          new RegExp("\\[" + key + "\\s*::\\s*([^\\]]+)\\]", "gi"),
        ),
      ].map((m) => m[1].trim());
    let scores = inline("score");
    const dates = inline("date"),
      parts = inline("part"),
      topics = inline("topic");
    if (get("ielts_data_kind") === "machine_exam") {
      scores.push(
        ...[...text.matchAll(/\bScore\s+`(\d+\s*\/\s*\d+)`/gi)].map(
          (m) => m[1],
        ),
      );
      scores = [scores.at(-1) || get("score")];
    } else if (!scores.length) scores = [get("score")];
    else if (get("score") && get("date") && !dates.includes(get("date")))
      scores.push(get("score"));
    const own: ReviewRecord[] = [];
    scores.forEach((value, i) => {
      const score = value.match(/(\d+)\s*\/\s*(\d+)/);
      if (!score) return;
      const record: ReviewRecord = {
        date: dates[i] || get("date"),
        num: +score[1],
        den: +score[2],
        topic: topics[i] || get("topic"),
        part: parts[i] || get("passage"),
        types: Array.isArray(fm.question_types)
          ? fm.question_types.map(bucketType)
          : [],
        skill: sk,
        file: file.path,
      };
      own.push(record);
      data.records.push(record);
    });
    const push = (type: string, c: number, t: number) => {
      const q = (data.qType[type] ??= { c: 0, t: 0, files: [] });
      q.c += c;
      q.t += t;
      if (!q.files.includes(file.path)) q.files.push(file.path);
    };
    let table = false,
      found = false,
      typeIdx = -1,
      markIdx = -1,
      myIdx = -1,
      ansIdx = -1;
    for (const line of text.split("\n")) {
      const row = line
        .replace(/\[\[([^\]]+)\]\]/g, (x) => x.replace(/\|/g, "\u0000"))
        .split("|")
        .map((x) => x.replace(/\u0000/g, "|").trim());
      if (line.startsWith("|") && /Type/i.test(line) && /[✅❌]/.test(line)) {
        typeIdx = row.findIndex((x) => /^Type/i.test(x));
        markIdx = row.findIndex((x) => x.includes("✅") && x.includes("❌"));
        myIdx = row.findIndex((x) => /My/i.test(x));
        ansIdx = row.findIndex((x) => /Correct|Ans/i.test(x));
        table = typeIdx > 0;
        continue;
      }
      if (!line.startsWith("|")) table = false;
      if (!table || /^\|\s*[:\-]/.test(line) || !row[typeIdx]) continue;
      const mark = row[markIdx] || "";
      const correct =
        mark.includes("✅") ||
        (!mark.includes("❌") &&
          myIdx > 0 &&
          ansIdx > 0 &&
          row[myIdx].toLowerCase() ===
            row[ansIdx].replace(/==/g, "").toLowerCase());
      push(bucketType(row[typeIdx]), correct ? 1 : 0, 1);
      found = true;
    }
    for (const r of own) {
      if (listening) push(r.part || "P?", r.num, r.den);
      else if (!found) for (const type of r.types) push(type, r.num, r.den);
    }
  }
  return data;
}
export function dayString(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
export function streak(dates: string[], now = new Date()): number {
  const set = new Set(dates);
  let offset = set.has(dayString(now)) ? 0 : -1,
    count = 0;
  for (; ; offset--) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    if (!set.has(dayString(d))) return count;
    count++;
  }
}
export function buildTrend(
  records: ReviewRecord[],
  days = 30,
  now = new Date(),
) {
  const points = Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() + i - days + 1);
    const date = dayString(d);
    const rows = records.filter((r) => r.date === date);
    const t = rows.reduce((s, r) => s + r.den, 0);
    return {
      date,
      value: t
        ? Math.round((rows.reduce((s, r) => s + r.num, 0) / t) * 100)
        : null,
      files: [...new Set(rows.map((r) => r.file))],
    };
  });
  const ma = points.map((_, i) => {
    const values = points
      .slice(Math.max(0, i - 6), i + 1)
      .flatMap((p) => (p.value === null ? [] : [p.value]));
    return values.length >= 2
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : null;
  });
  return { points, ma };
}
