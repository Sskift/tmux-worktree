import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const intakeModule = await import(
  "../dist/relay/v2/hostPrivilegedProductionIntakeComposition.js"
);
const profileStore = await import("../dist/relay/v2/hostProductionProfileStore.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const credentialVault = await import("../dist/relay/v2/hostCredentialVault.js");
const bootstrapHandoff = await import(
  "../dist/relay/v2/hostBootstrapSecretHandoff.js"
);
const terminalControl = await import("../dist/terminalControl/index.js");
const exactCompound = await import(
  "../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);

const profileCases = JSON.parse(readFileSync(new URL(
  "../contracts/relay/v2/host-production-profile-v1/cases.json",
  import.meta.url,
), "utf8"));
const PROFILE = Object.freeze(profileCases.validProfile);
const BOOTSTRAP_SECRET = "twhostboot2.privileged-intake-secret-never-reflect";

function privateHome(prefix) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(home, 0o700);
  return home;
}

class FakeCellBackend {
  bytes = null;
  generation = 0;
  swaps = 0;
  events = [];
}

class FakeCellOwner {
  #backend;
  #closed = false;
  #closePromise = null;
  #closeFailure;
  #revisions = new WeakMap();

  constructor(backend, { closeFailure = null } = {}) {
    this.#backend = backend;
    this.#closeFailure = closeFailure;
  }

  runExclusive(operation) {
    if (this.#closed) throw new Error("fake cell is closed");
    const read = () => {
      const revision = Object.freeze(Object.create(null));
      this.#revisions.set(revision, this.#backend.generation);
      return Object.freeze({
        bytes: this.#backend.bytes === null
          ? null
          : Uint8Array.from(this.#backend.bytes),
        revision,
      });
    };
    return operation(Object.freeze({
      read,
      compareAndSwap: (expected, replacement) => {
        if (this.#revisions.get(expected) !== this.#backend.generation) {
          return Object.freeze({ status: "conflict", current: read() });
        }
        this.#backend.bytes = Uint8Array.from(replacement);
        this.#backend.generation += 1;
        this.#backend.swaps += 1;
        this.#backend.events.push("cell-swapped");
        return Object.freeze({ status: "swapped" });
      },
    }));
  }

  closeAndDrain() {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#backend.events.push("cell-closed");
    this.#closePromise = this.#closeFailure === null
      ? Promise.resolve()
      : Promise.reject(this.#closeFailure);
    void this.#closePromise.catch(() => undefined);
    return this.#closePromise;
  }
}

class OneScanDiscovery {
  used = false;

  async scan() {
    assert.equal(this.used, false);
    this.used = true;
    const processTarget = { kind: "local", targetId: "local" };
    return {
      coverage: "complete",
      scopes: [{
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        reachability: "online",
        sessionsCompleteness: "complete",
        sessions: [],
        error: null,
      }],
      [resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT]: {
        generation: "privileged-intake-discovery-1",
        scopeTargets: [{
          scopeBackendIdentity: "local",
          processTarget,
          capabilities: ["session.list"],
        }],
        sessionTargets: [],
        isCurrent() { return true; },
      },
    };
  }
}

function noEffectTerminalControlBackend() {
  const unexpected = async () => { throw new Error("unexpected terminal-control effect"); };
  return {
    resolveManagedSession: unexpected,
    inspectExactTarget: unexpected,
    assertCurrent: unexpected,
    writeRaw: unexpected,
    sendAgentMessage: unexpected,
    resize: unexpected,
    scroll: unexpected,
    killManaged: unexpected,
    prepareOutput: unexpected,
    resetOutput: unexpected,
    tailOutput: unexpected,
  };
}

function createByteSource(events) {
  const stats = { iterators: 0, nextCalls: 0, cancels: 0 };
  let cancelPromise = null;
  const source = Object.freeze({
    [Symbol.asyncIterator]() {
      stats.iterators += 1;
      let index = 0;
      return Object.freeze({
        next() {
          stats.nextCalls += 1;
          if (index++ === 0) {
            return Promise.resolve({
              done: false,
              value: Uint8Array.from(Buffer.from(`${BOOTSTRAP_SECRET}\n`, "utf8")),
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      });
    },
    cancel() {
      stats.cancels += 1;
      events.push("source-cancelled");
      cancelPromise ??= Promise.resolve();
      return cancelPromise;
    },
  });
  return { source, stats };
}

function seedProfile(home) {
  return profileStore.loadOrCreateRelayV2HostProductionProfile({
    profile: PROFILE,
    trustedHome: home,
  });
}

async function makeHarness(label, home) {
  seedProfile(home);
  const root = mkdtempSync(join(tmpdir(), `tw-relay-v2-intake-${label}-`));
  chmodSync(root, 0o700);
  const store = await hostState.RelayV2HostStateStore.open({
    paths: hostState.relayV2HostStatePaths(root),
  });
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: PROFILE.hostId,
    discovery: new OneScanDiscovery(),
    store,
    readinessSink: { apply: () => true },
  });
  const seeded = await foundation.reconcile();
  const spoolRoot = join(root, "snapshot-spool");
  const publisher = await foundation.openStateSnapshotSpool({
    hostId: PROFILE.hostId,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  await publisher.get({
    principalId: "privileged-intake-principal",
    clientInstanceId: "privileged-intake-client",
    expectedHostEpoch: seeded.snapshot.hostEpoch,
    snapshotRequestId: `privileged-intake-${label}-snapshot`,
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  await publisher.close();
  const spool = await foundation.openStateSnapshotSpool({
    hostId: PROFILE.hostId,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  const socketPath = join(tmpdir(), `twv2-intake-${process.pid}-${label}-${root.slice(-6)}.sock`);
  const statePath = join(root, "terminal-control-state-v1.json");
  const terminalBackend = noEffectTerminalControlBackend();
  const effects = { welcome: 0, create: 0, process: 0, terminal: 0, remote: 0 };
  const dashboardInput = Object.freeze({
    async *[Symbol.asyncIterator]() {},
  });
  const canonical = {
    hostState: store,
    recoveredH2Spool: spool,
    welcome: {
      build() {
        effects.welcome += 1;
        throw new Error("unexpected welcome build");
      },
    },
    createTargetAuthority: {
      async resolveCreateTarget() {
        effects.create += 1;
        throw new Error("unexpected create resolution");
      },
      fenceCreateTargetForAdmission() {
        effects.create += 1;
        throw new Error("unexpected create fence");
      },
    },
    process: {
      async execute() {
        effects.process += 1;
        throw new Error("unexpected process execution");
      },
    },
    terminalBackend: {
      async open() {
        effects.terminal += 1;
        throw new Error("unexpected terminal open");
      },
    },
    localProcessTarget: { kind: "local", targetId: "local" },
    nextDedupeWindowBounds() {
      return { acceptUntilMs: 1_800_000_000_000, queryUntilMs: 1_800_086_400_000 };
    },
    terminalControl: {
      daemonSocketPath: socketPath,
      remoteCompoundChannels: {
        async open() {
          effects.remote += 1;
          throw new Error("unexpected remote compound target");
        },
      },
    },
    dashboardManagement: {
      clock: () => 1_783_700_000_000,
      runtimeVersion: "2.0.0",
      signal: new AbortController().signal,
      io: {
        input: dashboardInput,
        async writeFrame() { throw new Error("management must remain inert"); },
      },
    },
  };
  return {
    root,
    store,
    spool,
    socketPath,
    statePath,
    terminalBackend,
    canonical,
    effects,
    cleanup() {
      rmSync(socketPath, { force: true });
      rmSync(`${socketPath}.server.lock`, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function startDaemon(harness) {
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: harness.statePath,
    backend: harness.terminalBackend,
  });
  const abort = new AbortController();
  const running = terminalControl.runTerminalControlServer({
    socketPath: harness.socketPath,
    authority,
    signal: abort.signal,
    relayV2RemoteExactCompoundV1: true,
  });
  await waitForPath(harness.socketPath);
  await waitForPath(exactCompound.relayV2RemoteExactCompoundSocketPathV1(
    harness.socketPath,
  ));
  return {
    async close() {
      abort.abort();
      await running.catch(() => undefined);
    },
  };
}

function bareCanonicalOptions() {
  return {
    hostState: { close() {} },
    recoveredH2Spool: { close() { return Promise.resolve(); } },
    welcome: {},
    createTargetAuthority: {},
    process: {},
    terminalBackend: {},
    localProcessTarget: {},
    nextDedupeWindowBounds() { return {}; },
  };
}

function assertRedacted(error, code) {
  assert.equal(error?.code, code);
  const diagnostic = `${String(error)}\n${String(error?.stack)}\n${JSON.stringify(error)}`;
  assert.equal(diagnostic.includes(BOOTSTRAP_SECRET), false);
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

test("privileged Host intake owns one exact profile/source/vault/canonical lifecycle", async (t) => {
  await t.test("foreign options fail before profile read or ownership transfer", async () => {
    const missingHome = privateHome("tw-relay-v2-intake-malformed-");
    const backend = new FakeCellBackend();
    const cell = new FakeCellOwner(backend);
    let getterCalls = 0;
    const dashboard = {
      clock: () => 0,
      runtimeVersion: "2.0.0",
      signal: new AbortController().signal,
      io: { input: Object.freeze({ async *[Symbol.asyncIterator]() {} }), async writeFrame() {} },
    };
    Object.defineProperty(dashboard, "credentialExchangeCoordinator", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(BOOTSTRAP_SECRET);
      },
    });
    const canonical = bareCanonicalOptions();
    canonical.dashboardManagement = dashboard;
    assert.equal(await intakeModule.openRelayV2HostPrivilegedProductionIntakeComposition({
      trustedHome: missingHome,
      credentialCell: cell,
      canonical,
    }), null);
    assert.equal(getterCalls, 0);
    assert.equal(existsSync(join(missingHome, ".tmux-worktree")), false);
    assert.equal(backend.events.length, 0, "malformed input must not claim or close the cell");
    await cell.closeAndDrain();
    rmSync(missingHome, { recursive: true, force: true });
  });

  await t.test("no-source empty cell fails closed before canonical publication", async () => {
    const home = privateHome("tw-relay-v2-intake-empty-home-");
    seedProfile(home);
    const backend = new FakeCellBackend();
    await assert.rejects(
      intakeModule.openRelayV2HostPrivilegedProductionIntakeComposition({
        trustedHome: home,
        credentialCell: new FakeCellOwner(backend),
        canonical: bareCanonicalOptions(),
      }),
      (error) => assertRedacted(error, "OWNER_CONSTRUCTION_FAILED"),
    );
    assert.equal(backend.swaps, 0);
    assert.deepEqual(backend.events, ["cell-closed"]);
    rmSync(home, { recursive: true, force: true });
  });

  await t.test("one source commit precedes publication and close drains canonical before cell", async () => {
    const home = privateHome("tw-relay-v2-intake-success-home-");
    const h = await makeHarness("success", home);
    const daemon = await startDaemon(h);
    const backend = new FakeCellBackend();
    const cell = new FakeCellOwner(backend);
    const source = createByteSource(backend.events);
    const originalSpoolClose = h.spool.close.bind(h.spool);
    h.spool.close = async () => {
      backend.events.push("canonical-spool-closed");
      return originalSpoolClose();
    };
    try {
      const facade = await intakeModule.openRelayV2HostPrivilegedProductionIntakeComposition({
        trustedHome: home,
        credentialCell: cell,
        bootstrapSecretByteSource: source.source,
        canonical: h.canonical,
      });
      backend.events.push("facade-published");
      assert.notEqual(facade, null);
      assert.equal(Object.getPrototypeOf(facade), null);
      assert.equal(Object.isFrozen(facade), true);
      assert.deepEqual(Reflect.ownKeys(facade).sort(), [
        "closeAndDrain",
        "inspect",
        "requestReauthentication",
        "runDashboardManagement",
        "start",
        "stopAndDrain",
      ]);
      assert.deepEqual(facade.inspect(), { status: "stopped", controllerGeneration: "0" });
      assert.equal(typeof facade.runDashboardManagement, "function",
        "the internally bound coordinator must satisfy the canonical owner");
      assert.equal(source.stats.iterators, 1);
      assert.equal(source.stats.nextCalls, 2);
      assert.equal(source.stats.cancels, 1);
      assert.equal(backend.swaps, 1);
      assert.ok(backend.events.indexOf("cell-swapped")
        < backend.events.indexOf("facade-published"));
      assert.deepEqual(h.effects, {
        welcome: 0, create: 0, process: 0, terminal: 0, remote: 0,
      });
      for (const hidden of [
        "profile", "path", "source", "handoff", "vault", "cell", "credentialAuthority",
        "credentialExchangeCoordinator", "bootstrapSecretReference", "refreshSecretReference",
      ]) assert.equal(Reflect.get(facade, hidden), undefined);

      const closing = facade.closeAndDrain();
      assert.equal(facade.closeAndDrain(), closing);
      assert.throws(
        () => facade.inspect(),
        (error) => error?.code === "COMPOSITION_CLOSED",
      );
      await closing;
      assert.ok(backend.events.indexOf("source-cancelled")
        < backend.events.indexOf("canonical-spool-closed"));
      assert.ok(backend.events.indexOf("canonical-spool-closed")
        < backend.events.indexOf("cell-closed"));
      assert.equal(source.stats.cancels, 1, "close must not reopen or recancel the source");
    } finally {
      await daemon.close();
      h.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test("canonical failure preserves the committed cell and no-source recovery is inert", async () => {
    const home = privateHome("tw-relay-v2-intake-recovery-home-");
    const backend = new FakeCellBackend();
    const source = createByteSource(backend.events);
    const failing = await makeHarness("failure", home);
    try {
      await assert.rejects(
        intakeModule.openRelayV2HostPrivilegedProductionIntakeComposition({
          trustedHome: home,
          credentialCell: new FakeCellOwner(backend),
          bootstrapSecretByteSource: source.source,
          canonical: failing.canonical,
        }),
        (error) => assertRedacted(error, "CANONICAL_OPEN_FAILED"),
      );
      assert.equal(source.stats.iterators, 1);
      assert.equal(source.stats.cancels, 1);
      assert.equal(backend.swaps, 1);
      assert.ok(backend.bytes?.byteLength > 0, "canonical rollback must preserve the envelope");
    } finally {
      failing.cleanup();
    }

    const proofHandoff = bootstrapHandoff.createRelayV2HostBootstrapSecretHandoffAuthority();
    const proofCell = new FakeCellOwner(backend);
    const proofVault = new credentialVault.RelayV2HostCredentialVault({
      hostId: PROFILE.hostId,
      credentialReference: PROFILE.credentialReference,
      bootstrapSecretReference: PROFILE.bootstrapSecretReference,
      refreshSecretReference: PROFILE.refreshSecretReference,
      cell: proofCell,
      bootstrapSecretHandoff: proofHandoff.handoff,
    });
    assert.equal(proofVault.resolve(PROFILE.bootstrapSecretReference), BOOTSTRAP_SECRET);
    await proofVault.closeAndDrain();
    await proofHandoff.closeAndDrain();
    await proofCell.closeAndDrain();

    const recovering = await makeHarness("recovery", home);
    const daemon = await startDaemon(recovering);
    try {
      const swapsBefore = backend.swaps;
      const facade = await intakeModule.openRelayV2HostPrivilegedProductionIntakeComposition({
        trustedHome: home,
        credentialCell: new FakeCellOwner(backend),
        canonical: recovering.canonical,
      });
      assert.notEqual(facade, null);
      assert.deepEqual(facade.inspect(), { status: "stopped", controllerGeneration: "0" });
      assert.equal(backend.swaps, swapsBefore, "recovery without a source must remain read-only");
      assert.deepEqual(recovering.effects, {
        welcome: 0, create: 0, process: 0, terminal: 0, remote: 0,
      });
      await facade.closeAndDrain();
    } finally {
      await daemon.close();
      recovering.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test("close drains every later owner and returns only a fixed redacted failure", async () => {
    const home = privateHome("tw-relay-v2-intake-close-home-");
    const h = await makeHarness("close-failure", home);
    const daemon = await startDaemon(h);
    const backend = new FakeCellBackend();
    const cell = new FakeCellOwner(backend, {
      closeFailure: new Error(`foreign close leaked ${BOOTSTRAP_SECRET}`),
    });
    const source = createByteSource(backend.events);
    try {
      const facade = await intakeModule.openRelayV2HostPrivilegedProductionIntakeComposition({
        trustedHome: home,
        credentialCell: cell,
        bootstrapSecretByteSource: source.source,
        canonical: h.canonical,
      });
      assert.notEqual(facade, null);
      const close = facade.closeAndDrain();
      assert.equal(facade.closeAndDrain(), close);
      await assert.rejects(close, (error) => assertRedacted(error, "CLOSE_FAILED"));
      assert.equal(existsSync(h.socketPath), true, "the external daemon remains unowned");
    } finally {
      await daemon.close();
      h.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
