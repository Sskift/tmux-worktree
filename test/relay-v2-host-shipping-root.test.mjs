import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const shippingRoot = await import("../dist/relay/v2/hostShippingRoot.js");
const profileStore = await import("../dist/relay/v2/hostProductionProfileStore.js");
const nativeCell = await import("../dist/relay/v2/hostCredentialAtomicFileCellNative.js");
const authorityModule = await import("../dist/relay/v2/hostCredentialAuthority.js");
const vaultModule = await import("../dist/relay/v2/hostCredentialVault.js");
const handoffModule = await import("../dist/relay/v2/hostBootstrapSecretHandoff.js");
const bootstrapSourceModule = await import("../dist/relay/v2/hostBootstrapSecretSource.js");
const codec = await import("../dist/relay/v2/codec.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const terminalControl = await import("../dist/terminalControl/index.js");
const exactCompound = await import(
  "../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);

const corpus = loadRelayV2FixtureCorpus();
const PROFILE = Object.freeze(JSON.parse(readFileSync(new URL(
  "../contracts/relay/v2/host-production-profile-v1/cases.json",
  import.meta.url,
), "utf8")).validProfile);
const BOOTSTRAP_SECRET = "twhostboot2.shipping-root-secret-never-reflected";
const V1_SECRET = "legacy-v1-shared-secret-never-promoted";
const MINT_GRANT_ID = "mint-grant-shipping-01";
const MINT_REAUTH_REQUEST_ID = "mint-reauth-request-shipping-01";
const ACCESS_EXP_S = Math.floor(Date.now() / 1_000) + 3_600;
const ACCESS_EXPIRES_AT_MS = ACCESS_EXP_S * 1_000;

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function carrierWire(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function decodeCarrier(frame) {
  const bytes = typeof frame === "string"
    ? Uint8Array.from(Buffer.from(frame, "utf8"))
    : frame;
  return codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
}

function settle(turns = 12) {
  return Array.from({ length: turns }).reduce(
    (tail) => tail.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );
}

async function waitFor(condition, label) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function privateHome(prefix) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(home, 0o700);
  return home;
}

function seedProfile(home) {
  return profileStore.loadOrCreateRelayV2HostProductionProfile({
    profile: PROFILE,
    trustedHome: home,
  });
}

/**
 * Mints a real credential envelope offline through the real handoff, vault,
 * and credential authority over a throwaway cell; the durable bytes load into
 * the fake native module. Tests never hand-encode the vault envelope.
 */
async function mintCredentialBytes() {
  const accessToken = `twcap2.${Buffer.from(JSON.stringify({
    v: 2,
    iss: "mint-shipping-issuer",
    aud: "tw-relay-ws",
    kid: "mint-shipping-kid",
    tokenUse: "access",
    role: "host",
    hostId: PROFILE.hostId,
    principalId: "mint-principal-shipping-01",
    grantId: MINT_GRANT_ID,
    iat: ACCESS_EXP_S - 3_600,
    nbf: ACCESS_EXP_S - 3_600,
    exp: ACCESS_EXP_S,
    jti: "mint-access-jti-shipping-01",
  })).toString("base64url")}.${Buffer.alloc(32, 7).toString("base64url")}`;
  const backend = { bytes: null, generation: 0 };
  const revisions = new WeakMap();
  const read = () => {
    const revision = Object.freeze(Object.create(null));
    revisions.set(revision, backend.generation);
    return Object.freeze({
      bytes: backend.bytes === null ? null : Uint8Array.from(backend.bytes),
      revision,
    });
  };
  const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
  const vault = new vaultModule.RelayV2HostCredentialVault({
    hostId: PROFILE.hostId,
    credentialReference: PROFILE.credentialReference,
    bootstrapSecretReference: PROFILE.bootstrapSecretReference,
    refreshSecretReference: PROFILE.refreshSecretReference,
    cell: {
      runExclusive: (operation) => operation(Object.freeze({
        read,
        compareAndSwap(expected, replacement) {
          if (revisions.get(expected) !== backend.generation) {
            return Object.freeze({ status: "conflict", current: read() });
          }
          backend.bytes = Uint8Array.from(replacement);
          backend.generation += 1;
          return Object.freeze({ status: "swapped" });
        },
      })),
    },
    bootstrapSecretHandoff: handoff.handoff,
  });
  const sourceHandle = bootstrapSourceModule.createRelayV2HostBootstrapSecretSource(
    Object.freeze({
      [Symbol.asyncIterator]() {
        let sent = false;
        return Object.freeze({
          next: () => {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({
              done: false,
              value: Uint8Array.from(Buffer.from(`${BOOTSTRAP_SECRET}\n`, "utf8")),
            });
          },
        });
      },
      cancel: () => Promise.resolve(),
    }),
    handoff.privilegedIntake,
  );
  vault.provisionBootstrap(await sourceHandle.readCandidate());
  await sourceHandle.closeAndDrain();
  const authority = new authorityModule.RelayV2HostCredentialAuthority({
    storage: vault,
    secretResolver: vault,
  });
  const prepared = authority.prepareBootstrap({
    credentialReference: PROFILE.credentialReference,
    hostId: PROFILE.hostId,
    attemptId: "mint-bootstrap-attempt-01",
    oldSecretReference: PROFILE.bootstrapSecretReference,
  });
  const applied = authority.applyBootstrapResponse(prepared.fence, {
    bootstrapAttemptId: "mint-bootstrap-attempt-01",
    principalId: "mint-principal-shipping-01",
    grantId: MINT_GRANT_ID,
    hostId: PROFILE.hostId,
    accessToken,
    accessExpiresAtMs: ACCESS_EXPIRES_AT_MS,
    refreshToken: "twref2.mint-shipping-refresh",
    refreshExpiresAtMs: ACCESS_EXPIRES_AT_MS + 86_400_000,
  });
  assert.equal(applied.status, "applied");
  const reauth = authority.prepareReauthentication({
    credentialReference: PROFILE.credentialReference,
    requestId: MINT_REAUTH_REQUEST_ID,
  });
  assert.equal(reauth.accessToken, accessToken);
  await vault.closeAndDrain();
  await handoff.closeAndDrain();
  assert.ok(backend.bytes !== null);
  return { bytes: backend.bytes, accessToken };
}

function createNativeModule(events, { initialBytes = null } = {}) {
  const ABI_VERSION = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION;
  const OPEN_METHOD = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_OPEN_METHOD;
  const state = {
    bytes: initialBytes === null ? null : Uint8Array.from(initialBytes),
    generation: 0,
    openCalls: 0,
    closeCalls: 0,
  };
  const revisions = new WeakMap();
  const result = (operation, outcome, fields = {}) => ({
    abiVersion: ABI_VERSION, operation, outcome, ...fields,
  });
  const issueCurrent = () => {
    const revision = Object.freeze(Object.create(null));
    revisions.set(revision, state.generation);
    return state.bytes === null
      ? { state: "empty", revision }
      : { state: "present", revision, bytes: state.bytes };
  };
  const handle = Object.freeze({
    read: () => result("read", "ok", { current: issueCurrent() }),
    compareAndSwap(request) {
      if (revisions.get(request.revision) !== state.generation) {
        return result("compare_and_swap", "conflict", { current: issueCurrent() });
      }
      state.bytes = Uint8Array.from(request.bytes);
      state.generation += 1;
      return result("compare_and_swap", "swapped");
    },
    close() {
      state.closeCalls += 1;
      events.push("cell-closed");
      return result("close", "closed");
    },
  });
  return {
    state,
    module: Object.freeze({
      [OPEN_METHOD]() {
        state.openCalls += 1;
        return result("open", "opened", { handle });
      },
    }),
  };
}

function createDiscovery() {
  const state = { calls: 0, fail: null };
  return {
    state,
    port: {
      async scan() {
        state.calls += 1;
        if (state.fail !== null) throw state.fail;
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
            // 稳定 generation：周期 scan 与首轮语义一致，不制造代际更替。
            generation: "shipping-discovery-1",
            scopeTargets: [{
              scopeBackendIdentity: "local",
              processTarget: { kind: "local", targetId: "local" },
              capabilities: ["session.list"],
            }],
            sessionTargets: [],
            isCurrent: () => true,
          },
        };
      },
    },
  };
}

// Carrier frames are text; the fake socket must forward them untouched, the
// same way the real `ws` delivery distinguishes text from binary.
function createFakeWss(records, effects) {
  return class FakeShippingWss {
    readyState = 1;
    protocol = "tw-relay.host.v2";
    extensions = "";
    listeners = new Map();

    constructor(address, protocols, options) {
      effects.constructions += 1;
      const record = {
        sequence: records.length + 1,
        address,
        protocols: [...protocols],
        headers: [],
        sent: [],
        closes: [],
        socket: this,
        hello: null,
        registeredConnectorId: null,
      };
      records.push(record);
      options.finishRequest({
        setHeader: (name, value) => record.headers.push([name, value]),
        end() {},
        destroy() {},
      }, this);
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    removeListener(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    }

    send(frame, options, callback) {
      const record = records.find((candidate) => candidate.socket === this);
      const kept = typeof frame === "string" ? frame : Uint8Array.from(frame);
      record.sent.push(kept);
      record.hello ??= decodeCarrier(kept);
      queueMicrotask(() => callback());
    }

    close(code, reason) {
      records.find((candidate) => candidate.socket === this).closes.push({ code, reason });
      this.readyState = 3;
      for (const listener of this.listeners.get("close") ?? []) listener(code);
    }

    terminate() {
      this.readyState = 3;
      for (const listener of this.listeners.get("close") ?? []) listener(1006);
    }

    receive(frame) {
      const isBinary = typeof frame !== "string";
      for (const listener of this.listeners.get("message") ?? []) listener(frame, isBinary);
    }
  };
}

function registeredFrame(record) {
  const registered = fixture("host-registered");
  registered.requestId = record.hello.requestId;
  registered.connectorId = `shipping-connector-${record.sequence}`;
  registered.payload.disposition = "connected";
  registered.payload.supersededHostInstanceId = null;
  record.registeredConnectorId = registered.connectorId;
  return carrierWire(registered);
}

function authExpiringFrame(record) {
  const frame = fixture("host-auth-expiring");
  frame.connectorId = record.registeredConnectorId;
  frame.payload.grantId = MINT_GRANT_ID;
  return carrierWire(frame);
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${path}`);
}

function noEffectBackend() {
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

async function makeHarness(label, home, { initialBytes = null } = {}) {
  const events = [];
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `tw-relay-v2-ship-${label}-`)));
  chmodSync(root, 0o700);
  const socketPath = join(tmpdir(), `twv2-ship-${process.pid}-${label}-${root.slice(-6)}.sock`);
  const native = createNativeModule(events, { initialBytes });
  const discovery = createDiscovery();
  const wssRecords = [];
  const wssEffects = { constructions: 0 };
  const harness = {
    home,
    events,
    native,
    discovery,
    socketPath,
    wss: { records: wssRecords, effects: wssEffects, ctor: createFakeWss(wssRecords, wssEffects) },
    effects: { welcome: 0, create: 0, process: 0, remote: 0 },
    async openDaemon() {
      const authority = new terminalControl.TerminalControlAuthority({
        statePath: join(root, "terminal-control-state-v1.json"),
        backend: noEffectBackend(),
      });
      const abort = new AbortController();
      const running = terminalControl.runTerminalControlServer({
        socketPath,
        authority,
        signal: abort.signal,
        relayV2RemoteExactCompoundV1: true,
      });
      await waitForPath(socketPath);
      await waitForPath(exactCompound.relayV2RemoteExactCompoundSocketPathV1(socketPath));
      harness.daemon = {
        async close() {
          abort.abort();
          await running.catch(() => undefined);
        },
      };
    },
    options(overrides = {}) {
      return {
        trustedHome: home,
        deployment: {
          nativeModuleTarget: overrides.nativeModuleTarget ?? {
            platform: process.platform,
            architecture: process.arch,
            napiVersion: 9,
          },
          nativeModuleLoader: overrides.nativeModuleLoader
            ?? (() => ({ status: "loaded", binding: harness.native.module })),
          createTargetExecution: "createTargetExecution" in overrides
            ? overrides.createTargetExecution
            : {
                createTargetAuthority: {
                  async resolveCreateTarget() {
                    harness.effects.create += 1;
                    throw new Error("unexpected create resolution");
                  },
                  fenceCreateTargetForAdmission() {
                    harness.effects.create += 1;
                    throw new Error("unexpected create fence");
                  },
                },
                process: {
                  async execute() {
                    harness.effects.process += 1;
                    throw new Error("unexpected process execution");
                  },
                },
              },
          ...(overrides.reauthentication === undefined
            ? {}
            : { reauthentication: overrides.reauthentication }),
          wssTransport: {
            webSocketConstructor: harness.wss.ctor,
            scheduleCloseDrain: () => () => undefined,
          },
        },
        runtime: {
          discovery: discovery.port,
          localProcessTarget: { kind: "local", targetId: "local" },
          remoteCompoundChannels: {
            async open() {
              harness.effects.remote += 1;
              throw new Error("unexpected remote compound target");
            },
          },
          terminalControlDaemonSocketPath: socketPath,
          scanIntervalMs: overrides.scanIntervalMs ?? 2_147_483_647,
        },
      };
    },
    cleanup() {
      rmSync(socketPath, { force: true });
      rmSync(`${socketPath}.server.lock`, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
  return harness;
}

async function startOnce(handle, harness, requestId) {
  const pending = handle.start({ requestId, signal: new AbortController().signal });
  await settle();
  const record = harness.wss.records.at(-1);
  record.socket.receive(registeredFrame(record));
  const started = await pending;
  assert.equal(started.status, "started");
  return { started, record };
}

function reauthenticateFrames(record, fromIndex) {
  return record.sent.slice(fromIndex).map(decodeCarrier)
    .filter((frame) => frame.type === "host.reauthenticate");
}

function assertRedacted(error, code) {
  assert.equal(error?.code, code);
  const diagnostic = `${String(error)}\n${String(error?.stack)}\n${JSON.stringify(error)}`;
  for (const forbidden of [BOOTSTRAP_SECRET, V1_SECRET]) {
    assert.equal(diagnostic.includes(forbidden), false);
  }
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

test("inputs, profile, and native source all fail closed before any socket", async (t) => {
  await t.test("absent or malformed inputs fail with fixed redacted codes", async () => {
    const home = privateHome("tw-relay-v2-ship-inputs-");
    seedProfile(home);
    const h = await makeHarness("inputs", home);
    const base = h.options();
    const cases = [
      [null, "INPUTS_UNAVAILABLE"],
      [{}, "INPUTS_UNAVAILABLE"],
      [new Proxy(base, {}), "INPUTS_UNAVAILABLE"],
      [{ ...base, deployment: undefined }, "INPUTS_UNAVAILABLE"],
      [{ ...base, runtime: undefined }, "INPUTS_UNAVAILABLE"],
      [{ ...base, deployment: { ...base.deployment, nativeModuleLoader: 1 } }, "INPUTS_INVALID"],
      [{ ...base, deployment: { ...base.deployment, createTargetExecution: undefined } },
        "INPUTS_UNAVAILABLE"],
      [{ ...base, deployment: { ...base.deployment, createTargetExecution: new Proxy({}, {}) } },
        "INPUTS_INVALID"],
      [{ ...base, runtime: { ...base.runtime, discovery: null } }, "INPUTS_INVALID"],
      [{ ...base, runtime: { ...base.runtime, localProcessTarget: { kind: "ssh", targetId: "x" } } },
        "INPUTS_INVALID"],
      [{ ...base, runtime: { ...base.runtime, remoteCompoundChannels: undefined } },
        "INPUTS_UNAVAILABLE"],
      [{ ...base, runtime: { ...base.runtime, scanIntervalMs: 0 } }, "INPUTS_INVALID"],
    ];
    for (const [options, code] of cases) {
      await assert.rejects(
        shippingRoot.startRelayV2HostShippingRoot(options),
        (error) => assertRedacted(error, code),
      );
    }
    assert.equal(h.native.state.openCalls, 0);
    assert.equal(h.wss.effects.constructions, 0);
    h.cleanup();
  });

  await t.test("missing or corrupt profile fails typed without filesystem mutation", async () => {
    const missingHome = privateHome("tw-relay-v2-ship-noprofile-");
    const h1 = await makeHarness("noprofile", missingHome);
    await assert.rejects(
      shippingRoot.startRelayV2HostShippingRoot(h1.options()),
      (error) => error?.name === "RelayV2HostProductionProfileStoreError"
        && error?.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND",
    );
    assert.equal(existsSync(join(missingHome, ".tmux-worktree")), false);
    h1.cleanup();

    const corruptHome = privateHome("tw-relay-v2-ship-corrupt-");
    seedProfile(corruptHome);
    writeFileSync(
      profileStore.relayV2HostProductionProfilePath(corruptHome),
      `{"contract":"forged","secret":"${BOOTSTRAP_SECRET}"`,
      { encoding: "utf8", mode: 0o600 },
    );
    const h2 = await makeHarness("corrupt", corruptHome);
    await assert.rejects(
      shippingRoot.startRelayV2HostShippingRoot(h2.options()),
      (error) => {
        assert.equal(error?.name, "RelayV2HostProductionProfileStoreError");
        const diagnostic = `${String(error)}\n${JSON.stringify(error)}`;
        assert.equal(diagnostic.includes(BOOTSTRAP_SECRET), false);
        assert.equal(diagnostic.includes("forged"), false);
        return true;
      },
    );
    h2.cleanup();
  });

  await t.test("unsupported, missing, or invalid native sources fail before the bridge", async () => {
    const home = privateHome("tw-relay-v2-ship-native-");
    seedProfile(home);
    const h = await makeHarness("native", home);
    const cases = [
      [{ nativeModuleTarget: { platform: "plan9", architecture: "x64", napiVersion: 9 } },
        "NATIVE_TARGET_UNSUPPORTED"],
      [{ nativeModuleTarget: { platform: "darwin", architecture: "arm64", napiVersion: 1 } },
        "NATIVE_INTERFACE_UNSUPPORTED"],
      [{ nativeModuleLoader: () => ({ status: "missing" }) }, "NATIVE_ARTIFACT_MISSING"],
      [{
        nativeModuleLoader: () => ({
          status: "loaded",
          binding: Object.freeze({ async openRelayV2HostCredentialAtomicFileCellV1() {} }),
        }),
      }, "NATIVE_MODULE_INVALID"],
    ];
    for (const [overrides, code] of cases) {
      await assert.rejects(
        shippingRoot.startRelayV2HostShippingRoot(h.options(overrides)),
        (error) => assertRedacted(error, code),
      );
    }
    assert.equal(h.native.state.openCalls, 0);
    assert.equal(h.wss.effects.constructions, 0);
    h.cleanup();
  });
});

test("full chain assembles once: reconcile lifecycle, exact lineage start/stop, reauth cut, close fence", async () => {
  const home = privateHome("tw-relay-v2-ship-full-");
  seedProfile(home);
  const minted = await mintCredentialBytes();
  const h = await makeHarness("full", home, { initialBytes: minted.bytes });
  await h.openDaemon();
  const scheduleLog = [];
  const previousSecret = process.env.TW_RELAY_SECRET;
  process.env.TW_RELAY_SECRET = V1_SECRET;
  try {
    const handle = await shippingRoot.startRelayV2HostShippingRoot(h.options({
      scanIntervalMs: 30,
      reauthentication: {
        idFactory: () => "mint-reauth-id",
        schedule: (delayMs, callback) => {
          const entry = { delayMs, callback, cancelled: false };
          scheduleLog.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
      },
    }));
    assert.equal(Object.getPrototypeOf(handle), null);
    assert.deepEqual(Reflect.ownKeys(handle).sort(), [
      "closeAndDrain", "inspect", "start", "stopAndDrain",
    ]);
    assert.deepEqual(handle.inspect(), { status: "stopped", controllerGeneration: "0" });
    // 首轮 reconcile 是 open 的前置；周期 scan 由 lifecycle owner 自己的 timer 驱动。
    const startupCalls = h.discovery.state.calls;
    assert.ok(startupCalls >= 1);
    await waitFor(() => h.discovery.state.calls > startupCalls, "periodic reconcile");
    assert.equal(h.native.state.openCalls, 1, "real native wrapper opened the cell once");

    // signal-before-start fails closed before any socket。
    const aborted = new AbortController();
    aborted.abort();
    const abortedOutcome = await handle.start({
      requestId: "ship.full.aborted",
      signal: aborted.signal,
    }).then((result) => ({ result }), (error) => ({ error }));
    assert.equal(h.wss.effects.constructions, 0);
    assert.equal(abortedOutcome.result, undefined);

    const first = await startOnce(handle, h, "ship.full.start.1");
    assert.equal(h.wss.effects.constructions, 1);
    // WSS root 只来自运行时 profile store；Authorization 由 credential authority 写入。
    assert.equal(first.record.address, "wss://relay.example.test/host");
    assert.deepEqual(first.record.protocols, ["tw-relay.host.v2"]);
    const authorization = first.record.headers.find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    assert.equal(authorization?.[1], `Bearer ${minted.accessToken}`);
    // exact profile lineage；协商交集保持空，不宣告 readiness/capability。
    assert.equal(first.started.hostId, PROFILE.hostId);
    assert.equal(first.started.credentialReference, PROFILE.credentialReference);
    const inspection = handle.inspect();
    assert.equal(inspection.status, "registered_incomplete");
    assert.deepEqual(inspection.negotiatedCapabilityIntersection, []);

    // auth.expiring 进入同 lineage 的真实 reauth owner：只重放 exact durable pending request。
    const beforeFirst = first.record.sent.length;
    first.record.socket.receive(authExpiringFrame(first.record));
    await settle();
    const firstReauth = reauthenticateFrames(first.record, beforeFirst);
    assert.equal(firstReauth.length, 1);
    assert.equal(firstReauth[0].requestId, MINT_REAUTH_REQUEST_ID);
    assert.equal(firstReauth[0].connectorId, first.record.registeredConnectorId);

    const stopped = await handle.stopAndDrain({
      requestId: "ship.full.stop.1",
      controllerGeneration: inspection.controllerGeneration,
      connectorId: inspection.connectorId,
      signal: new AbortController().signal,
    });
    assert.equal(stopped.status, "stopped_and_drained");

    // 新 connector 绑新 exact cut；stale socket 静默，durable request identity 不重新铸造。
    const second = await startOnce(handle, h, "ship.full.start.2");
    assert.notEqual(second.started.controllerGeneration, first.started.controllerGeneration);
    const staleSent = first.record.sent.length;
    const beforeSecond = second.record.sent.length;
    second.record.socket.receive(authExpiringFrame(second.record));
    await settle();
    const secondReauth = reauthenticateFrames(second.record, beforeSecond);
    assert.equal(secondReauth.length, 1);
    assert.equal(secondReauth[0].requestId, MINT_REAUTH_REQUEST_ID);
    assert.equal(secondReauth[0].connectorId, second.record.registeredConnectorId);
    assert.equal(first.record.sent.length, staleSent);

    // v1 shared secret 与 bootstrap secret 都不上 wire、不进 header。
    const wire = second.record.sent.concat(first.record.sent)
      .map((frame) => (typeof frame === "string" ? frame : Buffer.from(frame).toString("utf8")))
      .join("\n");
    assert.equal(wire.includes(V1_SECRET), false);
    assert.equal(wire.includes(BOOTSTRAP_SECRET), false);
    assert.equal(JSON.stringify(first.record.headers).includes(V1_SECRET), false);

    // close fence：先拒新工作，drain 后幂等；replay timer 取消且 late fire 零帧；lifecycle 停摆。
    const closing = handle.closeAndDrain();
    assert.equal(handle.closeAndDrain(), closing);
    assert.throws(
      () => handle.start({ requestId: "ship.full.late", signal: new AbortController().signal }),
      (error) => error?.code === "COMPOSITION_CLOSED",
    );
    assert.throws(() => handle.inspect(), (error) => error?.code === "COMPOSITION_CLOSED");
    await closing;
    assert.equal(h.native.state.closeCalls, 1);
    assert.ok(second.record.closes.length > 0, "managed drain closed the connector socket");
    assert.ok(scheduleLog.length > 0 && scheduleLog.some((entry) => entry.cancelled));
    const secondSent = second.record.sent.length;
    for (const entry of scheduleLog) entry.callback();
    await settle();
    assert.equal(second.record.sent.length, secondSent);
    const callsAfterClose = h.discovery.state.calls;
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(h.discovery.state.calls, callsAfterClose);
    // 既有 owner 复用而非复制：没有 fake lane 被驱动。
    assert.deepEqual(h.effects, { welcome: 0, create: 0, process: 0, remote: 0 });
  } finally {
    if (previousSecret === undefined) delete process.env.TW_RELAY_SECRET;
    else process.env.TW_RELAY_SECRET = previousSecret;
    await h.daemon.close();
    h.cleanup();
  }
});

test("startup failures roll back so the same home opens cleanly afterwards", async () => {
  const home = privateHome("tw-relay-v2-ship-rollback-");
  seedProfile(home);
  const h = await makeHarness("rollback", home);
  const hostStateModule = await import("../dist/relay/v2/hostState.js");
  const reopenStore = async () => {
    const store = await hostStateModule.RelayV2HostStateStore.open({
      paths: hostStateModule.relayV2HostStatePaths(home),
    });
    await store.close();
  };

  // 首轮 reconcile 失败：bridge/socket 之前 fail closed，lifecycle/store 已回滚。
  h.discovery.state.fail = new Error("injected reconcile failure");
  await assert.rejects(
    shippingRoot.startRelayV2HostShippingRoot(h.options()),
    (error) => assertRedacted(error, "RECONCILE_FAILED"),
  );
  assert.equal(h.native.state.openCalls, 0);
  assert.equal(h.wss.effects.constructions, 0);
  await reopenStore();

  // spool 开启后的晚期输入失败同样干净回滚（Proxy pair seam）。
  h.discovery.state.fail = null;
  await assert.rejects(
    shippingRoot.startRelayV2HostShippingRoot(
      h.options({ createTargetExecution: new Proxy({}, {}) }),
    ),
    (error) => assertRedacted(error, "INPUTS_INVALID"),
  );
  await reopenStore();
  assert.equal(h.native.state.openCalls, 0);
  h.cleanup();
});
