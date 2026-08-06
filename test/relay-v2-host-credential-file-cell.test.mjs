import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

if (process.platform !== "darwin" && process.platform !== "linux") {
  test.skip("Relay v2 Host credential file cell requires darwin or linux", () => {});
} else {
  const { build } = createRequire(import.meta.url)("esbuild");
  const sourcePath = new URL(
    "../src/relay/v2/hostCredentialFileCell.ts",
    import.meta.url,
  ).pathname;
  const compiled = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    packages: "external",
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
  );
  const {
    createRelayV2HostCredentialFileCell,
    relayV2HostCredentialFileCellPath,
    RelayV2HostCredentialFileCellError,
  } = module;

  const shortRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const CELL_DIR_RELATIVE = join(
    ".tmux-worktree",
    "relay-v2-host-credential-atomic-file-cell-v1",
  );

  function makeCellHome(withNamespace) {
    const home = realpathSync.native(mkdtempSync(join(shortRoot, "tw-v2-file-cell-")));
    chmodSync(home, 0o700);
    const cellDir = join(home, CELL_DIR_RELATIVE);
    if (withNamespace) {
      mkdirSync(cellDir, { recursive: true, mode: 0o700 });
      chownNamespace(home);
    }
    return { home, cellDir };
  }

  function chownNamespace(home) {
    const privateDir = join(home, ".tmux-worktree");
    const cellDir = join(privateDir, "relay-v2-host-credential-atomic-file-cell-v1");
    chmodSync(privateDir, 0o700);
    chmodSync(cellDir, 0o700);
    chownSync(privateDir, process.geteuid(), process.getegid());
    chownSync(cellDir, process.geteuid(), process.getegid());
  }

  function writeCredential(cellDir, bytes) {
    const cellPath = join(cellDir, "relay-v2-host-credential.cell");
    writeFileSync(cellPath, bytes, { mode: 0o600 });
    chmodSync(cellPath, 0o600);
    chownSync(cellPath, process.geteuid(), process.getegid());
    return cellPath;
  }

  // Native-format vault envelope (contract revision 7): "tw-hcv1\0" magic,
  // UInt32BE payload length, SHA-256 of the payload, then the JSON payload.
  function nativeEnvelope(overrides = {}) {
    const payload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      binding: {
        hostId: "host-unit-exact",
        credentialReference: "relay-v2-host-credential-ref:host-unit-exact",
        bootstrapSecretReference: "bootstrap-unit",
        refreshSecretReference: "refresh-unit",
      },
      credentialState: null,
      secretSlots: { bootstrapSecret: null, refreshSecret: null },
      ...overrides,
    }), "utf8");
    const bytes = Buffer.alloc(8 + 4 + 32 + payload.byteLength);
    bytes.write("tw-hcv1\0", 0, "utf8");
    bytes.writeUInt32BE(payload.byteLength, 8);
    createHash("sha256").update(payload).digest().copy(bytes, 12);
    payload.copy(bytes, 44);
    return bytes;
  }

  function removeHome(home) {
    rmSync(home, { recursive: true, force: true });
  }

  test("Relay v2 Host credential file cell derives the native private path", () => {
    const { home } = makeCellHome(true);
    assert.equal(
      relayV2HostCredentialFileCellPath(home),
      join(home, CELL_DIR_RELATIVE, "relay-v2-host-credential.cell"),
    );
    removeHome(home);
  });

  test("Relay v2 Host credential file cell reads a missing namespace as the empty cell", () => {
    const { home } = makeCellHome(false);
    const cell = createRelayV2HostCredentialFileCell(home);
    const read = cell.runExclusive((transaction) => transaction.read());
    assert.equal(read.bytes, null);
    assert.equal(typeof read.revision, "object");
    cell.closeAndDrain();
    removeHome(home);
  });

  test("Relay v2 Host credential file cell round-trips a native-format envelope", async () => {
    const { home, cellDir } = makeCellHome(true);
    const envelope = nativeEnvelope();
    writeCredential(cellDir, envelope);
    const cell = createRelayV2HostCredentialFileCell(home);
    try {
      const initial = cell.runExclusive((transaction) => transaction.read());
      assert.ok(initial.bytes instanceof Uint8Array);
      assert.deepEqual(Buffer.from(initial.bytes), envelope);
      const replacement = nativeEnvelope({ credentialState: undefined });
      const swapped = cell.runExclusive((transaction) =>
        transaction.compareAndSwap(initial.revision, replacement));
      assert.equal(swapped.status, "swapped");
      const after = cell.runExclusive((transaction) => transaction.read());
      assert.deepEqual(Buffer.from(after.bytes), replacement);
      assert.deepEqual(
        readFileSync(join(cellDir, "relay-v2-host-credential.cell")),
        replacement,
      );
    } finally {
      await cell.closeAndDrain();
    }
    removeHome(home);
  });

  test("Relay v2 Host credential file cell writes through a same-directory temp rename with no garbage", async () => {
    const { home, cellDir } = makeCellHome(true);
    writeCredential(cellDir, nativeEnvelope());
    const cell = createRelayV2HostCredentialFileCell(home);
    try {
      const initial = cell.runExclusive((transaction) => transaction.read());
      const replacement = Uint8Array.from([1, 2, 3, 4, 5]);
      const swapped = cell.runExclusive((transaction) =>
        transaction.compareAndSwap(initial.revision, replacement));
      assert.equal(swapped.status, "swapped");
      const entries = readdirSync(cellDir).sort();
      assert.deepEqual(
        entries,
        ["relay-v2-host-credential.cell"],
        "no temporary or lock residue after a swap",
      );
      assert.deepEqual(
        readFileSync(join(cellDir, "relay-v2-host-credential.cell")),
        Buffer.from(replacement),
      );
    } finally {
      await cell.closeAndDrain();
    }
    removeHome(home);
  });

  test("Relay v2 Host credential file cell rejects a revision used in a previous swap", async () => {
    const { home, cellDir } = makeCellHome(true);
    writeCredential(cellDir, nativeEnvelope());
    const cell = createRelayV2HostCredentialFileCell(home);
    try {
      const initial = cell.runExclusive((transaction) => transaction.read());
      assert.equal(
        cell.runExclusive((transaction) =>
          transaction.compareAndSwap(initial.revision, Uint8Array.from([1]))).status,
        "swapped",
      );
      assert.throws(
        () => cell.runExclusive((transaction) =>
          transaction.compareAndSwap(initial.revision, Uint8Array.from([2]))),
        (error) => error instanceof RelayV2HostCredentialFileCellError
          && error.code === "REVISION_INVALID",
      );
    } finally {
      await cell.closeAndDrain();
    }
    removeHome(home);
  });

  test("Relay v2 Host credential file cell reports a conflict on an external write", async () => {
    const { home, cellDir } = makeCellHome(true);
    const cellPath = writeCredential(cellDir, nativeEnvelope());
    const cell = createRelayV2HostCredentialFileCell(home);
    try {
      const initial = cell.runExclusive((transaction) => transaction.read());
      writeCredential(cellDir, Uint8Array.from([9, 9, 9]));
      chmodSync(cellPath, 0o600);
      const conflicted = cell.runExclusive((transaction) =>
        transaction.compareAndSwap(initial.revision, Uint8Array.from([1, 2, 3])));
      assert.equal(conflicted.status, "conflict");
    } finally {
      await cell.closeAndDrain();
    }
    removeHome(home);
  });

  test("Relay v2 Host credential file cell rejects unsafe credential file shapes", async () => {
    const { home, cellDir } = makeCellHome(true);
    // Oversize credential.
    writeCredential(cellDir, new Uint8Array(65_537));
    let cell = createRelayV2HostCredentialFileCell(home);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError
        && error.code === "CELL_CORRUPT",
    );
    await cell.closeAndDrain();
    // World-readable credential mode.
    writeCredential(cellDir, nativeEnvelope());
    chmodSync(join(cellDir, "relay-v2-host-credential.cell"), 0o644);
    cell = createRelayV2HostCredentialFileCell(home);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError
        && error.code === "CELL_PERMISSION_INVALID",
    );
    await cell.closeAndDrain();
    // Symlinked credential.
    rmSync(join(cellDir, "relay-v2-host-credential.cell"), { force: true });
    writeFileSync(join(cellDir, "symlink-target"), "x", { mode: 0o600 });
    symlinkSync(
      join(cellDir, "symlink-target"),
      join(cellDir, "relay-v2-host-credential.cell"),
    );
    cell = createRelayV2HostCredentialFileCell(home);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError,
    );
    await cell.closeAndDrain();
    removeHome(home);
  });

  test("Relay v2 Host credential file cell rejects a hard-linked credential", async () => {
    const { home, cellDir } = makeCellHome(true);
    const cellPath = writeCredential(cellDir, nativeEnvelope());
    linkSync(cellPath, join(cellDir, "alias"));
    const cell = createRelayV2HostCredentialFileCell(home);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError,
    );
    await cell.closeAndDrain();
    removeHome(home);
  });

  test("Relay v2 Host credential file cell rejects unsafe home and cell directory shapes", async () => {
    // Home with group write (0o755 has no group/other write, so it is a valid
    // native home shape; 0o775 is not).
    const { home, cellDir } = makeCellHome(true);
    writeCredential(cellDir, nativeEnvelope());
    chmodSync(home, 0o775);
    let cell = createRelayV2HostCredentialFileCell(home);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError
        && error.code === "CELL_PERMISSION_INVALID",
    );
    await cell.closeAndDrain();
    chmodSync(home, 0o700);
    // Cell directory not exactly 0700.
    chmodSync(cellDir, 0o755);
    cell = createRelayV2HostCredentialFileCell(home);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError
        && error.code === "CELL_PERMISSION_INVALID",
    );
    await cell.closeAndDrain();
    removeHome(home);
  });

  test("Relay v2 Host credential file cell rejects reentrant and async thenable results", async () => {
    const { home, cellDir } = makeCellHome(true);
    writeCredential(cellDir, nativeEnvelope());
    const cell = createRelayV2HostCredentialFileCell(home);
    try {
      assert.throws(
        () => cell.runExclusive(() => {
          cell.runExclusive(() => 0);
        }),
        (error) => error instanceof RelayV2HostCredentialFileCellError
          && error.code === "REENTRANT",
      );
      const inheritedThenable = Object.create({ then() {} });
      assert.throws(
        () => cell.runExclusive(() => inheritedThenable),
        (error) => error instanceof RelayV2HostCredentialFileCellError
          && error.code === "ASYNC_OPERATION_UNSUPPORTED",
      );
      const hostileThenable = {};
      Object.defineProperty(hostileThenable, "then", {
        get() {
          throw new Error("then getter must not be assimilated");
        },
      });
      assert.throws(
        () => cell.runExclusive(() => hostileThenable),
        (error) => error instanceof RelayV2HostCredentialFileCellError
          && error.code === "ASYNC_OPERATION_UNSUPPORTED",
      );
    } finally {
      await cell.closeAndDrain();
    }
    removeHome(home);
  });

  test("Relay v2 Host credential file cell fails closed after closeAndDrain", async () => {
    const { home, cellDir } = makeCellHome(true);
    writeCredential(cellDir, nativeEnvelope());
    const cell = createRelayV2HostCredentialFileCell(home);
    await cell.closeAndDrain();
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      (error) => error instanceof RelayV2HostCredentialFileCellError
        && error.code === "CLOSED",
    );
    removeHome(home);
  });

  test("Relay v2 Host credential file cell honors a fresh foreign lock and recovers a stale lock", async () => {
    const { home, cellDir } = makeCellHome(true);
    writeCredential(cellDir, nativeEnvelope());
    const lockDir = join(cellDir, ".relay-v2-host-credential.cell.js-lock-v1");
    mkdirSync(lockDir, { mode: 0o700 });
    chmodSync(lockDir, 0o700);
    chownSync(lockDir, process.geteuid(), process.getegid());
    const ownerPath = join(lockDir, "owner");
    writeFileSync(
      ownerPath,
      `${JSON.stringify({
        owner: "foreign",
        pid: 1,
        createdAt: Date.now(),
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );

    // Fresh foreign lock fails closed with CELL_BUSY.
    let cell = createRelayV2HostCredentialFileCell(home);
    const initial = cell.runExclusive((transaction) => transaction.read());
    assert.throws(
      () => cell.runExclusive((transaction) =>
        transaction.compareAndSwap(initial.revision, Uint8Array.from([1, 2, 3]))),
      (error) => error instanceof RelayV2HostCredentialFileCellError
        && error.code === "CELL_BUSY",
    );
    await cell.closeAndDrain();

    // A stale lock (old timestamp, dead pid) is recovered and the swap lands.
    writeFileSync(
      ownerPath,
      `${JSON.stringify({
        owner: "dead",
        pid: 2_147_483_647,
        createdAt: Date.now() - 60_000,
      })}\n`,
      { mode: 0o600 },
    );
    cell = createRelayV2HostCredentialFileCell(home);
    const fresh = cell.runExclusive((transaction) => transaction.read());
    const swapped = cell.runExclusive((transaction) =>
      transaction.compareAndSwap(fresh.revision, Uint8Array.from([7, 7, 7])));
    assert.equal(swapped.status, "swapped");
    await cell.closeAndDrain();
    assert.deepEqual(
      readFileSync(join(cellDir, "relay-v2-host-credential.cell")),
      Buffer.from([7, 7, 7]),
    );
    removeHome(home);
  });
}
