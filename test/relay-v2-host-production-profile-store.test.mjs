import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fixtureRoot = join(
  process.cwd(),
  "contracts",
  "relay",
  "v2",
  "host-production-profile-v1",
);
const manifest = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(fixtureRoot, "cases.json"), "utf8"));
const profileStore = await import(
  "../dist/relay/v2/hostProductionProfileStore.js"
);
const profileStoreUrl = new URL(
  "../dist/relay/v2/hostProductionProfileStore.js",
  import.meta.url,
).href;

const {
  RELAY_V2_HOST_PRODUCTION_PROFILE_CONTRACT,
  RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
  RELAY_V2_HOST_PRODUCTION_PROFILE_RELATIVE_PATH,
  RELAY_V2_HOST_PRODUCTION_PROFILE_SCHEMA_VERSION,
  loadOrCreateRelayV2HostProductionProfile,
  readRelayV2HostProductionProfile,
  relayV2HostProductionProfilePath,
} = profileStore;

const PROFILE_DIRECTORY = ".tmux-worktree/relay-v2-host";
const PROFILE_FILENAME = "profile-v1.json";
const LOCK_FILENAME = "profile-v1.json.lock";

function privateHome(t, prefix = "tw-relay-v2-host-profile-") {
  const created = mkdtempSync(join(tmpdir(), prefix));
  const home = realpathSync.native(created);
  chmodSync(home, 0o700);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function profilePath(home) {
  return join(home, PROFILE_DIRECTORY, PROFILE_FILENAME);
}

function lockPath(home) {
  return join(home, PROFILE_DIRECTORY, LOCK_FILENAME);
}

function prepareProfileDirectory(home) {
  const parent = join(home, ".tmux-worktree");
  const directory = join(home, PROFILE_DIRECTORY);
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o700);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function store(profile, home) {
  return loadOrCreateRelayV2HostProductionProfile({ profile, trustedHome: home });
}

function hasCode(code) {
  return (error) => error?.code === code
    && !error.message.includes(cases.validProfile.credentialReference)
    && !error.message.includes(cases.validProfile.bootstrapSecretReference)
    && !error.message.includes(cases.validProfile.refreshSecretReference);
}

function mutateProfile(mutation) {
  const profile = { ...cases.validProfile };
  if (mutation.field !== undefined) profile[mutation.field] = mutation.value;
  if (mutation.extraField !== undefined) profile[mutation.extraField] = mutation.value;
  return profile;
}

test("frozen Host production profile contract creates once and reopens idempotently", (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    assert.throws(
      () => store(cases.validProfile, privateHome(t)),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_PLATFORM_UNSUPPORTED"),
    );
    return;
  }
  assert.equal(manifest.contract, RELAY_V2_HOST_PRODUCTION_PROFILE_CONTRACT);
  assert.equal(manifest.contractVersion, RELAY_V2_HOST_PRODUCTION_PROFILE_SCHEMA_VERSION);
  assert.equal(manifest.maximumBytes, RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES);
  assert.equal(manifest.storagePath.slice(2), RELAY_V2_HOST_PRODUCTION_PROFILE_RELATIVE_PATH);
  assert.equal(cases.fixtureFormatVersion, 1);

  const missingHome = privateHome(t, "tw-relay-v2-host-profile-missing-");
  assert.throws(
    () => readRelayV2HostProductionProfile({ trustedHome: missingHome }),
    hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND"),
  );
  assert.equal(existsSync(join(missingHome, ".tmux-worktree")), false);

  const home = privateHome(t);
  assert.equal(relayV2HostProductionProfilePath(home), profilePath(home));
  const created = store(cases.validProfile, home);
  const persisted = readFileSync(profilePath(home));
  assert.ok(persisted.byteLength <= manifest.maximumBytes);
  assert.equal(persisted.toString("utf8"), render(cases.validProfile));
  assert.equal(Object.getPrototypeOf(created), null);
  assert.equal(Object.isFrozen(created), true);
  assert.deepEqual({ ...created }, cases.validProfile);
  assert.equal(lstatSync(join(home, ".tmux-worktree")).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(home, PROFILE_DIRECTORY)).mode & 0o777, 0o700);
  assert.equal(lstatSync(profilePath(home)).mode & 0o777, 0o600);
  assert.equal(existsSync(lockPath(home)), false);
  assert.deepEqual(readdirSync(join(home, PROFILE_DIRECTORY)), [PROFILE_FILENAME]);

  const recovered = readRelayV2HostProductionProfile({ trustedHome: home });
  assert.equal(Object.getPrototypeOf(recovered), null);
  assert.equal(Object.isFrozen(recovered), true);
  assert.deepEqual({ ...recovered }, cases.validProfile);
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "const { readRelayV2HostProductionProfile: read } = await import(process.argv[1]); const value = read({ trustedHome: process.argv[2] }); if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== null || value.hostId !== 'host-production-01') process.exit(2);",
    profileStoreUrl,
    home,
  ], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.deepEqual(readFileSync(profilePath(home)), persisted);

  const reopened = store(cases.validProfile, home);
  assert.deepEqual({ ...reopened }, cases.validProfile);
  assert.deepEqual(readFileSync(profilePath(home)), persisted);
  assert.equal(existsSync(lockPath(home)), false);
});

test("different, corrupt, and unknown profiles fail closed without overwrite", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const conflictHome = privateHome(t, "tw-relay-v2-host-profile-conflict-");
  store(cases.validProfile, conflictHome);
  const original = readFileSync(profilePath(conflictHome));
  assert.throws(
    () => store(cases.differentProfile, conflictHome),
    hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_CONFLICT"),
  );
  assert.deepEqual(readFileSync(profilePath(conflictHome)), original);
  assert.equal(existsSync(lockPath(conflictHome)), false);

  for (const vector of cases.invalidExistingDocuments) {
    await t.test(vector.id, () => {
      const home = privateHome(t, `tw-relay-v2-host-profile-${vector.id}-`);
      prepareProfileDirectory(home);
      const bytes = vector.contents === undefined
        ? Buffer.from(render(mutateProfile(vector.mutation)), "utf8")
        : Buffer.from(vector.contents, "utf8");
      writeFileSync(profilePath(home), bytes, { mode: 0o600 });
      chmodSync(profilePath(home), 0o600);
      assert.throws(
        () => store(cases.validProfile, home),
        hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID"),
      );
      assert.deepEqual(readFileSync(profilePath(home)), bytes);
      assert.equal(existsSync(lockPath(home)), false);
    });
  }
});

test("unsafe profile and lock metadata is preserved and rejected", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const observed = new Set();

  await t.test("parent-directory-mode", () => {
    observed.add("parent-directory-mode");
    const home = privateHome(t, "tw-relay-v2-host-profile-dir-mode-");
    const parent = join(home, ".tmux-worktree");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    assert.throws(
      () => store(cases.validProfile, home),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE"),
    );
    assert.equal(lstatSync(parent).mode & 0o777, 0o755);
    assert.equal(existsSync(profilePath(home)), false);
  });

  await t.test("profile-mode", () => {
    observed.add("profile-mode");
    const home = privateHome(t, "tw-relay-v2-host-profile-file-mode-");
    prepareProfileDirectory(home);
    const bytes = Buffer.from(render(cases.validProfile), "utf8");
    writeFileSync(profilePath(home), bytes, { mode: 0o644 });
    chmodSync(profilePath(home), 0o644);
    assert.throws(
      () => store(cases.validProfile, home),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE"),
    );
    assert.equal(lstatSync(profilePath(home)).mode & 0o777, 0o644);
    assert.deepEqual(readFileSync(profilePath(home)), bytes);
  });

  await t.test("profile-hard-link", () => {
    observed.add("profile-hard-link");
    const home = privateHome(t, "tw-relay-v2-host-profile-hardlink-");
    prepareProfileDirectory(home);
    const source = join(home, "hardlink-source");
    const bytes = Buffer.from(render(cases.validProfile), "utf8");
    writeFileSync(source, bytes, { mode: 0o600 });
    linkSync(source, profilePath(home));
    assert.throws(
      () => store(cases.validProfile, home),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE"),
    );
    assert.equal(lstatSync(source).nlink, 2);
    assert.deepEqual(readFileSync(source), bytes);
  });

  await t.test("profile-symlink", () => {
    observed.add("profile-symlink");
    const home = privateHome(t, "tw-relay-v2-host-profile-symlink-");
    prepareProfileDirectory(home);
    const target = join(home, "symlink-target");
    writeFileSync(target, "preserve-target", { mode: 0o600 });
    symlinkSync(target, profilePath(home));
    assert.throws(
      () => store(cases.validProfile, home),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE"),
    );
    assert.equal(lstatSync(profilePath(home)).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), "preserve-target");
  });

  await t.test("profile-non-regular", () => {
    observed.add("profile-non-regular");
    const home = privateHome(t, "tw-relay-v2-host-profile-directory-");
    prepareProfileDirectory(home);
    mkdirSync(profilePath(home), { mode: 0o700 });
    assert.throws(
      () => store(cases.validProfile, home),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE"),
    );
    assert.equal(lstatSync(profilePath(home)).isDirectory(), true);
  });

  await t.test("lock-symlink", () => {
    observed.add("lock-symlink");
    const home = privateHome(t, "tw-relay-v2-host-profile-lock-symlink-");
    prepareProfileDirectory(home);
    const target = join(home, "lock-target");
    writeFileSync(target, "preserve-lock-target", { mode: 0o600 });
    symlinkSync(target, lockPath(home));
    assert.throws(
      () => store(cases.validProfile, home),
      hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE"),
    );
    assert.equal(lstatSync(lockPath(home)).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), "preserve-lock-target");
    assert.equal(existsSync(profilePath(home)), false);
  });

  assert.deepEqual([...observed].sort(), [...cases.unsafeMetadataCases].sort());
});

test("invalid fixture inputs are rejected before filesystem mutation", async (t) => {
  for (const vector of cases.invalidInputMutations) {
    await t.test(vector.id, () => {
      const home = privateHome(t, `tw-relay-v2-host-profile-input-${vector.id}-`);
      const profile = { ...cases.validProfile };
      if (vector.field !== undefined) {
        profile[vector.field] = vector.valueFromField === undefined
          ? vector.value
          : profile[vector.valueFromField];
      }
      if (vector.extraField !== undefined) profile[vector.extraField] = vector.value;
      assert.throws(
        () => store(profile, home),
        hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS"),
      );
      assert.equal(existsSync(join(home, ".tmux-worktree")), false);
    });
  }
});
