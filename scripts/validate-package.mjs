#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);

const fail = (message) => {
  console.error(`package validation failed: ${message}`);
  process.exit(1);
};

const requiredFiles = new Set([
  "package.json",
  "dist/cli.cjs",
  "app/installer/installer.mjs",
  "dist/relay/v2/brokerShippingRoot.js",
  "dist/relay/v2/brokerShippingDeploymentSource.js",
  "dist/relay/v2/hostRuntimeComposition.js",
  "dist/relay/v2/hostCanonicalProductionComposition.js",
  "dist/relay/v2/hostShippingRoot.js",
  "dist/relay/v2/hostShippingDeploymentSource.js",
  "dist/relay/v2/relayV2DashboardManagementChildRuntime.js",
]);

for (const [name, relativePath] of Object.entries(manifest.bin ?? {})) {
  if (typeof relativePath !== "string" || relativePath.startsWith("/") || relativePath.includes("..")) {
    fail(`bin ${name} has an unsafe path: ${String(relativePath)}`);
  }
  const stat = lstatSync(resolve(repositoryRoot, relativePath), { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(`bin ${name} is not a built regular file: ${relativePath}`);
  }
  requiredFiles.add(relativePath);
}

const cli = readFileSync(resolve(repositoryRoot, "dist/cli.cjs"), "utf8");
if (!cli.startsWith("#!/usr/bin/env node\n") || cli.length < 1_000) {
  fail("dist/cli.cjs is missing, truncated, or lacks its Node shebang");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pack = spawnSync(
  npmCommand,
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (pack.status !== 0) {
  fail(`npm pack --dry-run failed:\n${pack.stderr || pack.stdout}`);
}

let report;
try {
  [report] = JSON.parse(pack.stdout);
} catch {
  fail(`npm pack returned invalid JSON:\n${pack.stdout}`);
}
const packedFiles = new Set((report?.files ?? []).map(({ path }) => path));
for (const relativePath of requiredFiles) {
  if (!packedFiles.has(relativePath)) {
    fail(`tarball is missing required artifact: ${relativePath}`);
  }
}

const forbidden = [...packedFiles].filter((relativePath) =>
  relativePath.endsWith(".dmg") ||
  relativePath.includes("/installer/dmg/") ||
  relativePath.includes("/node_modules/") ||
  relativePath.includes("/src-tauri/target/")
);
if (forbidden.length > 0) {
  fail(`tarball contains release-only or build-tree files: ${forbidden.join(", ")}`);
}

console.log(
  `package validation passed: ${report.name}@${report.version}, ` +
    `${report.files.length} files, ${report.size} packed bytes, no DMG`,
);
