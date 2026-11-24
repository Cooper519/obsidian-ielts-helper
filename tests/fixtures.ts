import path from "node:path";
import type { MachineProfile } from "../src/types";
export function profile(root: string): MachineProfile {
  return {
    vaultRoot: path.join(root, "vault"),
    studyRoot: path.join(root, "vault/0-IELTS"),
    appRoot: path.join(root, "app"),
    dataDir: path.join(root, "data"),
    pythonPath: "python",
    port: 18766,
    openBrowserOnStart: false,
    autoUpgradePlugin: false,
    updateSource: { mode: "local" },
  };
}
