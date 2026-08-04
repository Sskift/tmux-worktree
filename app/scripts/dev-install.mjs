#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  appDir,
  ensureNodeModules,
  prepareIsolatedDevApp,
  printDevAppInfo,
  writeOverrideConfig,
} from "./dev-common.mjs";

function usage() {
  console.log(`Usage: npm run tauri:dev:install [-- [tauri build args...]]

Builds and installs a uniquely named debug app bundle with:
- isolated dashboard state under a temporary TW_DASHBOARD_HOME
- unique productName / identifier so it won't conflict with installed tw-dashboard
- a launcher wrapper inside the bundle so Finder/open keeps using the isolated state

Extra args after -- are passed through to tauri build.`);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

ensureNodeModules();

const isolated = prepareIsolatedDevApp();
const overridePath = writeOverrideConfig(
  isolated.tempRoot,
  isolated.productName,
  isolated.identifier,
);
const builtAppPath = path.join(
  appDir,
  "src-tauri",
  "target",
  "debug",
  "bundle",
  "macos",
  `${isolated.productName}.app`,
);
const installPath = path.join("/Applications", `${isolated.productName}.app`);

printDevAppInfo({
  productName: isolated.productName,
  identifier: isolated.identifier,
  tempHome: isolated.tempHome,
  overridePath,
  installPath,
});

const build = spawnSync(
  "npx",
  ["tauri", "build", "--debug", "--config", overridePath, ...args],
  {
    cwd: appDir,
    stdio: "inherit",
    env: {
      ...process.env,
      TW_DASHBOARD_HOME: isolated.tempHome,
    },
  },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!fs.existsSync(builtAppPath)) {
  console.error(`Built app not found: ${builtAppPath}`);
  process.exit(1);
}

fs.rmSync(installPath, { recursive: true, force: true });
fs.cpSync(builtAppPath, installPath, { recursive: true });

const macosDir = path.join(installPath, "Contents", "MacOS");
const launcherPath = path.join(macosDir, "app");
const realBinaryPath = path.join(macosDir, "app-real");
fs.renameSync(launcherPath, realBinaryPath);
fs.writeFileSync(
  launcherPath,
  `#!/bin/sh
export TW_DASHBOARD_HOME=${JSON.stringify(isolated.tempHome)}
exec "$(dirname "$0")/app-real" "$@"
`,
  { mode: 0o755 },
);

const openResult = spawnSync("open", ["-n", "-a", installPath], {
  stdio: "inherit",
});
if (openResult.status !== 0) {
  process.exit(openResult.status ?? 1);
}

console.log(`uninstall: rm -rf ${JSON.stringify(installPath)}`);
console.log(`cleanup state: rm -rf ${JSON.stringify(isolated.tempRoot)}`);
