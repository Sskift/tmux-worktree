import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const contractsRoot = new URL("../contracts/storage/", import.meta.url);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const state = await import("../dist/state.js");
const config = await import("../dist/config.js");
const relayHost = await import("../dist/relayHost.js");

function readContract(name, file) {
  return JSON.parse(readFileSync(new URL(`${name}/${file}`, contractsRoot), "utf8"));
}

function withTempDir(prefix, operation) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("storage manifests freeze paths, modes, locks, and schema versions", () => {
  const managed = readContract("managed-state-v1", "manifest.json");
  assert.equal(managed.version, state.MANAGED_STATE_VERSION);
  assert.equal(managed.path, "~/.tmux-worktree/state.json");
  assert.equal(managed.fileMode, "0600");
  assert.deepEqual(managed.sessionKinds, ["worktree", "terminal"]);
  assert.deepEqual(managed.profiles, ["cli", "dashboard"]);
  assert.deepEqual(managed.lock, {
    pathSuffix: ".lock",
    ownerFile: "owner.json",
    ownerFileMode: "0600",
  });

  const terminals = readContract("terminal-registry-v1", "manifest.json");
  assert.equal(terminals.path, "~/.tw-dashboard-terminals.json");
  assert.equal(terminals.status, "frozen-unversioned-file");
  assert.equal(terminals.fileMode, "0600");

  const hosts = readContract("host-config-v1", "manifest.json");
  assert.equal(hosts.path, "~/.tmux-worktree.json");
  assert.deepEqual(hosts.collectionAliases, ["hosts", "remotes", "remoteHosts"]);
  assert.equal(hosts.fileMode, "0600");
});

test("managed-state-v1 normalizes compatible records and writes exact private JSON", () => {
  const cases = readContract("managed-state-v1", "cases.json");
  assert.deepEqual(state.normalizeManagedState(cases.valid.input), cases.valid.normalized);

  withTempDir("tw-managed-state-contract-", (root) => {
    const path = join(root, ".tmux-worktree", "state.json");
    mkdirSync(join(root, ".tmux-worktree"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cases.valid.input, null, 2)}\n`);
    assert.deepEqual(state.loadManagedStateForMutation(path), cases.valid.normalized);

    state.saveManagedState(cases.serialization.state, path);
    assert.equal(readFileSync(path, "utf8"), cases.serialization.text);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const lock = state.acquireManagedStateLock(`${path}.lock`);
    const ownerPath = join(`${path}.lock`, "owner.json");
    assert.equal(statSync(ownerPath).mode & 0o777, 0o600);
    state.releaseManagedStateLock(lock);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test("managed-state-v1 mutations fail closed and preserve invalid bytes", () => {
  const cases = readContract("managed-state-v1", "cases.json");
  withTempDir("tw-managed-state-fail-", (root) => {
    const path = join(root, "state.json");
    for (const fixture of cases.mutationFailures) {
      writeFileSync(path, fixture.contents);
      assert.throws(
        () => state.loadManagedStateForMutation(path),
        new RegExp(fixture.errorIncludes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        fixture.id,
      );
      assert.equal(readFileSync(path, "utf8"), fixture.contents, fixture.id);
    }
  });
});

test("terminal-registry-v1 preserves raw metadata and isolates invalid catalog items", () => {
  const cases = readContract("terminal-registry-v1", "cases.json");
  assert.deepEqual(
    relayHost.parseDashboardTerminalPayload(cases.catalogInput),
    cases.catalogNormalized,
  );

  const remote = relayHost.dashboardTerminalRecord(
    cases.remoteScope.scope,
    cases.remoteScope.name,
    cases.remoteScope.cwd,
    cases.remoteScope.label,
  );
  for (const [field, value] of Object.entries(cases.remoteScope.expected)) {
    assert.deepEqual(remote[field], value, field);
  }

  withTempDir("tw-terminal-registry-contract-", (root) => {
    const path = join(root, "terminals.json");
    relayHost.writeTerminalRegistryAtomic(cases.stored, path);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(cases.stored, null, 2)}\n`);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    writeFileSync(path, cases.invalidMutation.contents);
    assert.throws(
      () => relayHost.mutateTerminalRegistry((current) => current, path),
      new RegExp(cases.invalidMutation.errorIncludes),
    );
    assert.equal(readFileSync(path, "utf8"), cases.invalidMutation.contents);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test("host-config-v1 accepts aliases while retaining remote tilde semantics", () => {
  const cases = readContract("host-config-v1", "cases.json");
  assert.deepEqual(
    JSON.parse(JSON.stringify(config.normalizeConfig(cases.objectMap.input).hosts)),
    cases.objectMap.normalizedHosts,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(config.normalizeConfig(cases.arrayAliases.input).hosts)),
    cases.arrayAliases.normalizedHosts,
  );
});

test("host-config-v1 CRUD preserves unknown root and host fields", () => {
  const cases = readContract("host-config-v1", "cases.json");
  withTempDir("tw-host-config-contract-", (root) => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const path = join(home, ".tmux-worktree.json");
    writeFileSync(path, `${JSON.stringify(cases.crudPreservation.input, null, 2)}\n`);
    const result = spawnSync(process.execPath, [cli, ...cases.crudPreservation.argv], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");

    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.rootExtension, cases.crudPreservation.expectedRootExtension);
    assert.deepEqual(saved.hosts[0].hostExtension, cases.crudPreservation.expectedHostExtension);
    assert.equal(saved.hosts[0].label, cases.crudPreservation.expectedLabel);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});
