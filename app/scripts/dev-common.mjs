import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const appDir = path.resolve(__dirname, "..");
export const stateFiles = [
  ".tmux-worktree.json",
  ".tw-dashboard-layout.json",
  ".tw-dashboard-terminals.json",
  ".tw-dashboard-pending-worktree-cleanup.json",
  ".tw-serve-token",
];

export function prepareIsolatedDevApp(prefix = "tw-dashboard-dev") {
  const suffix = randomBytes(3).toString("hex");
  const productName = `${prefix}-${suffix}`;
  const identifier = `dev.warpdash.tw.dev.${suffix}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${productName}-`));
  const tempHome = path.join(tempRoot, "home");
  fs.mkdirSync(tempHome, { recursive: true });

  for (const name of stateFiles) {
    const src = path.join(os.homedir(), name);
    const dst = path.join(tempHome, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  return { suffix, productName, identifier, tempRoot, tempHome };
}

export function writeOverrideConfig(tempRoot, productName, identifier) {
  const overridePath = path.join(tempRoot, "tauri.dev.override.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify(
      {
        productName,
        identifier,
        app: {
          windows: [
            {
              title: `tmux-worktree (${productName})`,
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  return overridePath;
}

export function ensureNodeModules() {
  if (!fs.existsSync(path.join(appDir, "node_modules"))) {
    console.error("Missing app/node_modules. Run `cd app && npm install` first.");
    process.exit(1);
  }
}

export function printDevAppInfo({ productName, identifier, tempHome, overridePath, installPath }) {
  console.log(`productName: ${productName}`);
  console.log(`identifier: ${identifier}`);
  console.log(`isolated HOME: ${tempHome}`);
  console.log(`override config: ${overridePath}`);
  if (installPath) {
    console.log(`installed app: ${installPath}`);
  }
}
