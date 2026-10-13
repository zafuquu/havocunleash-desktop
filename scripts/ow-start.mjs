// Launches the desktop app under the Overwolf-patched Electron binary.
//
// REAL GEP REQUIREMENT: Valorant game-events only flow when this binary is
// launched by the Overwolf client (or with Overwolf running + the app
// registered as a partner app with Valorant GEP access). Until then this
// launcher runs the app with HAVOC_SOURCE=overwolf and the runtime
// reports `capabilities.overwolf.state` on its /health endpoint so you can
// see whether GEP actually bound.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const owBin = path.join(
  root,
  "node_modules",
  "@overwolf",
  "ow-electron",
  "dist",
  (readFileSync(path.join(root, "node_modules", "@overwolf", "ow-electron", "path.txt"), "utf8") || "electron.exe").trim(),
);

if (!existsSync(owBin)) {
  console.error("[ow-start] ow-electron binary missing — run `npm run ow:install` first.");
  process.exit(1);
}

console.log("[ow-start] launching under Overwolf-patched Electron:", owBin);
const child = spawn(
  owBin,
  ["."],
  {
    cwd: path.join(root, "apps", "desktop"),
    stdio: "inherit",
    env: {
      ...process.env,
      HAVOC_SOURCE: "overwolf",
      ELECTRON_RUN_AS_NODE: "",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 0));