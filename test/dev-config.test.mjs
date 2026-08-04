import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// dev.ts is bundled into the CLI rather than emitted as a standalone module.
// Build a temporary test-only entry so the persistence boundary can be driven
// directly without opening the interactive readline wizard.
const bundleRoot = mkdtempSync(join(tmpdir(), "tw-dev-config-bundle-"));
execFileSync(
  join(repositoryRoot, "node_modules", ".bin", "tsup"),
  ["src/dev.ts", "--format", "esm", "--target", "node20", "--out-dir", bundleRoot, "--splitting", "false"],
  { cwd: repositoryRoot, stdio: "ignore" },
);
const devModuleUrl = pathToFileURL(join(bundleRoot, "dev.js")).href;
const { persistInitialConfig } = await import(devModuleUrl);
const { acquireConfigFileLock, releaseConfigFileLock } = await import("../dist/hosts.js");

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function childResult(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("interactive config persistence atomically creates a private file", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-dev-config-create-"));
  const configPath = join(root, "nested", ".tmux-worktree.json");
  const raw = { projects: { app: "/repo/app" }, worktreeBase: "/worktrees" };

  const config = persistInitialConfig(raw, configPath);

  assert.equal(config.projects.app.path, "/repo/app");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), raw);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(join(root, "nested")).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("interactive config persistence aborts when config appears while prompting", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-dev-config-race-"));
  const configPath = join(root, ".tmux-worktree.json");
  const readyPath = join(root, "writer-ready");
  const lock = acquireConfigFileLock(`${configPath}.lock`);
  const competingConfig = {
    projects: { dashboard: "/repo/dashboard" },
    hosts: [{ id: "dev", host: "devbox" }],
  };

  const childScript = `
    import { writeFileSync } from "node:fs";
    const [{ persistInitialConfig }, configPath, readyPath] = await Promise.all([
      import(${JSON.stringify(devModuleUrl)}),
      Promise.resolve(process.argv.at(-2)),
      Promise.resolve(process.argv.at(-1)),
    ]);
    writeFileSync(readyPath, "ready");
    try {
      persistInitialConfig({ projects: { wizard: "/repo/wizard" } }, configPath);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(23);
    }
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", childScript, configPath, readyPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const completed = childResult(child);

  try {
    await waitForFile(readyPath);
    writeFileSync(configPath, `${JSON.stringify(competingConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } finally {
    releaseConfigFileLock(lock);
  }

  const result = await completed;
  assert.equal(result.status, 23, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /已由其他进程创建.*未覆盖/);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), competingConfig);
  assert.equal(existsSync(`${configPath}.lock`), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
});
