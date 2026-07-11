import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("release-facing package versions stay aligned", () => {
  const rootVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const appVersion = JSON.parse(readFileSync(new URL("../app/package.json", import.meta.url), "utf8")).version;
  const tauriVersion = JSON.parse(
    readFileSync(new URL("../app/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ).version;
  const cargo = readFileSync(new URL("../app/src-tauri/Cargo.toml", import.meta.url), "utf8");
  const android = readFileSync(new URL("../mobile/android/app/build.gradle.kts", import.meta.url), "utf8");
  const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
  const androidVersion = android.match(/versionName = "([^"]+)"/)?.[1];

  assert.deepEqual(
    { rootVersion, appVersion, tauriVersion, cargoVersion, androidVersion },
    {
      rootVersion,
      appVersion: rootVersion,
      tauriVersion: rootVersion,
      cargoVersion: rootVersion,
      androidVersion: rootVersion,
    },
  );
});

test("bundled CLI reports the package version without a runtime package.json", () => {
  execFileSync("npm", ["run", "build"], { stdio: "ignore" });
  const isolatedDir = mkdtempSync(join(tmpdir(), "tw-bundled-cli-version-"));
  const isolatedCli = join(isolatedDir, "cli.mjs");
  copyFileSync(cli, isolatedCli);
  const expectedVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;

  const result = spawnSync(process.execPath, [isolatedCli, "version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expectedVersion);
});

describe("tw update", () => {
  test("dry-run prints GitHub release update instructions", () => {
    execFileSync("npm", ["run", "build"], { stdio: "ignore" });

    const result = spawnSync(process.execPath, [cli, "update", "--dry-run"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /https:\/\/github\.com\/Sskift\/tmux-worktree\/releases\/latest/);
    assert.match(result.stdout, /git clone https:\/\/github\.com\/Sskift\/tmux-worktree\.git/);
    assert.doesNotMatch(result.stdout, /npm i -g/);
  });
});
