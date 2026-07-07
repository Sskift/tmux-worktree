import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("tw update", () => {
  test("dry-run prints CLI and Dashboard update commands", () => {
    execFileSync("npm", ["run", "build"], { stdio: "ignore" });

    const result = spawnSync(process.execPath, [cli, "update", "--dry-run"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /npm i -g tmux-worktree@latest --registry=https:\/\/registry\.npmjs\.org/,
    );
    assert.match(result.stdout, /tw-dashboard-install/);
  });
});
