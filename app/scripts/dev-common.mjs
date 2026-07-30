import { createHash, randomBytes } from "node:crypto";
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
  ".tw-dashboard-automations.json",
  ".tw-dashboard-automation-runs.json",
  ".tw-dashboard-pending-worktree-cleanup.json",
  ".tw-serve-token",
];

const UNIX_SOCKET_PATH_MAX_BYTES = 100;
const DASHBOARD_CONFIG_FILE = ".tmux-worktree.json";
const OPENSSH_CONTROL_HASH_PROBE = "c".repeat(40);
const OPENSSH_TEMP_SUFFIX_PROBE = "r".repeat(16);

function currentUnixIdentity() {
  if (
    typeof process.getuid !== "function"
    || typeof process.getgid !== "function"
  ) {
    return null;
  }
  return Object.freeze({ uid: process.getuid(), gid: process.getgid() });
}

function secureIsolatedDirectory(directoryPath, unixIdentity) {
  if (unixIdentity !== null) {
    fs.chownSync(directoryPath, unixIdentity.uid, unixIdentity.gid);
  }
  fs.chmodSync(directoryPath, 0o700);
}

function isolatedDevSocketPaths(tempHome, tmuxTmpDir) {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  const tmux = path.join(tmuxTmpDir, `tmux-${uid}`, "default");
  const terminalControl = path.join(
    tempHome,
    ".tmux-worktree",
    "terminal-control-v1.sock",
  );
  // Validation-only projection of the shipping identity; it never selects or binds the socket.
  const exactDigest = createHash("sha256")
    .update(terminalControl, "utf8")
    .digest("hex")
    .slice(0, 16);
  const relayV2ExactCompound = path.join(
    path.dirname(terminalControl),
    `.relay-v2-exact-${exactDigest}.sock`,
  );
  return Object.freeze({ tmux, terminalControl, relayV2ExactCompound });
}

function isolatedDevSshControlPaths(tempHome) {
  // Preserve the shipping ~/.tmux-worktree/ssh/%C identity while projecting
  // OpenSSH's expanded hash and first-bind random suffix into the dev preflight.
  const template = path.join(tempHome, ".tmux-worktree", "ssh", "%C");
  const temporaryBind = `${
    template.replace("%C", OPENSSH_CONTROL_HASH_PROBE)
  }.${OPENSSH_TEMP_SUFFIX_PROBE}`;
  return Object.freeze({ template, temporaryBind });
}

function requireIsolatedDevSocketPathsFit(socketPaths) {
  for (const [label, socketPath] of Object.entries(socketPaths)) {
    const bytes = Buffer.byteLength(socketPath, "utf8");
    if (bytes > UNIX_SOCKET_PATH_MAX_BYTES) {
      throw new Error(
        `isolated ${label} socket path is ${bytes} UTF-8 bytes `
          + `(maximum ${UNIX_SOCKET_PATH_MAX_BYTES}): ${socketPath}`,
      );
    }
  }
}

function copyIsolatedStateFile(name, src, dst) {
  if (name !== DASHBOARD_CONFIG_FILE) {
    fs.copyFileSync(src, dst);
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(src, "utf8"));
  } catch {
    throw new Error("isolated Dashboard config must be a valid top-level JSON object");
  }
  if (
    config === null
    || typeof config !== "object"
    || Array.isArray(config)
    || Object.getPrototypeOf(config) !== Object.prototype
  ) {
    throw new Error("isolated Dashboard config must be a valid top-level JSON object");
  }

  delete config.feishuBridge;
  delete config.mobileRelay;
  fs.writeFileSync(dst, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.chmodSync(dst, 0o600);
}

export function prepareIsolatedDevApp(prefix = "tw-dashboard-dev") {
  const suffix = randomBytes(3).toString("hex");
  const productName = `${prefix}-${suffix}`;
  const identifier = `dev.warpdash.tw.dev.${suffix}`;
  const tempParent = fs.realpathSync.native("/tmp");
  const tempRoot = fs.mkdtempSync(path.join(tempParent, "w-"));
  try {
    const unixIdentity = currentUnixIdentity();
    secureIsolatedDirectory(tempRoot, unixIdentity);
    const metadata = fs.lstatSync(tempRoot);
    if (
      fs.realpathSync.native(tempRoot) !== tempRoot
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (metadata.mode & 0o777) !== 0o700
      || (
        unixIdentity !== null
        && (
          metadata.uid !== unixIdentity.uid
          || metadata.gid !== unixIdentity.gid
        )
      )
    ) {
      throw new Error(`isolated temp root is not canonical owner-only storage: ${tempRoot}`);
    }

    const tempHome = path.join(tempRoot, "h");
    const tmuxTmpDir = tempRoot;
    fs.mkdirSync(tempHome, { mode: 0o700 });
    secureIsolatedDirectory(tempHome, unixIdentity);
    const privateHome = path.join(tempHome, ".tmux-worktree");
    fs.mkdirSync(privateHome, { mode: 0o700 });
    secureIsolatedDirectory(privateHome, unixIdentity);
    const socketPaths = isolatedDevSocketPaths(tempHome, tmuxTmpDir);
    const sshControlPaths = isolatedDevSshControlPaths(tempHome);
    requireIsolatedDevSocketPathsFit({
      ...socketPaths,
      sshControlTemporaryBind: sshControlPaths.temporaryBind,
    });

    for (const name of stateFiles) {
      const src = path.join(os.homedir(), name);
      const dst = path.join(tempHome, name);
      if (fs.existsSync(src)) {
        copyIsolatedStateFile(name, src, dst);
      }
    }

    return {
      suffix,
      productName,
      identifier,
      tempRoot,
      tempHome,
      tmuxTmpDir,
      socketPaths,
      sshControlPaths,
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function isolatedRuntimeEnv(isolated, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    TW_DASHBOARD_HOME: isolated.tempHome,
    TMUX_TMPDIR: isolated.tmuxTmpDir,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TW_TERMINAL_CONTROL_SOCKET;
  delete env.TW_TERMINAL_CONTROL_STATE;
  delete env.TW_TERMINAL_CONTROL_OUTPUT_DIR;
  return env;
}

export function isolatedLauncherScript(isolated) {
  return `#!/bin/sh
export TW_DASHBOARD_HOME=${JSON.stringify(isolated.tempHome)}
export TMUX_TMPDIR=${JSON.stringify(isolated.tmuxTmpDir)}
unset TMUX TMUX_PANE TW_TERMINAL_CONTROL_SOCKET TW_TERMINAL_CONTROL_STATE TW_TERMINAL_CONTROL_OUTPUT_DIR
exec "$(dirname "$0")/app-real" "$@"
`;
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

export function printDevAppInfo({
  productName,
  identifier,
  tempHome,
  tmuxTmpDir,
  overridePath,
  installPath,
}) {
  console.log(`productName: ${productName}`);
  console.log(`identifier: ${identifier}`);
  console.log(`isolated HOME: ${tempHome}`);
  console.log(`isolated TMUX_TMPDIR: ${tmuxTmpDir}`);
  console.log(`override config: ${overridePath}`);
  if (installPath) {
    console.log(`installed app: ${installPath}`);
  }
}
