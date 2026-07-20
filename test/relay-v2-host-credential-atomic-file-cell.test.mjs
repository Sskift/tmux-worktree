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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const atomicFileCell = await import(
  "../dist/relay/v2/hostCredentialAtomicFileCell.js"
);

const {
  RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_FILENAME: CREDENTIAL_FILENAME,
  RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLAIM_NAME: CLAIM_NAME,
  openRelayV2HostCredentialAtomicFileCell,
} = atomicFileCell;

function privateTemporaryDirectory(t, prefix = "tw-host-credential-cell-") {
  const created = mkdtempSync(join(tmpdir(), prefix));
  const directory = realpathSync.native(created);
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function credentialPath(directory) {
  return join(directory, CREDENTIAL_FILENAME);
}

function claimPath(directory) {
  return join(directory, CLAIM_NAME);
}

function readCell(cell) {
  return cell.runExclusive((transaction) => transaction.read());
}

function bytes(value) {
  return Buffer.from(value, "utf8");
}

function rendered(read) {
  return read.bytes === null ? null : Buffer.from(read.bytes).toString("utf8");
}

function assertCellError(code) {
  return (error) => error?.code === code;
}

test("empty cell publishes, rotates, conflicts stale revisions, and reopens after clean close", async (t) => {
  const directory = privateTemporaryDirectory(t);
  const cell = openRelayV2HostCredentialAtomicFileCell({ directory });
  let nativeAsyncEntered = false;
  assert.throws(
    () => cell.runExclusive(async () => {
      nativeAsyncEntered = true;
    }),
    assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_ASYNC_OPERATION_UNSUPPORTED"),
  );
  assert.equal(nativeAsyncEntered, false);
  const empty = readCell(cell);
  assert.equal(empty.bytes, null);

  assert.deepEqual(cell.runExclusive((transaction) => transaction.compareAndSwap(
    empty.revision,
    bytes("credential-one"),
  )), { status: "swapped" });
  assert.equal(statSync(credentialPath(directory)).mode & 0o777, 0o600);

  const first = readCell(cell);
  assert.equal(rendered(first), "credential-one");
  assert.deepEqual(cell.runExclusive((transaction) => transaction.compareAndSwap(
    first.revision,
    bytes("credential-two"),
  )), { status: "swapped" });

  const second = readCell(cell);
  assert.equal(rendered(second), "credential-two");
  const conflict = cell.runExclusive((transaction) => transaction.compareAndSwap(
    first.revision,
    bytes("must-not-publish"),
  ));
  assert.equal(conflict.status, "conflict");
  assert.equal(rendered(conflict.current), "credential-two");
  assert.equal(readFileSync(credentialPath(directory), "utf8"), "credential-two");

  const close = cell.closeAndDrain();
  assert.equal(cell.closeAndDrain(), close);
  await close;
  assert.equal(existsSync(claimPath(directory)), false);
  assert.equal(readFileSync(credentialPath(directory), "utf8"), "credential-two");

  const reopened = openRelayV2HostCredentialAtomicFileCell({ directory });
  assert.equal(rendered(readCell(reopened)), "credential-two");
  await reopened.closeAndDrain();
  assert.equal(readFileSync(credentialPath(directory), "utf8"), "credential-two");

  const asynchronousResults = [
    {
      label: "Promise",
      create(transaction, revision) {
        return Promise.resolve().then(() => transaction.compareAndSwap(
          revision,
          bytes("must-not-publish-late"),
        ));
      },
    },
    {
      label: "thenable",
      create(_transaction, _revision, observation) {
        return Object.defineProperty(Object.create(null), "then", {
          get() {
            observation.thenGetterRead = true;
            return () => undefined;
          },
        });
      },
    },
  ];
  for (const entry of asynchronousResults) {
    const recoveryDirectory = privateTemporaryDirectory(t, `tw-host-cell-callback-${entry.label}-`);
    const recoveryCell = openRelayV2HostCredentialAtomicFileCell({ directory: recoveryDirectory });
    const recoveryEmpty = readCell(recoveryCell);
    const observation = { thenGetterRead: false };
    assert.throws(
      () => recoveryCell.runExclusive((transaction) => {
        assert.equal(transaction.compareAndSwap(
          recoveryEmpty.revision,
          bytes("first-and-only-value"),
        ).status, "swapped");
        return entry.create(transaction, recoveryEmpty.revision, observation);
      }),
      assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
    );
    await Promise.resolve();
    assert.equal(observation.thenGetterRead, false);
    assert.equal(readFileSync(credentialPath(recoveryDirectory), "utf8"), "first-and-only-value");
    assert.throws(
      () => readCell(recoveryCell),
      assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
    );
    const recoveryClose = recoveryCell.closeAndDrain();
    assert.equal(recoveryCell.closeAndDrain(), recoveryClose);
    await assert.rejects(
      recoveryClose,
      assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
    );
    assert.equal(existsSync(claimPath(recoveryDirectory)), true);
  }
});

test("unsafe directory, data, link, and claim shapes fail closed without changing their targets", async (t) => {
  const cases = [
    {
      label: "directory symlink",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID",
      prepare(t) {
        const root = privateTemporaryDirectory(t, "tw-host-cell-dir-link-");
        const target = join(root, "target");
        mkdirSync(target, { mode: 0o700 });
        const marker = join(target, "marker");
        writeFileSync(marker, "directory-target", { mode: 0o600 });
        const link = join(root, "link");
        symlinkSync(target, link);
        return {
          directory: link,
          observe: () => ({ marker: readFileSync(marker, "utf8"), isLink: lstatSync(link).isSymbolicLink() }),
        };
      },
    },
    {
      label: "directory mode",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID",
      prepare(t) {
        const directory = privateTemporaryDirectory(t, "tw-host-cell-dir-mode-");
        chmodSync(directory, 0o755);
        return {
          directory,
          observe: () => ({ mode: statSync(directory).mode & 0o777 }),
        };
      },
    },
    {
      label: "data symlink",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID",
      prepare(t) {
        const directory = privateTemporaryDirectory(t, "tw-host-cell-data-link-");
        const target = join(directory, "outside-credential");
        writeFileSync(target, "outside-value", { mode: 0o600 });
        symlinkSync(target, credentialPath(directory));
        return {
          directory,
          observe: () => ({
            target: readFileSync(target, "utf8"),
            isLink: lstatSync(credentialPath(directory)).isSymbolicLink(),
          }),
        };
      },
    },
    {
      label: "data mode",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID",
      prepare(t) {
        const directory = privateTemporaryDirectory(t, "tw-host-cell-data-mode-");
        writeFileSync(credentialPath(directory), "old-value", { mode: 0o644 });
        return {
          directory,
          observe: () => ({
            value: readFileSync(credentialPath(directory), "utf8"),
            mode: statSync(credentialPath(directory)).mode & 0o777,
          }),
        };
      },
    },
    {
      label: "nonregular data",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID",
      prepare(t) {
        const directory = privateTemporaryDirectory(t, "tw-host-cell-data-directory-");
        mkdirSync(credentialPath(directory), { mode: 0o700 });
        return {
          directory,
          observe: () => ({ isDirectory: lstatSync(credentialPath(directory)).isDirectory() }),
        };
      },
    },
    {
      label: "hardlinked data",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID",
      prepare(t) {
        const directory = privateTemporaryDirectory(t, "tw-host-cell-hardlink-");
        const target = join(directory, "outside-hardlink-target");
        writeFileSync(target, "hardlink-value", { mode: 0o600 });
        linkSync(target, credentialPath(directory));
        return {
          directory,
          observe: () => ({
            target: readFileSync(target, "utf8"),
            links: statSync(target).nlink,
          }),
        };
      },
    },
    {
      label: "claim conflict",
      code: "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
      prepare(t) {
        const directory = privateTemporaryDirectory(t, "tw-host-cell-claim-");
        writeFileSync(credentialPath(directory), "old-value", { mode: 0o600 });
        mkdirSync(claimPath(directory), { mode: 0o700 });
        writeFileSync(join(claimPath(directory), "foreign"), "do-not-delete", { mode: 0o600 });
        return {
          directory,
          observe: () => ({
            credential: readFileSync(credentialPath(directory), "utf8"),
            claim: readFileSync(join(claimPath(directory), "foreign"), "utf8"),
          }),
        };
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, (t) => {
      const prepared = entry.prepare(t);
      const before = prepared.observe();
      assert.throws(
        () => openRelayV2HostCredentialAtomicFileCell({ directory: prepared.directory }),
        assertCellError(entry.code),
      );
      assert.deepEqual(prepared.observe(), before);
      if (entry.label !== "claim conflict"
        && entry.code !== "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID") {
        assert.equal(existsSync(claimPath(prepared.directory)), false);
      }
    });
  }
});

test("one real claim excludes a second cell until clean close", async (t) => {
  const directory = privateTemporaryDirectory(t);
  const first = openRelayV2HostCredentialAtomicFileCell({ directory });
  assert.throws(
    () => openRelayV2HostCredentialAtomicFileCell({ directory }),
    assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
  );
  assert.equal(existsSync(claimPath(directory)), true);
  await first.closeAndDrain();

  const successor = openRelayV2HostCredentialAtomicFileCell({ directory });
  assert.equal(readCell(successor).bytes, null);
  await successor.closeAndDrain();
});

test("rename-precommit failure preserves the old value and removes only the owned temp", async (t) => {
  const captureGuards = ["renameFile", "fsyncDirectory"];
  for (const syscallName of captureGuards) {
    const guardedDirectory = privateTemporaryDirectory(t, `tw-host-cell-async-${syscallName}-`);
    let entered = false;
    assert.throws(
      () => openRelayV2HostCredentialAtomicFileCell({
        directory: guardedDirectory,
        syscalls: {
          [syscallName]: async () => {
            entered = true;
          },
        },
      }),
      assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_ASYNC_OPERATION_UNSUPPORTED"),
    );
    assert.equal(entered, false);
    assert.equal(existsSync(claimPath(guardedDirectory)), false);
  }

  const directory = privateTemporaryDirectory(t);
  let failRename = false;
  const cell = openRelayV2HostCredentialAtomicFileCell({
    directory,
    syscalls: {
      renameFile(source, destination) {
        if (failRename) throw new Error("injected rename failure");
        renameSync(source, destination);
      },
    },
  });
  const empty = readCell(cell);
  assert.equal(cell.runExclusive((transaction) => transaction.compareAndSwap(
    empty.revision,
    bytes("old-value"),
  )).status, "swapped");

  const old = readCell(cell);
  failRename = true;
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      old.revision,
      bytes("new-value"),
    )),
    assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE"),
  );
  assert.equal(readFileSync(credentialPath(directory), "utf8"), "old-value");
  assert.deepEqual(
    readdirWithoutClaim(directory),
    [CREDENTIAL_FILENAME],
  );
  await cell.closeAndDrain();
});

test("post-rename directory fsync failure is uncertain and permanently fences the cell", async (t) => {
  const directory = privateTemporaryDirectory(t);
  let failNextDirectoryFsync = false;
  const cell = openRelayV2HostCredentialAtomicFileCell({
    directory,
    syscalls: {
      fsyncDirectory() {
        if (failNextDirectoryFsync) {
          failNextDirectoryFsync = false;
          throw new Error("injected directory fsync failure");
        }
      },
    },
  });
  const empty = readCell(cell);
  assert.equal(cell.runExclusive((transaction) => transaction.compareAndSwap(
    empty.revision,
    bytes("old-value"),
  )).status, "swapped");

  const old = readCell(cell);
  failNextDirectoryFsync = true;
  assert.deepEqual(cell.runExclusive((transaction) => {
    const uncertain = transaction.compareAndSwap(
      old.revision,
      bytes("new-value"),
    );
    assert.deepEqual(uncertain, { status: "uncertain" });
    assert.throws(
      () => transaction.read(),
      assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_UNCERTAIN_FENCED"),
    );
    assert.throws(
      () => transaction.compareAndSwap(old.revision, bytes("must-not-publish")),
      assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_UNCERTAIN_FENCED"),
    );
    return uncertain;
  }), { status: "uncertain" });
  assert.equal(readFileSync(credentialPath(directory), "utf8"), "new-value");
  assert.throws(
    () => readCell(cell),
    assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_UNCERTAIN_FENCED"),
  );
  await cell.closeAndDrain();
  assert.equal(readFileSync(credentialPath(directory), "utf8"), "new-value");

  const invalidSyscallReturns = [
    {
      label: "Promise",
      create(context) {
        if (context.source !== undefined) {
          return Promise.resolve().then(() => renameSync(context.source, context.destination));
        }
        return Promise.resolve();
      },
    },
    {
      label: "thenable",
      create(context) {
        return Object.defineProperty(Object.create(null), "then", {
          get() {
            context.observation.thenGetterRead = true;
            return () => undefined;
          },
        });
      },
    },
    {
      label: "Proxy",
      create(context) {
        return new Proxy(Object.create(null), {
          get() {
            context.observation.proxyRead = true;
            return undefined;
          },
        });
      },
    },
  ];
  for (const syscallName of ["renameFile", "fsyncDirectory"]) {
    for (const invalidReturn of invalidSyscallReturns) {
      const guardedDirectory = privateTemporaryDirectory(
        t,
        `tw-host-cell-${syscallName}-${invalidReturn.label}-`,
      );
      const observation = { proxyRead: false, thenGetterRead: false };
      let armed = false;
      const guardedCell = openRelayV2HostCredentialAtomicFileCell({
        directory: guardedDirectory,
        syscalls: {
          renameFile(source, destination) {
            if (armed && syscallName === "renameFile") {
              return invalidReturn.create({ source, destination, observation });
            }
            renameSync(source, destination);
          },
          fsyncDirectory(directory) {
            if (armed && syscallName === "fsyncDirectory") {
              return invalidReturn.create({ directory, observation });
            }
          },
        },
      });
      const guardedEmpty = readCell(guardedCell);
      assert.equal(guardedCell.runExclusive((transaction) => transaction.compareAndSwap(
        guardedEmpty.revision,
        bytes("old-value"),
      )).status, "swapped");
      const guardedOld = readCell(guardedCell);
      armed = true;
      assert.deepEqual(guardedCell.runExclusive((transaction) => {
        const uncertain = transaction.compareAndSwap(
          guardedOld.revision,
          bytes("new-value"),
        );
        assert.deepEqual(uncertain, { status: "uncertain" });
        assert.throws(
          () => transaction.read(),
          assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
        );
        assert.throws(
          () => transaction.compareAndSwap(guardedOld.revision, bytes("must-not-publish")),
          assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
        );
        return uncertain;
      }), { status: "uncertain" });
      const guardedClose = guardedCell.closeAndDrain();
      assert.equal(guardedCell.closeAndDrain(), guardedClose);
      await assert.rejects(
        guardedClose,
        assertCellError("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"),
      );
      assert.equal(observation.thenGetterRead, false);
      assert.equal(observation.proxyRead, false);
      assert.equal(existsSync(claimPath(guardedDirectory)), true);
      assert.equal(
        readFileSync(credentialPath(guardedDirectory), "utf8"),
        syscallName === "fsyncDirectory" || invalidReturn.label === "Promise"
          ? "new-value"
          : "old-value",
      );
    }
  }
});

function readdirWithoutClaim(directory) {
  return readdirSync(directory).filter((entry) => entry !== CLAIM_NAME).sort();
}
