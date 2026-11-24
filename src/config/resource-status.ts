import { promises as fs } from "node:fs";
import path from "node:path";
import { assertIsolatedPath } from "./machine-config";
export const databases = [
  "content.db",
  "vocabulary.db",
  "dictation.db",
  "learning-progress.db",
] as const;
/** 仅对已配置的显式数据根检查四库存在性，不打开或修改 SQLite 内容。 */
export async function resourceStatus(
  dataDir: string,
): Promise<{ name: string; present: boolean }[]> {
  assertIsolatedPath(dataDir);
  return Promise.all(
    databases.map(async (name) => {
      try {
        return {
          name,
          present: (await fs.stat(path.join(dataDir, name))).isFile(),
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return { name, present: false };
        throw e;
      }
    }),
  );
}
