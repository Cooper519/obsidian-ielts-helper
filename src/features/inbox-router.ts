export interface StudyDay {
  day: number;
  topics: { id: string; label: string }[];
}
/** 保持旧语义：首个未完成 Day，全完成时选最后一天；显式操作仅路由到首个 Topic。 */
export function parseStudyPlan(text: string): StudyDay | undefined {
  let first: StudyDay | undefined, last: StudyDay | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (!m) continue;
    const topics: StudyDay["topics"] = [];
    const add = (id: string, label: string) => {
      id = id.toUpperCase();
      if (!topics.some((t) => t.id === id)) topics.push({ id, label });
    };
    for (const t of line.matchAll(
      /\[\[Topics\/([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    )) {
      const id = (t[2] || t[1]).match(/T\d{2}/i)?.[0];
      if (id) add(id, t[2] || id);
    }
    for (const t of line
      .replace(/\[\[[^\]]+\]\]/g, "")
      .matchAll(/\bT\d{2}\b/gi))
      add(t[0], t[0]);
    last = { day: Number(m[1]), topics };
    if (!/\|\s*✅\s*\|\s*$/.test(line) && !first) first = last;
  }
  return first || last;
}
