import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const {
  buildAutomationRecord,
  parseAutomationCreateArgs,
  resolveAutomationTarget,
} = await import("../dist/automation.js");

const NOW = "2026-06-11T02:00:00Z";

test("parseAutomationCreateArgs reads create flags and aliases", () => {
  const parsed = parseAutomationCreateArgs([
    "--name",
    "Nightly fix",
    "--instruction=Fix the flaky auth test",
    "--cmd",
    "codex",
    "--project",
    "web",
    "--schedule",
    "0 9 * * 1-5",
    "--timezone",
    "Asia/Shanghai",
    "--overlap",
    "skip",
    "--disabled",
  ]);

  assert.deepEqual(parsed, {
    name: "Nightly fix",
    instruction: "Fix the flaky auth test",
    aiCmd: "codex",
    project: "web",
    path: undefined,
    schedule: "0 9 * * 1-5",
    timezone: "Asia/Shanghai",
    overlap: "skip",
    enabled: false,
  });
});

test("resolveAutomationTarget validates explicit projects and infers from cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-auto-target-"));
  const repo = join(root, "web");
  const nested = join(repo, "packages", "ui");
  const other = join(root, "scratch");
  const config = {
    projects: {
      web: { name: "web", path: repo },
    },
  };

  assert.deepEqual(
    resolveAutomationTarget({ project: "web" }, config, other),
    { project: "web", path: null },
  );
  assert.deepEqual(
    resolveAutomationTarget({}, config, nested),
    { project: "web", path: null },
  );
  assert.deepEqual(
    resolveAutomationTarget({}, config, other),
    { project: null, path: other },
  );
  assert.throws(
    () => resolveAutomationTarget({ project: "missing" }, config, other),
    /project 'missing' not in ~\/.tmux-worktree.json/,
  );
});

test("buildAutomationRecord writes the App/Rust JSON contract", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-auto-record-"));
  const repo = join(root, "repo");
  const config = {
    projects: {
      repo: { name: "repo", path: repo },
    },
  };
  const parsed = parseAutomationCreateArgs([
    "--instruction",
    "Review the branch and summarize risks",
    "--cmd",
    "claude",
    "--schedule",
    "30 8 * * 1-5",
    "--timezone",
    "Asia/Shanghai",
    "--overlap",
    "queue",
  ]);

  const record = buildAutomationRecord(parsed, {
    config,
    cwd: join(repo, "src"),
    id: () => "auto-test123456",
    now: () => NOW,
  });

  assert.deepEqual(record, {
    id: "auto-test123456",
    name: "Review the branch and summarize risks",
    enabled: true,
    triggerType: "schedule",
    schedule: "30 8 * * 1-5",
    timezone: "Asia/Shanghai",
    project: "repo",
    path: null,
    aiCmd: "claude",
    instruction: "Review the branch and summarize risks",
    overlap: "queue",
    lastRunAt: null,
    lastStatus: "idle",
    lastSession: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
});
