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
const bridgeModule = await import(
  "../dist/relay/v2/hostNativeCredentialPrivilegedIntakeBridge.js"
);
const nativeCellModule = await import(
  "../dist/relay/v2/hostCredentialAtomicFileCellNative.js"
);
const createTargetAdmissionModule = await import(
  "../dist/relay/v2/canonicalCreateTargetAdmissionAdapter.js"
);
const createTargetQueryTransportModule = await import(
  "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js"
);

/** A real one-shot execution pair whose components stay inert in these tests. */
function realCreateTargetExecutionPair() {
  const runner = { spawn() { throw new Error("unexpected create observation spawn"); } };
  return createTargetAdmissionModule.issueRelayV2CanonicalCreateTargetExecutionPairV1({
    owner: new createTargetQueryTransportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [{ kind: "local", targetId: "local", executable: "/usr/local/bin/tw" }],
      runner,
    }),
    runner,
    inner: { async execute() { throw new Error("unexpected process execution"); } },
  });
}
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
    createTargetExecutionPair: realCreateTargetExecutionPair(),
    terminalBackend: {
      async open() {
        effects.terminal += 1;
        throw new Error("unexpected terminal open");
      },
    },
    localProcessTarget: { kind: "local", targetId: "local" },
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
    createTargetExecutionPair: {},
    terminalBackend: {},
    localProcessTarget: {},
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

function createFakeNativeModule(events, { openError = null } = {}) {
  const stats = { opens: 0, closes: 0 };
  let bytes = null;
  let revision = Object.freeze({});
  const handle = {
    read(request) {
      events.push("native-read");
      return {
        abiVersion: 1,
        operation: "read",
        outcome: "ok",
        current: bytes === null
          ? { state: "empty", revision }
          : { state: "present", revision, bytes: Uint8Array.from(bytes) },
      };
    },
    compareAndSwap(request) {
      events.push("native-cas");
      bytes = Uint8Array.from(request.bytes);
      revision = Object.freeze({});
      return { abiVersion: 1, operation: "compare_and_swap", outcome: "swapped" };
    },
    close(request) {
      stats.closes += 1;
      events.push("native-closed");
      return { abiVersion: 1, operation: "close", outcome: "closed" };
    },
  };
  const nativeModule = {
    openRelayV2HostCredentialAtomicFileCellV1(request) {
      stats.opens += 1;
      events.push("native-opened");
      if (openError !== null) {
        return {
          abiVersion: 1,
          operation: "open",
          outcome: "error",
          error: { code: openError },
        };
      }
      return { abiVersion: 1, operation: "open", outcome: "opened", handle };
    },
  };
  return { nativeModule, stats };
}

function createPlainModuleSource(nativeModule) {
  const stats = { takes: 0 };
  // Deliberately no internal replay guard: the bridge itself must own the
  // one-shot claim against this exact callable identity.
  const takeNativeModule = () => {
    stats.takes += 1;
    return nativeModule;
  };
  return { takeNativeModule, stats };
}

test("native credential privileged intake bridge transfers one-shot ownership once", async (t) => {
  await t.test("fake native module reaches the real wrapper and intake exactly once", async () => {
    const home = privateHome("tw-relay-v2-bridge-success-home-");
    const h = await makeHarness("bridge-success", home);
    const daemon = await startDaemon(h);
    const events = [];
    const fake = createFakeNativeModule(events);
    const source = createPlainModuleSource(fake.nativeModule);
    const byteSource = createByteSource(events);
    const originalSpoolClose = h.spool.close.bind(h.spool);
    h.spool.close = async () => {
      events.push("canonical-spool-closed");
      return originalSpoolClose();
    };
    try {
      const facade = await bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
        takeNativeModule: source.takeNativeModule,
        trustedHome: home,
        bootstrapSecretByteSource: byteSource.source,
        canonical: h.canonical,
      });
      events.push("facade-published");
      assert.notEqual(facade, null);
      assert.equal(source.stats.takes, 1);
      assert.equal(fake.stats.opens, 1);
      assert.deepEqual(facade.inspect(), { status: "stopped", controllerGeneration: "0" });
      assert.ok(events.indexOf("native-cas") < events.indexOf("facade-published"));
      for (const hidden of ["takeNativeModule", "nativeModule", "cell", "handle", "source"]) {
        assert.equal(Reflect.get(facade, hidden), undefined);
      }

      // The bridge owns the one-shot claim: a second serial open with the same
      // callable fails closed before touching the source, wrapper, or intake.
      await assert.rejects(
        bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
          takeNativeModule: source.takeNativeModule,
          trustedHome: home,
          bootstrapSecretByteSource: byteSource.source,
          canonical: h.canonical,
        }),
        (error) => {
          assert.equal(
            error?.name,
            "RelayV2HostNativeCredentialPrivilegedIntakeBridgeError",
          );
          return assertRedacted(error, "SOURCE_CONSUMED");
        },
      );
      assert.equal(source.stats.takes, 1, "the consumed source is never retaken");
      assert.equal(fake.stats.opens, 1, "the rejected open never reaches the native wrapper");

      // A concurrent pair with the same callable admits exactly one claimant.
      const concurrentEvents = [];
      const concurrentFake = createFakeNativeModule(concurrentEvents);
      const concurrentSource = createPlainModuleSource(concurrentFake.nativeModule);
      const concurrent = await Promise.allSettled([
        bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
          takeNativeModule: concurrentSource.takeNativeModule,
          trustedHome: home,
          canonical: bareCanonicalOptions(),
        }),
        bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
          takeNativeModule: concurrentSource.takeNativeModule,
          trustedHome: home,
          canonical: bareCanonicalOptions(),
        }),
      ]);
      const consumed = concurrent.filter(
        (result) => result.status === "rejected"
          && result.reason?.code === "SOURCE_CONSUMED",
      );
      assert.equal(consumed.length, 1, "exactly one concurrent claimant fails closed");
      assert.equal(concurrent.every((result) => result.status === "rejected"), true);
      assert.equal(concurrentSource.stats.takes, 1);
      assert.equal(concurrentFake.stats.opens, 1);
      assert.equal(concurrentFake.stats.closes, 1,
        "the admitted claimant's pre-publication failure still closes the cell once");

      await facade.closeAndDrain();
      assert.equal(fake.stats.closes, 1, "the opened cell closes exactly once");
      assert.ok(events.indexOf("canonical-spool-closed")
        < events.indexOf("native-closed"),
      "the existing intake close order drains canonical before the cell");
      assert.equal(source.stats.takes, 1, "close never retakes the source");
    } finally {
      await daemon.close();
      h.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test("source, native, and pre-publication intake failures fail closed redacted", async () => {
    const assertBridgeRedacted = (error, code) => {
      assert.equal(error?.name, "RelayV2HostNativeCredentialPrivilegedIntakeBridgeError");
      return assertRedacted(error, code);
    };

    const missingHome = privateHome("tw-relay-v2-bridge-throw-");
    const throwEvents = [];
    const throwFake = createFakeNativeModule(throwEvents);
    let throwTakes = 0;
    const throwingTake = () => {
      throwTakes += 1;
      throw new Error(BOOTSTRAP_SECRET);
    };
    await assert.rejects(
      bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
        takeNativeModule: throwingTake,
        trustedHome: missingHome,
        canonical: bareCanonicalOptions(),
      }),
      (error) => assertBridgeRedacted(error, "SOURCE_TAKE_FAILED"),
    );
    assert.equal(throwTakes, 1);
    assert.equal(throwFake.stats.opens, 0);
    assert.equal(throwEvents.length, 0);
    // The callable claim is permanent even after a failed take: replaying the
    // same callable is rejected before the source runs again.
    await assert.rejects(
      bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
        takeNativeModule: throwingTake,
        trustedHome: missingHome,
        canonical: bareCanonicalOptions(),
      }),
      (error) => assertBridgeRedacted(error, "SOURCE_CONSUMED"),
    );
    assert.equal(throwTakes, 1, "the consumed callable is never retaken");

    // The real wrapper owns the raw-handle claim: two different module
    // façades whose open returns the SAME raw handle must not produce two
    // NativeCellOwners, and the rejected second open must not close or clean
    // up the first owner's handle.
    {
      const handleEvents = [];
      let sharedHandleCloses = 0;
      const sharedHandle = {
        read(request) {
          return {
            abiVersion: 1,
            operation: "read",
            outcome: "ok",
            current: { state: "empty", revision: Object.freeze({}) },
          };
        },
        compareAndSwap(request) {
          return { abiVersion: 1, operation: "compare_and_swap", outcome: "swapped" };
        },
        close(request) {
          sharedHandleCloses += 1;
          handleEvents.push("shared-handle-closed");
          return { abiVersion: 1, operation: "close", outcome: "closed" };
        },
      };
      const facadeStats = [{ opens: 0 }, { opens: 0 }];
      const facades = facadeStats.map((stats) => ({
        openRelayV2HostCredentialAtomicFileCellV1(request) {
          stats.opens += 1;
          return {
            abiVersion: 1,
            operation: "open",
            outcome: "opened",
            handle: sharedHandle,
          };
        },
      }));
      const firstCell = nativeCellModule.openRelayV2HostCredentialAtomicFileCellNative({
        nativeModule: facades[0],
      });
      assert.equal(facadeStats[0].opens, 1);
      assert.throws(
        () => nativeCellModule.openRelayV2HostCredentialAtomicFileCellNative({
          nativeModule: facades[1],
        }),
        (error) => {
          assert.equal(error?.name, "RelayV2HostCredentialAtomicFileCellNativeError");
          return assertRedacted(error, "CELL_BUSY");
        },
      );
      assert.equal(facadeStats[1].opens, 1, "the second facade may open once");
      assert.equal(sharedHandleCloses, 0,
        "the rejected duplicate open never closes the first owner's handle");
      const read = firstCell.runExclusive((transaction) => transaction.read());
      assert.equal(read.bytes, null, "the first owner remains fully functional");
      await firstCell.closeAndDrain();
      assert.equal(sharedHandleCloses, 1,
        "only the first owner's own close path closes the handle, exactly once");
    }

    for (const [label, options] of [
      ["async take", {
        takeNativeModule: async () => throwFake.nativeModule,
        trustedHome: missingHome,
        canonical: bareCanonicalOptions(),
      }],
      ["extra field", {
        takeNativeModule: () => throwFake.nativeModule,
        trustedHome: missingHome,
        canonical: bareCanonicalOptions(),
        loader: {},
      }],
    ]) {
      await assert.rejects(
        bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge(options),
        (error) => assertBridgeRedacted(error, "SOURCE_INVALID"),
        label,
      );
    }
    await assert.rejects(
      bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
        takeNativeModule: () => Promise.resolve(throwFake.nativeModule),
        trustedHome: missingHome,
        canonical: bareCanonicalOptions(),
      }),
      (error) => assertBridgeRedacted(error, "SOURCE_INVALID"),
      "thenable take result",
    );
    assert.equal(throwFake.stats.opens, 0, "invalid sources never reach the native wrapper");
    assert.equal(existsSync(join(missingHome, ".tmux-worktree")), false);

    const durabilityEvents = [];
    const durabilityFake = createFakeNativeModule(durabilityEvents, {
      openError: "CELL_DURABILITY_UNSUPPORTED",
    });
    const durabilitySource = createPlainModuleSource(durabilityFake.nativeModule);
    await assert.rejects(
      bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
        takeNativeModule: durabilitySource.takeNativeModule,
        trustedHome: missingHome,
        canonical: bareCanonicalOptions(),
      }),
      (error) => assertBridgeRedacted(error, "CELL_DURABILITY_UNSUPPORTED"),
    );
    assert.equal(durabilitySource.stats.takes, 1);
    assert.equal(durabilityFake.stats.opens, 1);
    assert.equal(durabilityFake.stats.closes, 0, "no handle was captured, nothing to close");
    assert.equal(existsSync(join(missingHome, ".tmux-worktree")), false,
      "durability refusal is v2-unavailable, never a profile/H4a/v1 path");
    rmSync(missingHome, { recursive: true, force: true });

    // The module claim closes the identity bypass: two different callables —
    // or two bind() results — that yield the same nativeModule identity can
    // each run their own take once, but only the first reaches the wrapper.
    for (const [label, makePair] of [
      ["two plain functions", (module) => [
        () => module,
        () => module,
      ]],
      ["two bind() results", (module) => [
        (function returnModule() { return module; }).bind(null),
        (function returnModule() { return module; }).bind(null),
      ]],
    ]) {
      const sharedHome = privateHome(`tw-relay-v2-bridge-shared-${label.includes("bind") ? "bind" : "plain"}-`);
      seedProfile(sharedHome);
      const sharedEvents = [];
      const sharedFake = createFakeNativeModule(sharedEvents);
      const [firstTake, secondTake] = makePair(sharedFake.nativeModule);
      try {
        await assert.rejects(
          bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
            takeNativeModule: firstTake,
            trustedHome: sharedHome,
            canonical: bareCanonicalOptions(),
          }),
          (error) => assertRedacted(error, "OWNER_CONSTRUCTION_FAILED"),
          `${label}: the first claimant reaches the intake`,
        );
        assert.equal(sharedFake.stats.opens, 1, label);
        assert.equal(sharedFake.stats.closes, 1, label);
        await assert.rejects(
          bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
            takeNativeModule: secondTake,
            trustedHome: sharedHome,
            canonical: bareCanonicalOptions(),
          }),
          (error) => assertBridgeRedacted(error, "MODULE_CONSUMED"),
          `${label}: the second callable yielding the same module fails closed`,
        );
        assert.equal(sharedFake.stats.opens, 1,
          `${label}: the consumed module never reaches a second native open`);
        assert.equal(sharedFake.stats.closes, 1,
          `${label}: no second cell owner side effect occurs`);
      } finally {
        rmSync(sharedHome, { recursive: true, force: true });
      }
    }

    const home = privateHome("tw-relay-v2-bridge-intake-failure-home-");
    const failing = await makeHarness("bridge-failure", home);
    const events = [];
    const fake = createFakeNativeModule(events);
    const source = createPlainModuleSource(fake.nativeModule);
    const byteSource = createByteSource(events);
    try {
      await assert.rejects(
        bridgeModule.openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
          takeNativeModule: source.takeNativeModule,
          trustedHome: home,
          bootstrapSecretByteSource: byteSource.source,
          canonical: failing.canonical,
        }),
        (error) => assertRedacted(error, "CANONICAL_OPEN_FAILED"),
      );
      assert.equal(source.stats.takes, 1, "no fallback or retry retakes the source");
      assert.equal(fake.stats.opens, 1);
      assert.equal(fake.stats.closes, 1, "the captured cell closes exactly once");
      assert.equal(byteSource.stats.cancels, 1);
      assert.equal(existsSync(failing.socketPath), false,
        "no canonical side effect survives the failed open");
    } finally {
      failing.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
