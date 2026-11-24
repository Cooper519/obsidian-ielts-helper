import { build } from "esbuild";
import { builtinModules } from "node:module";
// 仅宿主和 Node 内置模块保留外部引用；ZIP 库随插件打包。
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((x) => "node:" + x),
  ],
  metafile: true,
}).then(async (result) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile("build-meta.json", JSON.stringify(result.metafile, null, 2));
});
