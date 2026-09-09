import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./support/tmpDirs.mjs";

const {
  automationStatePath,
  buildAutomationRecord,
  parseAutomationCreateArgs,
  readAutomations,
  resolveAutomationTarget,
} = await import("../dist/automation.js");
const { sweepStateFileArtifacts } = await import("../dist/stateFileArtifacts.js");

const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));

function runCli(home, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 20_000,
  });
}

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
  const root = tmpDir("tw-auto-target-");
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
  const root = tmpDir("tw-auto-record-");
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

test("concurrent `tw automation create` across processes keeps every record (C051/D038)", async () => {
  const root = tmpDir("tw-auto-concurrent-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  // Seed a wide state file so each read-modify-write window is long enough
  // for several independent CLI processes to overlap on the old, unlocked
  // implementation.
  const seedCount = 2000;
  const seed = Array.from({ length: seedCount }, (_, index) => ({
    id: `auto-seed-${index}`,
    name: `Seed ${index}`,
    enabled: true,
    triggerType: "manual",
    schedule: null,
    timezone: null,
    project: null,
    path: home,
    aiCmd: "claude",
    instruction: `seed task ${index}`,
    overlap: "queue",
    lastRunAt: null,
    lastStatus: "idle",
    lastSession: null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  writeFileSync(automationStatePath(home), `${JSON.stringify(seed, null, 2)}\n`);

  const creators = 8;
  const children = Array.from({ length: creators }, (_, index) =>
    spawn(
      process.execPath,
      [cli, "automation", "create", "--instruction", `concurrent task ${index}`],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    ),
  );
  const results = await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("exit", (code) => resolve({ code, stderr }));
        }),
    ),
  );

  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, `creator ${index} failed: ${result.stderr}`);
  }

  const finalRecords = readAutomations(automationStatePath(home));
  const createdNames = new Set(
    finalRecords
      .map((record) => record.instruction)
      .filter((name) => name.startsWith("concurrent task ")),
  );
  assert.equal(
    finalRecords.length,
    seedCount + creators,
    `lost update: expected ${seedCount + creators} records, found ${finalRecords.length}`,
  );
  assert.equal(createdNames.size, creators, `a concurrent create vanished: ${[...createdNames]}`);
});

test("torn automations file is quarantined and commands recover (D001)", () => {
  const root = tmpDir("tw-auto-corrupt-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const path = automationStatePath(home);

  // Half-written JSON, as left by a non-atomic write interrupted mid-flush.
  writeFileSync(path, '[{"id":"auto-broken","name":"x"');

  const ls = runCli(home, ["automation", "ls"]);
  assert.equal(ls.status, 0, `ls must not hard-error on torn file: ${ls.stderr}`);

  const backups = readdirSync(home).filter((entry) =>
    entry.startsWith(".tw-dashboard-automations.json.corrupt-"),
  );
  assert.equal(backups.length, 1, `expected one quarantine backup: ${backups}`);

  const create = runCli(home, ["automation", "create", "--instruction", "after recovery"]);
  assert.equal(create.status, 0, `create after torn file must succeed: ${create.stderr}`);

  const fresh = readAutomations(path);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].instruction, "after recovery");
});

function ageFile(path, daysAgo = 0, hoursAgo = 0) {
  const ms = Date.now() - (daysAgo * 24 * 60 * 60 + hoursAgo * 60 * 60) * 1_000;
  const stamp = new Date(ms);
  utimesSync(path, stamp, stamp);
}

test("sweepStateFileArtifacts removes aged corrupt backups and tmp orphans only", () => {
  const root = tmpDir("tw-auto-sweep-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const base = ".tw-dashboard-automations.json";
  const statePath = join(home, base);
  writeFileSync(statePath, "[]\n");

  const agedCorrupt = join(home, `${base}.corrupt-100`);
  const freshCorrupt = join(home, `${base}.corrupt-200`);
  const agedNodeTmp = join(home, `${base}.111.aaaa.tmp`);
  const freshNodeTmp = join(home, `${base}.222.bbbb.tmp`);
  const agedRustTmp = join(home, `.${base}.tmp-cccc`);
  const freshRustTmp = join(home, `.${base}.tmp-dddd`);
  for (const path of [agedCorrupt, freshCorrupt, agedNodeTmp, freshNodeTmp, agedRustTmp, freshRustTmp]) {
    writeFileSync(path, "x");
  }
  // Sibling state files' artifacts are not in scope.
  const otherCorrupt = join(home, "feishu-bindings.json.corrupt-9");
  const otherTmp = join(home, "feishu-event-dedup.json.1.2.tmp");
  writeFileSync(otherCorrupt, "x");
  writeFileSync(otherTmp, "x");

  ageFile(agedCorrupt, 8);
  ageFile(freshCorrupt, 1);
  ageFile(agedNodeTmp, 0, 2);
  ageFile(freshNodeTmp, 0, 10 / 60);
  ageFile(agedRustTmp, 0, 2);
  ageFile(freshRustTmp, 0, 10 / 60);
  ageFile(otherCorrupt, 8);
  ageFile(otherTmp, 0, 2);

  sweepStateFileArtifacts(statePath);

  const entries = new Set(readdirSync(home));
  assert.equal(entries.has(`${base}.corrupt-100`), false, "8-day corrupt backup removed");
  assert.equal(entries.has(`${base}.corrupt-200`), true, "1-day corrupt backup kept");
  assert.equal(entries.has(`${base}.111.aaaa.tmp`), false, "2-hour node tmp removed");
  assert.equal(entries.has(`${base}.222.bbbb.tmp`), true, "10-minute node tmp kept");
  assert.equal(entries.has(`.${base}.tmp-cccc`), false, "2-hour rust tmp removed");
  assert.equal(entries.has(`.${base}.tmp-dddd`), true, "10-minute rust tmp kept");
  assert.equal(entries.has("feishu-bindings.json.corrupt-9"), true, "other state corrupt untouched");
  assert.equal(entries.has("feishu-event-dedup.json.1.2.tmp"), true, "other state tmp untouched");
  assert.equal(entries.has(base), true, "live state file untouched");
});

test("readAutomations sweeps orphans after successful load but never on failed parse", () => {
  const root = tmpDir("tw-auto-sweep-load-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const path = automationStatePath(home);
  const base = ".tw-dashboard-automations.json";

  // Successful load path: aged orphans next to a valid file go away.
  writeFileSync(path, "[]\n");
  const agedCorrupt = join(home, `${base}.corrupt-aged`);
  const agedTmp = join(home, `${base}.1.abc.tmp`);
  writeFileSync(agedCorrupt, "x");
  writeFileSync(agedTmp, "x");
  ageFile(agedCorrupt, 8);
  ageFile(agedTmp, 0, 2);

  assert.deepEqual(readAutomations(path), []);
  const afterSuccess = new Set(readdirSync(home));
  assert.equal(afterSuccess.has(`${base}.corrupt-aged`), false, "sweep after successful parse");
  assert.equal(afterSuccess.has(`${base}.1.abc.tmp`), false, "tmp swept after successful parse");

  // Failed parse path: quarantine happens but pre-existing aged siblings
  // are retained (they may be needed for recovery).
  writeFileSync(path, "{ broken json");
  const sibling = join(home, `${base}.corrupt-sibling`);
  writeFileSync(sibling, "x");
  ageFile(sibling, 8);

  assert.deepEqual(readAutomations(path), []);
  const afterFailure = new Set(readdirSync(home));
  assert.equal(afterFailure.has(`${base}.corrupt-sibling`), true, "no sweep on the failed-parse branch");
  const quarantines = [...afterFailure].filter((entry) => entry.startsWith(`${base}.corrupt-`));
  assert.equal(quarantines.length >= 1, true, `corrupt state was quarantined: ${quarantines}`);
});
