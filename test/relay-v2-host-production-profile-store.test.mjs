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
  readRelayV2HostProductionProfileProvisioningInput,
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
  const provisioningInput = join(home, "host-profile-input.json");
  writeFileSync(provisioningInput, render(cases.validProfile), { mode: 0o600 });
  chmodSync(provisioningInput, 0o600);
  const imported = readRelayV2HostProductionProfileProvisioningInput({
    inputPath: provisioningInput,
  });
  assert.equal(Object.getPrototypeOf(imported), null);
  assert.equal(Object.isFrozen(imported), true);
  assert.deepEqual({ ...imported }, cases.validProfile);
  assert.equal(relayV2HostProductionProfilePath(home), profilePath(home));
  const created = store(imported, home);
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

  const unsafeInputHome = privateHome(t, "tw-relay-v2-host-profile-input-mode-");
  const unsafeInput = join(unsafeInputHome, "host-profile-input.json");
  writeFileSync(unsafeInput, render(cases.validProfile), { mode: 0o644 });
  chmodSync(unsafeInput, 0o644);
  assert.throws(
    () => readRelayV2HostProductionProfileProvisioningInput({
      inputPath: unsafeInput,
    }),
    hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_PROVISIONING_INPUT_UNSAFE"),
  );
  assert.equal(existsSync(join(unsafeInputHome, ".tmux-worktree")), false);

  const duplicateInputHome = privateHome(t, "tw-relay-v2-host-profile-input-duplicate-");
  const duplicateInput = join(duplicateInputHome, "host-profile-input.json");
  const contractLine = `  "contract": ${JSON.stringify(cases.validProfile.contract)},\n`;
  writeFileSync(
    duplicateInput,
    render(cases.validProfile).replace(contractLine, `${contractLine}${contractLine}`),
    { mode: 0o600 },
  );
  chmodSync(duplicateInput, 0o600);
  assert.throws(
    () => readRelayV2HostProductionProfileProvisioningInput({
      inputPath: duplicateInput,
    }),
    hasCode("RELAY_V2_HOST_PRODUCTION_PROFILE_PROVISIONING_INPUT_INVALID"),
  );
  assert.equal(existsSync(join(duplicateInputHome, ".tmux-worktree")), false);

  const base64url16 = Buffer.alloc(16, 0xab).toString("base64url");
  const base64url32 = Buffer.alloc(32, 0xab).toString("base64url");
  const sensitiveTokens = [
    `twcap2.e30.${base64url32}`,
    `twref2.${base64url32}`,
    `twenroll2.${base64url32}`,
    `twhostboot2.${base64url16}.${base64url32}`,
  ];
  const embeddedValue = {
    hostId: (token) => `host-prefix-${token}-host-suffix`,
    relayUrl: (token) => `wss://prefix-${token}-suffix.example/`,
    credentialIssuerUrl: (token) => `https://prefix-${token}-suffix.example/`,
    credentialReference: (token) =>
      `relay-v2-host-credential-ref:prefix-${token}-suffix`,
    bootstrapSecretReference: (token) => `bootstrap-prefix-${token}-suffix`,
    refreshSecretReference: (token) => `refresh-prefix-${token}-suffix`,
  };
  for (const [field, embed] of Object.entries(embeddedValue)) {
    for (const token of sensitiveTokens) {
      const secretInputHome = privateHome(
        t,
        `tw-relay-v2-host-profile-input-secret-${field}-`,
      );
      const secretInput = join(secretInputHome, "host-profile-input.json");
      writeFileSync(
        secretInput,
        render({ ...cases.validProfile, [field]: embed(token) }),
        { mode: 0o600 },
      );
      chmodSync(secretInput, 0o600);
      assert.throws(
        () => readRelayV2HostProductionProfileProvisioningInput({
          inputPath: secretInput,
        }),
        (error) =>
          error?.code
            === "RELAY_V2_HOST_PRODUCTION_PROFILE_PROVISIONING_INPUT_INVALID"
          && error.message
            === "Relay v2 Host production profile provisioning input is invalid"
          && !error.message.includes(token),
      );
      assert.equal(existsSync(join(secretInputHome, ".tmux-worktree")), false);
    }
  }

  const directWriterHome = privateHome(
    t,
    "tw-relay-v2-host-profile-direct-writer-secret-",
  );
  const directWriterToken = sensitiveTokens[3];
  assert.throws(
    () => store({
      ...cases.validProfile,
      hostId: `host-prefix-${directWriterToken}-host-suffix`,
    }, directWriterHome),
    (error) =>
      error?.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS"
      && error.message === "Relay v2 Host production profile options are invalid"
      && !error.message.includes(directWriterToken),
  );
  assert.equal(existsSync(join(directWriterHome, ".tmux-worktree")), false);

  const nearShapeHome = privateHome(
    t,
    "tw-relay-v2-host-profile-non-token-prefix-",
  );
  const nearShapeHostId = "host-prefix-twhostboot2.not-a-token-host-suffix";
  assert.equal(
    store({ ...cases.validProfile, hostId: nearShapeHostId }, nearShapeHome).hostId,
    nearShapeHostId,
  );
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
