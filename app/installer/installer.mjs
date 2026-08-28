#!/usr/bin/env node
// Downloads the Dashboard DMG from the GitHub Release matching this npm
// package, verifies its published SHA-256 and code-signing seal, then installs it.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import https from "node:https";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const APP_NAME = "tw-dashboard.app";
const BUNDLE_IDENTIFIER = "dev.warpdash.tw";
const INSTALL_DIR = "/Applications";
const RELEASE_REPOSITORY = "Sskift/tmux-worktree";
const MAX_CHECKSUM_BYTES = 64 * 1024;
const MAX_DMG_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const c = (code, value) => process.stdout.isTTY
  ? `\x1b[${code}m${value}\x1b[0m`
  : value;
const dim = (value) => c(2, value);
const green = (value) => c(32, value);
const red = (value) => c(31, value);
const info = (value) => console.log(`${dim("·")} ${value}`);
const ok = (value) => console.log(`${green("✓")} ${value}`);

const validateReleaseUrl = (value) => {
  const url = value instanceof URL ? value : new URL(value);
  const githubHost = url.hostname === "github.com" ||
    url.hostname.endsWith(".githubusercontent.com");
  if (
    url.protocol !== "https:" ||
    !githubHost ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error(`refusing unsafe release URL: ${url.href}`);
  }
  return url;
};

const getHttpsResponse = (value, redirects = 0) => new Promise((resolveResponse, reject) => {
  const url = validateReleaseUrl(value);
  const request = https.get(url, {
    headers: {
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
      "User-Agent": "tw-dashboard-installer",
    },
  }, (response) => {
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) {
        reject(new Error(`too many redirects while downloading ${url.href}`));
        return;
      }
      let redirected;
      try {
        redirected = validateReleaseUrl(new URL(response.headers.location, url));
      } catch (error) {
        reject(error);
        return;
      }
      getHttpsResponse(redirected, redirects + 1).then(resolveResponse, reject);
      return;
    }
    if (status !== 200) {
      response.resume();
      reject(new Error(`GitHub returned HTTP ${status} for ${url.href}`));
      return;
    }
    resolveResponse(response);
  });
  request.on("error", reject);
  request.setTimeout(30_000, () => {
    request.destroy(new Error(`timed out downloading ${url.href}`));
  });
});

const readHttpsText = async (url) => {
  const response = await getHttpsResponse(url);
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_CHECKSUM_BYTES) {
      response.destroy();
      throw new Error("release checksum file exceeds the size limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const downloadAndHash = async (url, destination) => {
  const response = await getHttpsResponse(url);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_DMG_BYTES) {
        callback(new Error("release DMG exceeds the size limit"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    response,
    meter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (size === 0) throw new Error("downloaded release DMG is empty");
  return hash.digest("hex");
};

export const parseChecksumFile = (contents, assetName) => {
  const lines = contents.trim().split(/\r?\n/);
  if (lines.length !== 1) {
    throw new Error("release checksum must contain exactly one entry");
  }
  const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(lines[0]);
  if (!match || match[2] !== assetName) {
    throw new Error(`release checksum does not name ${assetName}`);
  }
  return match[1].toLowerCase();
};

export const releaseDownloadPlan = ({ version, arch }) => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`npm package has an invalid release version: ${version}`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`unsupported CPU arch: ${arch}`);
  }
  const assetName = `tw-dashboard-${version}-${arch}.dmg`;
  const tag = `v${version}`;
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/` +
    `${encodeURIComponent(tag)}/${assetName}`;
  return {
    assetName,
    checksumName: `${assetName}.sha256`,
    checksumUrl: `${base}.sha256`,
    dmgUrl: base,
    tag,
  };
};

const readPackageVersion = () => {
  const manifestPath = new URL("../../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@byted-codebase/tmux-worktree") {
    throw new Error("installer is not inside the canonical tmux-worktree npm package");
  }
  return manifest.version;
};

const verifyAppBundle = (appPath, expectedVersion) => {
  const signature = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", appPath],
    { encoding: "utf8" },
  );
  if (signature.status !== 0) {
    throw new Error(`downloaded app signature is invalid: ${signature.stderr.trim()}`);
  }
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const identifier = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", infoPlist],
    { encoding: "utf8" },
  ).trim();
  const version = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleShortVersionString", "raw", infoPlist],
    { encoding: "utf8" },
  ).trim();
  if (identifier !== BUNDLE_IDENTIFIER) {
    throw new Error(`downloaded app has unexpected bundle identifier: ${identifier}`);
  }
  if (version !== expectedVersion) {
    throw new Error(`downloaded app version ${version} does not match npm ${expectedVersion}`);
  }
};

export const main = async () => {
  if (process.platform !== "darwin") {
    throw new Error(`tw-dashboard only supports macOS. Detected: ${process.platform}`);
  }
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!arch) throw new Error(`unsupported CPU arch: ${process.arch}`);

  const version = readPackageVersion();
  const plan = releaseDownloadPlan({ version, arch });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tw-dashboard-install-"));
  const dmgPath = join(temporaryDirectory, plan.assetName);
  let mountPoint = null;
  const cleanupMount = () => {
    if (!mountPoint) return;
    spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
    mountPoint = null;
  };
  const cleanup = () => {
    cleanupMount();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  };
  const interrupt = () => {
    cleanup();
    process.exit(130);
  };
  const terminate = () => {
    cleanup();
    process.exit(143);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    info(`downloading ${plan.assetName} from GitHub Release ${plan.tag}`);
    const expectedHash = parseChecksumFile(
      await readHttpsText(plan.checksumUrl),
      plan.assetName,
    );
    const actualHash = await downloadAndHash(plan.dmgUrl, dmgPath);
    if (!timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"))) {
      throw new Error("downloaded DMG does not match the published SHA-256");
    }
    ok(`verified SHA-256 ${actualHash}`);

    info(`mounting ${plan.assetName}`);
    const output = execFileSync("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      dmgPath,
    ], { encoding: "utf8" });
    for (const line of output.split("\n")) {
      const match = line.match(/(\/Volumes\/[^\t\n]+)\s*$/);
      if (match) {
        mountPoint = match[1].trim();
        break;
      }
    }
    if (!mountPoint) throw new Error("could not determine the DMG mount point");

    const sourceApp = join(mountPoint, APP_NAME);
    if (!existsSync(sourceApp)) throw new Error(`${APP_NAME} not found in DMG`);
    verifyAppBundle(sourceApp, version);
    // codesign verifies the sealed bundle's integrity, not the signer's public
    // identity. HTTPS plus the checksum bind this install to the exact assets
    // on the versioned GitHub release; there is no stable public Team ID to pin.
    ok("verified app code-signing seal, identifier, and version");

    const destinationApp = join(INSTALL_DIR, APP_NAME);
    if (existsSync(destinationApp)) {
      info(`removing existing ${destinationApp}`);
      const remove = spawnSync("rm", ["-rf", destinationApp]);
      if (remove.status !== 0) {
        throw new Error(`failed to remove existing app — try: sudo rm -rf "${destinationApp}"`);
      }
    }

    info(`copying to ${INSTALL_DIR}`);
    const copy = spawnSync("ditto", [sourceApp, destinationApp], { stdio: "inherit" });
    if (copy.status !== 0) throw new Error("ditto failed");
    verifyAppBundle(destinationApp, version);

    ok(`installed to ${destinationApp}`);
    console.log("\n  Launch:  open -a tw-dashboard\n");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    cleanup();
  }
};

const directExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (directExecution) {
  main().catch((error) => {
    console.error(`${red("✗")} ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
