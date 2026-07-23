import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const relayHost = await import("../dist/relayHost.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const credentialAuthority = await import("../dist/relay/v2/hostCredentialAuthority.js");
const credentialExchange = await import(
  "../dist/relay/v2/hostCredentialExchangeCoordinator.js"
);
const dashboardSession = await import(
  "../dist/relay/v2/relayV2DashboardManagementProtocolV2CompositionSession.js"
);
const terminalControl = await import("../dist/terminalControl/index.js");
const exactCompound = await import(
  "../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);

const HOST_ID = "mac-canonical-production";
const CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:canonical-production";
const managementCases = JSON.parse(readFileSync(new URL(
  "../contracts/dashboard-relay-v2-management/v2/cases.json",
  import.meta.url,
), "utf8"));
const MANAGEMENT_STATUS_FRAME = managementCases.goldenExchanges.find(
  ({ operation }) => operation === "status",
).requestFrame;
const MANAGEMENT_START_FRAME = managementCases.goldenExchanges.find(
  ({ operation }) => operation === "start_connector",
).requestFrame;

class ControlledManagementInput {
  queue = [];
  waiters = [];
  closed = false;
  events;

  constructor(events) { this.events = events; }

  push(frame) {
    const value = Uint8Array.from(Buffer.from(frame));
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.queue.push(value);
  }

  [Symbol.asyncIterator]() { return this; }

  next() {
    const value = this.queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return() {
    if (!this.closed) {
      this.closed = true;
      this.events.push("management-input-closed");
      for (const waiter of this.waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    }
    return Promise.resolve({ done: true, value: undefined });
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
        generation: "canonical-production-discovery-1",
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

function makeCredentialAuthority() {
  return new credentialAuthority.RelayV2HostCredentialAuthority({
    storage: {
      runExclusive(_reference, operation) {
        return operation({
          read() { return { state: null, revision: 0 }; },
          compareAndSwap() { throw new Error("unexpected credential mutation"); },
        });
      },
    },
    secretResolver: {
      resolve() { throw new Error("unexpected credential resolution"); },
    },
  });
}

async function makeHarness(label) {
  const root = mkdtempSync(join(tmpdir(), `tw-relay-v2-host-root-${label}-`));
  const store = await hostState.RelayV2HostStateStore.open({
    paths: hostState.relayV2HostStatePaths(root),
  });
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: HOST_ID,
    discovery: new OneScanDiscovery(),
    store,
    readinessSink: { apply: () => true },
  });
  const seeded = await foundation.reconcile();
  const spoolRoot = join(root, "snapshot-spool");
  const publisher = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  await publisher.get({
    principalId: "canonical-production-principal",
    clientInstanceId: "canonical-production-client",
    expectedHostEpoch: seeded.snapshot.hostEpoch,
    snapshotRequestId: "canonical-production-snapshot",
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  await publisher.close();
  const spool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  const socketPath = join(
    tmpdir(),
    `twv2-${process.pid}-${label}-${root.slice(-6)}.sock`,
  );
  const statePath = join(root, "terminal-control-state-v1.json");
  const terminalBackend = noEffectTerminalControlBackend();
  const options = {
    hostState: store,
    recoveredH2Spool: spool,
    credentialAuthority: makeCredentialAuthority(),
    welcome: { build() { throw new Error("unexpected welcome build"); } },
    createTargetAuthority: {
      async resolveCreateTarget() { throw new Error("unexpected create resolution"); },
      fenceCreateTargetForAdmission() { throw new Error("unexpected create fence"); },
    },
    process: { async execute() { throw new Error("unexpected process execution"); } },
    terminalBackend: { async open() { throw new Error("unexpected terminal open"); } },
    localProcessTarget: { kind: "local", targetId: "local" },
    nextDedupeWindowBounds() {
      return { acceptUntilMs: 1_800_000_000_000, queryUntilMs: 1_800_086_400_000 };
    },
    terminalControl: {
      daemonSocketPath: socketPath,
      remoteCompoundChannels: {
        async open() { throw new Error("unexpected remote compound target"); },
      },
    },
  };
  const profile = {
    profile: "v2",
    relay: "wss://relay.example.com/",
    hostId: HOST_ID,
    displayName: "Canonical production Host",
    local: "http://127.0.0.1:8311",
    statusFile: "",
    credentialReference: CREDENTIAL_REFERENCE,
  };
  return {
    root,
    store,
    spool,
    socketPath,
    statePath,
    terminalBackend,
    options,
    profile,
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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("canonical production root is inert, singular, and closes idempotently", async () => {
  const h = await makeHarness("inert");
  const beforeOpen = await h.store.read();
  const abort = new AbortController();
  const daemonAuthority = new terminalControl.TerminalControlAuthority({
    statePath: h.statePath,
    backend: h.terminalBackend,
  });
  let exactProcessTargetCaptures = 0;
  const captureExactProcessTarget = daemonAuthority.captureRelayV2ExactProcessTarget
    .bind(daemonAuthority);
  daemonAuthority.captureRelayV2ExactProcessTarget = (target) => {
    exactProcessTargetCaptures += 1;
    return captureExactProcessTarget(target);
  };
  const daemon = terminalControl.runTerminalControlServer({
    socketPath: h.socketPath,
    authority: daemonAuthority,
    signal: abort.signal,
    relayV2RemoteExactCompoundV1: true,
  });
  try {
    await waitForPath(h.socketPath);
    await waitForPath(exactCompound.relayV2RemoteExactCompoundSocketPathV1(h.socketPath));
    const composition = await relayHost.openRelayV2HostCanonicalProductionComposition(
      h.profile,
      h.options,
    );
    assert.notEqual(composition, null);
    assert.equal(Object.getPrototypeOf(composition), null);
    assert.equal(Object.isFrozen(composition), true);
    assert.deepEqual(composition.inspect(), {
      status: "stopped",
      controllerGeneration: "0",
    });
    assert.equal(exactProcessTargetCaptures, 1,
      "Host preflight must enter the existing daemon authority exactly once");
    const afterOpen = await h.store.read();
    const afterExistingH3Recovery = BigInt(beforeOpen.commitSeq) + 1n;
    assert.equal(BigInt(afterOpen.commitSeq), afterExistingH3Recovery + 1n,
      "after H3 recovery, publication requires exactly one fresh durable H0 proof");
    assert.deepEqual(Object.keys(composition).sort(), [
      "closeAndDrain", "inspect", "requestReauthentication", "start", "stopAndDrain",
    ]);

    const firstClose = composition.closeAndDrain();
    const secondClose = composition.closeAndDrain();
    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.equal(existsSync(h.socketPath), true, "Host close must not stop the external daemon");
    assert.equal(existsSync(`${h.socketPath}.server.lock`), true,
      "Host close must not release the daemon lock");
  } finally {
    abort.abort();
    await daemon.catch(() => undefined);
    h.cleanup();
  }
});

test("canonical production root owns one exact Dashboard management session and closes it first", async () => {
  const malformed = await makeHarness("dashboard-management-malformed");
  const beforeMalformed = await malformed.store.read();
  const readMalformed = malformed.store.read.bind(malformed.store);
  let durableReads = 0;
  let getterCalls = 0;
  malformed.store.read = async () => {
    durableReads += 1;
    return readMalformed();
  };
  const malformedManagement = {
    bootstrapSecretReference: "malformed-dashboard-bootstrap-reference",
    refreshSecretReference: "malformed-dashboard-refresh-reference",
    clock: () => 1_783_700_000_000,
    runtimeVersion: managementCases.constants.runtimeVersion,
    signal: new AbortController().signal,
    io: {
      input: Object.freeze({ async *[Symbol.asyncIterator]() {} }),
      async writeFrame() {},
    },
  };
  Object.defineProperty(malformedManagement, "credentialExchangeCoordinator", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("Dashboard management getter must not run");
    },
  });
  malformed.options.dashboardManagement = malformedManagement;
  try {
    assert.equal(await relayHost.openRelayV2HostCanonicalProductionComposition(
      malformed.profile,
      malformed.options,
    ), null);
    assert.equal(getterCalls, 0);
    assert.equal(durableReads, 0);
    assert.equal((await readMalformed()).commitSeq, beforeMalformed.commitSeq);
  } finally {
    malformed.store.read = readMalformed;
    await malformed.spool.close();
    malformed.store.close();
    malformed.cleanup();
  }

  const h = await makeHarness("dashboard-management");
  const events = [];
  const input = new ControlledManagementInput(events);
  const writes = [];
  const abortController = new AbortController();
  const coordinator = new credentialExchange.RelayV2HostCredentialExchangeCoordinator({
    authority: h.options.credentialAuthority,
    httpsAdapter: {
      async bootstrap() { throw new Error("unexpected Dashboard bootstrap"); },
      async refresh() { throw new Error("unexpected Dashboard refresh"); },
    },
  });
  const managementOptions = {
    credentialExchangeCoordinator: coordinator,
    bootstrapSecretReference: "canonical-dashboard-bootstrap-reference",
    refreshSecretReference: "canonical-dashboard-refresh-reference",
    clock: () => 1_783_700_000_000,
    runtimeVersion: managementCases.constants.runtimeVersion,
    signal: abortController.signal,
    io: {
      input,
      async writeFrame(frame) { writes.push(frame); },
    },
  };
  h.options.dashboardManagement = managementOptions;
  const daemonAuthority = new terminalControl.TerminalControlAuthority({
    statePath: h.statePath,
    backend: h.terminalBackend,
  });
  const daemonAbort = new AbortController();
  const daemon = terminalControl.runTerminalControlServer({
    socketPath: h.socketPath,
    authority: daemonAuthority,
    signal: daemonAbort.signal,
    relayV2RemoteExactCompoundV1: true,
  });
  try {
    await waitForPath(h.socketPath);
    await waitForPath(exactCompound.relayV2RemoteExactCompoundSocketPathV1(h.socketPath));
    const composition = await relayHost.openRelayV2HostCanonicalProductionComposition(
      h.profile,
      h.options,
    );
    assert.notEqual(composition, null);
    const identity = await h.store.read();
    assert.deepEqual(Object.keys(composition).sort(), [
      "closeAndDrain", "inspect", "requestReauthentication", "runDashboardManagement",
      "start", "stopAndDrain",
    ]);
    for (const hidden of [
      "dashboardManagementPort", "dashboardManagementSession", "credentialAuthority",
      "credentialReference", "io", "signal",
    ]) assert.equal(Reflect.get(composition, hidden), undefined);

    assert.throws(
      () => dashboardSession.createRelayV2DashboardManagementProtocolV2CompositionSession({
        credentialAuthority: h.options.credentialAuthority,
        credentialExchangeCoordinator: coordinator,
        hostManagementPort: Object.freeze(() => null),
        hostId: HOST_ID,
        hostEpoch: identity.hostEpoch,
        hostInstanceId: h.store.hostInstanceId,
        credentialReference: CREDENTIAL_REFERENCE,
        bootstrapSecretReference: managementOptions.bootstrapSecretReference,
        refreshSecretReference: managementOptions.refreshSecretReference,
        signal: abortController.signal,
        clock: managementOptions.clock,
        runtimeVersion: managementOptions.runtimeVersion,
        io: managementOptions.io,
      }),
      dashboardSession.RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
      "a foreign management port cannot split the canonical owner",
    );

    input.push(MANAGEMENT_STATUS_FRAME);
    input.push(MANAGEMENT_START_FRAME);
    const run = composition.runDashboardManagement();
    await waitFor(() => writes.length >= 3, "management status/start did not settle");
    const frames = writes.map((frame) => JSON.parse(frame));
    assert.deepEqual(frames[0], JSON.parse(managementCases.startupReadyFrame));
    assert.equal(frames[1].requestId, JSON.parse(MANAGEMENT_STATUS_FRAME).requestId);
    assert.equal(frames[1].result.connector.status, "stopped");
    assert.equal(frames[2].requestId, JSON.parse(MANAGEMENT_START_FRAME).requestId);
    assert.equal(composition.inspect().status, "failed");
    await assert.rejects(
      composition.start({
        requestId: "canonical-dashboard-foreign-start",
        signal: new AbortController().signal,
      }),
      (error) => error?.code === "UNAVAILABLE",
      "the public facade cannot split the management-owned connector",
    );

    const closeSpool = h.spool.close.bind(h.spool);
    h.spool.close = async () => {
      events.push("spool-closed");
      return closeSpool();
    };
    const close = composition.closeAndDrain();
    assert.equal(await run, 1);
    await close;
    assert.ok(events.indexOf("management-input-closed") >= 0);
    assert.ok(events.indexOf("management-input-closed") < events.indexOf("spool-closed"));
  } finally {
    daemonAbort.abort();
    await daemon.catch(() => undefined);
    h.cleanup();
  }
});

test("canonical production root preserves a durable H0 read failure", async () => {
  const h = await makeHarness("read-failure");
  const originalRead = h.store.read;
  const failure = new Error("injected durable H0 read failure");
  h.store.read = async () => { throw failure; };
  try {
    await assert.rejects(
      relayHost.openRelayV2HostCanonicalProductionComposition(h.profile, h.options),
      (error) => error === failure,
    );
    h.store.read = originalRead;
    assert.equal(typeof (await h.store.read()).hostEpoch, "string");
  } finally {
    h.store.read = originalRead;
    await h.spool.close().catch(() => undefined);
    h.store.close();
    h.cleanup();
  }
});

test("canonical production root fails closed when the external daemon is missing", async () => {
  const h = await makeHarness("daemon-missing");
  try {
    await assert.rejects(
      relayHost.openRelayV2HostCanonicalProductionComposition(h.profile, h.options),
      /exact daemon ingress is unavailable/,
    );
    assert.equal(existsSync(`${h.socketPath}.server.lock`), false,
      "Host must never acquire the daemon server lock");
  } finally {
    h.cleanup();
  }
});
