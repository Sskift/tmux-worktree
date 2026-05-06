#!/usr/bin/env node
// tw-dashboard installer. Mounts the bundled dmg, copies to /Applications,
// strips the macOS quarantine attribute, and prints the launch command.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "tw-dashboard.app";
const INSTALL_DIR = "/Applications";

const c = (code, s) => process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const info = (s) => console.log(`${dim("·")} ${s}`);
const ok = (s) => console.log(`${green("✓")} ${s}`);
const die = (s) => { console.error(`${red("✗")} ${s}`); process.exit(1); };

if (process.platform !== "darwin") {
  die(`tw-dashboard only supports macOS. Detected: ${process.platform}`);
}

const archMap = { arm64: "arm64", x64: "x64" };
const arch = archMap[process.arch];
if (!arch) die(`Unsupported CPU arch: ${process.arch}`);

const dmgDir = join(__dirname, "dmg");
const dmgPath = join(dmgDir, `tw-dashboard-${arch}.dmg`);
if (!existsSync(dmgPath)) {
  const available = existsSync(dmgDir)
    ? readdirSync(dmgDir).filter((f) => f.endsWith(".dmg"))
    : [];
  die(
    `No build for ${arch} in this release.\n` +
      `  Available: ${available.length ? available.join(", ") : "(none)"}\n` +
      `  Ping the maintainer to publish a ${arch} build.`,
  );
}

let mountPoint = null;
const cleanup = () => {
  if (mountPoint) {
    spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
    mountPoint = null;
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  info(`mounting ${dmgPath}`);
  const out = execFileSync("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    dmgPath,
  ]).toString();
  for (const line of out.split("\n")) {
    const m = line.match(/(\/Volumes\/[^\t\n]+)\s*$/);
    if (m) { mountPoint = m[1].trim(); break; }
  }
  if (!mountPoint) die("could not determine mount point");

  const srcApp = join(mountPoint, APP_NAME);
  if (!existsSync(srcApp)) die(`${APP_NAME} not found in dmg`);

  const dstApp = join(INSTALL_DIR, APP_NAME);
  if (existsSync(dstApp)) {
    info(`removing existing ${dstApp}`);
    const r = spawnSync("rm", ["-rf", dstApp]);
    if (r.status !== 0) {
      die(`failed to remove existing app — try: sudo rm -rf "${dstApp}"`);
    }
  }

  info(`copying to ${INSTALL_DIR}`);
  const r = spawnSync("ditto", [srcApp, dstApp], { stdio: "inherit" });
  if (r.status !== 0) die("ditto failed");

  info("removing macOS quarantine attribute");
  spawnSync("xattr", ["-dr", "com.apple.quarantine", dstApp], { stdio: "ignore" });

  ok(`installed to ${dstApp}`);
  console.log("");
  console.log("  Launch:  open -a tw-dashboard");
  console.log("  Or just double-click it in Finder.");
  console.log("");
} catch (err) {
  die(err && err.message ? err.message : String(err));
}
