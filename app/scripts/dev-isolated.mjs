#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  appDir,
  ensureNodeModules,
  prepareIsolatedDevApp,
  printDevAppInfo,
  writeOverrideConfig,
} from "./dev-common.mjs";

const shell = process.env.SHELL || "/bin/zsh";

function usage() {
  console.log(`Usage: npm run tauri:dev:isolated [-- [tauri dev args...]]

Starts a Tauri dev app with:
- isolated dashboard state under a temporary TW_DASHBOARD_HOME
- unique productName / identifier so it won't conflict with installed tw-dashboard

Extra args after -- are passed through to tauri dev.`);
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

const wrapperPath = path.join(isolated.tempRoot, "inherit-shell.sh");
fs.writeFileSync(
  wrapperPath,
  `#!/bin/sh
REAL_SHELL=${JSON.stringify(shell)}
TEMP_HOME=${JSON.stringify(isolated.tempHome)}
export TEMP_HOME
if [ "$1" = "-l" ] && [ "$2" = "-c" ] && [ "$3" = "env -0" ]; then
  exec "$REAL_SHELL" -l -c 'HOME="$TEMP_HOME" env -0'
fi
exec "$REAL_SHELL" "$@"
`,
  { mode: 0o755 },
);

printDevAppInfo({
  productName: isolated.productName,
  identifier: isolated.identifier,
  tempHome: isolated.tempHome,
  overridePath,
});

const child = spawn(
  "npx",
  ["tauri", "dev", "--config", overridePath, ...args],
  {
    cwd: appDir,
    stdio: "inherit",
    env: {
      ...process.env,
      SHELL: wrapperPath,
      TW_DASHBOARD_HOME: isolated.tempHome,
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
