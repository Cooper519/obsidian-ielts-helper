export interface Point {
  label: string;
  value: number | null;
  files: string[];
}
/** 主题色取自当前专属容器；点击区域按实际 CSS 尺寸映射，不修改宿主。 */
export function drawChart(
  canvas: HTMLCanvasElement,
  points: Point[],
  kind: "pie" | "bar" | "line",
  open: (files: string[], event: MouseEvent) => void,
  ma: (number | null)[] = [],
): void {
  const width = 620,
    height = 280,
    dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(canvas);
  const color = (key: string) => css.getPropertyValue(key).trim() || css.color;
  const colors = [
    "--interactive-accent",
    "--text-success",
    "--text-warning",
    "--text-error",
    "--text-accent",
  ].map(color);
  ctx.font = "12px sans-serif";
  ctx.fillStyle = color("--text-muted");
  const regions: { hit: (x: number, y: number) => boolean; files: string[] }[] =
    [];
  if (!points.some((p) => p.value !== null)) {
    ctx.fillText("暂无学习记录", 24, 48);
    return;
  }
  if (kind === "pie") {
    const total = points.reduce((s, p) => s + (p.value || 0), 0);
    if (!total) {
      ctx.fillText("暂无错因标签", 24, 48);
      return;
    }
    let angle = -Math.PI / 2;
    points.forEach((p, i) => {
      const a = angle,
        b = a + ((p.value || 0) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(140, 140);
      ctx.arc(140, 140, 105, a, b);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      ctx.fillRect(290, 32 + i * 32, 10, 10);
      ctx.fillStyle = color("--text-normal");
      ctx.fillText(`${p.label} · ${p.value}`, 310, 42 + i * 32);
      regions.push({
        files: p.files,
        hit: (x, y) => {
          let t = Math.atan2(y - 140, x - 140);
          while (t < a) t += Math.PI * 2;
          return Math.hypot(x - 140, y - 140) <= 105 && t <= b;
        },
      });
      angle = b;
    });
  } else if (kind === "bar") {
    const row = Math.min(35, 230 / Math.max(points.length, 1));
    points.forEach((p, i) => {
      const y = 24 + i * row;
      ctx.fillStyle = color("--text-normal");
      ctx.fillText(p.label, 8, y + 13);
      ctx.fillStyle = colors[0];
      ctx.fillRect(130, y, Math.max(1, (p.value || 0) * 3.6), 18);
      ctx.fillStyle = color("--text-normal");
      ctx.fillText(`${p.value ?? "—"}%`, 500, y + 13);
      regions.push({
        files: p.files,
        hit: (x, yy) => x >= 0 && x <= width && yy >= y && yy <= y + row,
      });
    });
  } else {
    const x = (i: number) => 42 + (i / Math.max(1, points.length - 1)) * 550,
      y = (v: number) => 240 - v * 2;
    ctx.strokeStyle = color("--background-modifier-border");
    for (let v = 0; v <= 100; v += 25) {
      ctx.beginPath();
      ctx.moveTo(40, y(v));
      ctx.lineTo(600, y(v));
      ctx.stroke();
      ctx.fillStyle = color("--text-muted");
      ctx.fillText(String(v), 8, y(v));
    }
    const series = (values: (number | null)[], stroke: string) => {
      ctx.beginPath();
      ctx.strokeStyle = stroke;
      let began = false;
      values.forEach((v, i) => {
        if (v === null) return;
        if (!began) {
          ctx.moveTo(x(i), y(v));
          began = true;
        } else ctx.lineTo(x(i), y(v));
      });
      ctx.stroke();
    };
    series(
      points.map((p) => p.value),
      colors[0],
    );
    series(ma, colors[2]);
    points.forEach((p, i) => {
      if (p.value === null) return;
      ctx.fillStyle = colors[0];
      ctx.beginPath();
      ctx.arc(x(i), y(p.value), 3, 0, Math.PI * 2);
      ctx.fill();
      regions.push({
        files: p.files,
        hit: (xx, yy) => Math.hypot(xx - x(i), yy - y(p.value!)) < 10,
      });
      if (i % 5 === 0) {
        ctx.fillStyle = color("--text-muted");
        ctx.fillText(p.label.slice(5), x(i) - 12, 266);
      }
    });
  }
  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * width) / rect.width,
      y = ((event.clientY - rect.top) * height) / rect.height;
    const hit = regions.find((r) => r.hit(x, y));
    if (hit?.files.length) open(hit.files, event);
  };
}
