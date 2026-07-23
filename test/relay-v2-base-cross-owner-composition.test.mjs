import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";
import { InMemoryRelayV2BrokerCredentialStateStore } from "./support/inMemoryRelayV2BrokerCredentialStateStore.mjs";

const broker = await import("../dist/relay/v2/brokerCore.js");
const brokerCredential = await import("../dist/relay/v2/brokerCredentialAuthority.js");
const canonicalBackendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");
const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const continuity = await import("../dist/relay/v2/continuityAnchor.js");
const hostCredential = await import("../dist/relay/v2/hostCredentialAuthority.js");
const hostRuntimeComposition = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const issuer = await import("../dist/relay/v2/issuer.js");
const relayServer = await import("../dist/relayServer.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const terminalDurable = await import("../dist/relay/v2/terminalDurableLineage.js");
const terminalManager = await import("../dist/relay/v2/terminalManager.js");

const corpus = loadRelayV2FixtureCorpus();
const HOST_ID = "base-v2-cross-owner-host";
const CLIENT_INSTANCE_ID = "base-v2-cross-owner-client";
const HOST_EPOCH = "base-v2-cross-owner-epoch";
const HOST_INSTANCE_ID = "base-v2-cross-owner-instance";
const CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:base-v2-cross-owner";
const ANCHOR_ID = "base-v2-cross-owner-anchor";
const NOW_MS = Date.now();
const ISSUER_SECRET = Buffer.alloc(32, 0x4d).toString("base64url");
const MANAGED_INCARNATION = `twinc2.${"a".repeat(43)}`;

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function clone(value) {
  return structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(turns = 3) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(probe, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class MemoryContinuityAuthority {
  token = 0;
  current = {
    protocolVersion: continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
    status: "uninitialized",
    anchorId: ANCHOR_ID,
    casToken: "cas-0",
  };

  async read(request) {
    assert.equal(request.anchorId, ANCHOR_ID);
    assert.equal(request.signal instanceof AbortSignal, true);
    return clone(this.current);
  }

  async compareAndSwap(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        outcome: "conflict",
        current: clone(this.current),
      };
    }
    this.token += 1;
    this.current = {
      protocolVersion: continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "committed",
      anchorId: ANCHOR_ID,
      casToken: `cas-${this.token}`,
      checkpoint: clone(request.next),
    };
    return {
      protocolVersion: continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      outcome: "swapped",
      current: clone(this.current),
    };
  }
}

function brokerCredentialOptions(store, external, liveAuthorizationFence) {
  let id = 0;
  let byte = 0;
  return {
    store,
    continuityAnchor: {
      anchorId: ANCHOR_ID,
      authority: external,
      operationTimeoutMs: 500,
    },
    genesis: {
      issuerKeyring: issuer.createRelayV2IssuerKeyring({
        issuerId: "base-v2-cross-owner-issuer",
        kid: "base-v2-cross-owner-kid",
        secretBase64url: ISSUER_SECRET,
        nowSeconds: Math.floor(NOW_MS / 1_000),
      }),
      issuerUrl: "https://relay.invalid/",
      relayUrl: "wss://relay.invalid/client",
    },
    now: () => NOW_MS,
    randomId: () => `base-v2-id-${++id}`,
    randomBytes(length) {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        output[index] = (byte + index + 1) % 256;
      }
      byte = (byte + length) % 256;
      return output;
    },
    liveAuthorizationFence,
  };
}

async function createHostGrant(authority) {
  const bootstrap = await authority.adminCreateHostBootstrap();
  const sourceKey = "base-v2-host-bootstrap-source";
  const admission = await authority.admitHttpSource({
    endpoint: "host_bootstrap",
    sourceKey,
  });
  return authority.bootstrapHost(admission, sourceKey, {
    bootstrapAttemptId: "base-v2-host-bootstrap-attempt",
    bootstrapToken: bootstrap.bootstrapToken,
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
  });
}

async function createClientGrant(authority, hostAuthorization, ordinal) {
  const enrollment = await authority.handle({
    type: "enrollment.create",
    requestId: `base-v2-enrollment-${ordinal}`,
    connectorId: "base-v2-credential-control",
    payload: {
      expiresInMs: 300_000,
      deviceLabel: `bounded-client-${ordinal}`,
    },
    currentAuthContext: hostAuthorization,
  });
  assert.equal(enrollment.outcome, "success");
  const sourceKey = `base-v2-enrollment-source-${ordinal}`;
  const admission = await authority.admitHttpSource({
    endpoint: "enrollment_redeem",
    sourceKey,
  });
  return authority.redeemEnrollment(admission, sourceKey, {
    exchangeAttemptId: `base-v2-enrollment-exchange-${ordinal}`,
    enrollmentId: enrollment.response.payload.enrollmentId,
    enrollmentCode: enrollment.response.payload.enrollmentCode,
    clientInstanceId: ordinal === 1
      ? CLIENT_INSTANCE_ID
      : `${CLIENT_INSTANCE_ID}-${ordinal}`,
    deviceLabel: `bounded-client-${ordinal}`,
  });
}

function createHostCredentialAuthority(grant, authorization) {
  let revision = 1;
  let state = {
    credentialVersion: "1",
    hostId: grant.body.hostId,
    principalId: grant.body.principalId,
    grantId: grant.body.grantId,
    accessToken: grant.body.accessToken,
    accessExpiresAtMs: grant.body.accessExpiresAtMs,
    refreshToken: grant.body.refreshToken,
    refreshExpiresAtMs: grant.body.refreshExpiresAtMs,
    accessJti: authorization.jti,
    pendingCredentialAttempt: null,
    pendingReauthentication: null,
  };
  return new hostCredential.RelayV2HostCredentialAuthority({
    storage: {
      runExclusive(reference, operation) {
        assert.equal(reference, CREDENTIAL_REFERENCE);
        return operation({
          read() {
            return { state: clone(state), revision };
          },
          compareAndSwap(expected, replacement) {
            if (expected !== revision) {
              return {
                status: "conflict",
                current: { state: clone(state), revision },
              };
            }
            state = clone(replacement);
            revision += 1;
            return { status: "swapped" };
          },
        });
      },
    },
    secretResolver: {
      resolve() {
        throw new Error("base-v2 WSS must not resolve refresh/bootstrap material");
      },
    },
  });
}

class LoopbackHostWebSocket extends WebSocket {
  static evidence = [];

  constructor(address, protocols, options) {
    const target = new URL(address);
    assert.equal(target.protocol, "wss:");
    target.protocol = "ws:";
    super(target.toString(), protocols, options);
    this.on("open", () => LoopbackHostWebSocket.evidence.push({ type: "open" }));
    this.on("unexpected-response", (_request, response) => {
      LoopbackHostWebSocket.evidence.push({
        type: "unexpected-response",
        status: response.statusCode,
      });
      response.resume();
    });
    this.on("error", (error) => LoopbackHostWebSocket.evidence.push({
      type: "error",
      message: error.message,
    }));
    this.on("close", (code, reason) => LoopbackHostWebSocket.evidence.push({
      type: "close",
      code,
      reason: reason.toString(),
    }));
  }
}

class QueueDiscovery {
  scans = [];

  push(scan) {
    this.scans.push(clone(scan));
  }

  async scan() {
    const scan = this.scans.shift();
    if (!scan) throw new Error("unexpected base-v2 discovery scan");
    return clone(scan);
  }
}

function terminalDiscovery(activityAtMs = NOW_MS) {
  return {
    coverage: "complete",
    scopes: [{
      backendIdentity: "local",
      displayName: "Local",
      kind: "local",
      reachability: "online",
      sessionsCompleteness: "complete",
      sessions: [{
        backendIdentity: "base-v2-terminal-backend",
        kind: "terminal",
        displayName: "Base v2 terminal",
        state: "running",
        project: null,
        label: "Base v2 terminal",
        cwd: "/repo/base-v2",
        attached: false,
        windowCount: 1,
        createdAtMs: NOW_MS - 1_000,
        activityAtMs,
      }],
      error: null,
    }],
  };
}

function commandResolutionFence(request) {
  return {
    schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
    outcome: "positive",
    authority: request.authority,
    operation: request.operation,
    expectedScopeId: request.scopeId,
    expectedSessionId: request.sessionId,
    target: { boundedTarget: request.sessionId },
    evidence: {
      resolverToken: "base-v2-command-cut",
      expectedScopeId: request.scopeId,
      expectedSessionId: request.sessionId,
      result: "positive",
    },
  };
}

function createCommandExecutor(executionEntered, releaseExecution) {
  return {
    async resolve(request) {
      return {
        kind: "executable",
        adapterState: { boundedTarget: request.sessionId },
        resolutionFence: commandResolutionFence(request),
      };
    },
    fenceResolution() {},
    async executeTwRpc() {
      throw new Error("base-v2 command must use the canonical terminal-control lane");
    },
    async executeTerminalControl(plan) {
      executionEntered.resolve(clone(plan));
      await releaseExecution.promise;
      return {
        state: "succeeded",
        result: {
          pane: plan.arguments.pane,
          submit: plan.arguments.submit,
          messageUtf8Bytes: Buffer.byteLength(plan.arguments.message, "utf8"),
        },
      };
    },
  };
}

class BoundedTerminalBackend {
  handles = [];

  async open(_target, _options, observer) {
    const handle = {
      closed: false,
      observer,
      async pause() {},
      async resume() {},
      async setDisplaySizeHint() {},
      async close() { handle.closed = true; },
      async emit(bytes) { await observer.onBytes(Buffer.from(bytes)); },
    };
    this.handles.push(handle);
    return handle;
  }
}

class BoundedTerminalControlAuthority {
  writes = [];

  lease(target, owner) {
    return {
      controlTargetId: target.resolvedTarget.controlTargetId,
      controlEpoch: target.binding.exactControlIdentity.controlEpoch,
      leaseId: "base-v2-terminal-lease",
      fence: "base-v2-terminal-lease-fence",
      owner: clone(owner),
      expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    };
  }

  async acquire(input) {
    return { status: "accepted", lease: this.lease(input.target, input.owner) };
  }

  async renew(input) {
    return { status: "accepted", lease: this.lease(input.target, input.owner) };
  }

  async release() {}

  async hasContinuity() { return true; }

  async writeInput(input) {
    this.writes.push(Buffer.from(input.data));
    return { accepted: true };
  }

  async resize() { return { accepted: true }; }
}

function createTerminalResolver(hostEpoch) {
  const processTarget = { kind: "local", targetId: "base-v2-process-target" };
  const backendInstanceKey = canonicalBackendIdentity.issueRelayV2CanonicalBackendInstanceKey({
    processTarget,
    incarnation: MANAGED_INCARNATION,
  });
  return {
    async resolve(input) {
      const managedTarget = {
        name: "base-v2-managed-terminal",
        kind: "terminal",
        incarnation: MANAGED_INCARNATION,
      };
      const exactControlIdentity = {
        schemaVersion: 1,
        controlTargetId: "base-v2-control-target",
        controlEpoch: "base-v2-control-epoch",
        targetIncarnationProof: "base-v2-incarnation-proof",
      };
      const binding = {
        schemaVersion: 1,
        ...clone(input.target),
        pane: input.pane,
        processTarget: clone(processTarget),
        backendInstanceKey,
        managedTarget,
        exactControlIdentity,
      };
      return {
        target: {
          ...clone(input.target),
          pane: input.pane,
          canonicalTargetId: backendInstanceKey,
          controlTargetId: exactControlIdentity.controlTargetId,
        },
        binding,
        admission: {
          resourceToken: {
            schemaVersion: 1,
            hostEpoch,
            resourceMappingDigest: "base-v2-resource-mapping",
            discoveryGeneration: "base-v2-discovery-generation",
          },
          resourceTarget: {
            authorization: "evidence_only",
            hostEpoch,
            discoveryGeneration: "base-v2-discovery-generation",
            scopeId: input.target.scopeId,
            processTarget: clone(processTarget),
            capabilities: ["terminal.stream.v1"],
            sessionId: input.target.sessionId,
            backendInstanceKey,
            managedTarget: clone(managedTarget),
          },
          exactControlToken: "base-v2-exact-control-token",
        },
      };
    },
    fenceSessionForAdmission() {},
  };
}

function createClientSocket(url, accessToken) {
  const socket = new WebSocket(url, "tw-relay.v2", {
    headers: { Authorization: `Bearer ${accessToken}` },
    perMessageDeflate: false,
  });
  const frames = [];
  const errors = [];
  const closes = [];
  socket.on("message", (data) => {
    frames.push(codec.decodeRelayV2WebSocketFrame("public", Buffer.from(data)).frame);
  });
  socket.on("error", (error) => errors.push(error));
  socket.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
  return { socket, frames, errors, closes };
}

function sendFrame(socket, frame) {
  const bytes = codec.encodeRelayV2WebSocketFrame("public", frame);
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(bytes).toString("utf8"), (error) => {
      if (error == null) resolve();
      else reject(error);
    });
  });
}

function waitForFrame(connection, predicate, message) {
  return waitFor(() => connection.frames.find(predicate), message);
}

async function openAndHandshakeClient(url, accessToken, clientInstanceId) {
  const connection = createClientSocket(url, accessToken);
  await once(connection.socket, "open");
  const relayWelcome = await waitForFrame(
    connection,
    (frame) => frame.type === "relay.welcome",
    "client did not receive relay.welcome",
  );
  assert.equal(connection.frames[0], relayWelcome);
  assert.deepEqual(relayWelcome.payload.capabilities, [...broker.RELAY_V2_REQUIRED_CAPABILITIES]);
  const hello = fixture("client-hello-fresh");
  hello.requestId = randomUUID();
  hello.hostId = HOST_ID;
  hello.payload.clientInstanceId = clientInstanceId;
  hello.payload.capabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  hello.payload.requiredCapabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  await sendFrame(connection.socket, hello);
  let hostWelcome;
  try {
    hostWelcome = await waitForFrame(
      connection,
      (frame) => frame.type === "host.welcome" && frame.requestId === hello.requestId,
      "client did not receive host.welcome",
    );
  } catch (error) {
    const evidence = {
      frames: clone(connection.frames),
      closes: clone(connection.closes),
      errors: connection.errors.map((candidate) => candidate.message),
      hostSocket: clone(LoopbackHostWebSocket.evidence),
    };
    error.cause = evidence;
    throw error;
  }
  assert.equal(connection.frames[1], hostWelcome);
  assert.deepEqual(hostWelcome.payload.capabilities, [...broker.RELAY_V2_REQUIRED_CAPABILITIES]);
  return { ...connection, relayWelcome, hostWelcome };
}

function waitForSocketClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve({ code: socket._closeCode, reason: socket._closeMessage?.toString() ?? "" });
  }
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function rejectedClientUpgrade(url, accessToken) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, "tw-relay.v2", {
      headers: { Authorization: `Bearer ${accessToken}` },
      perMessageDeflate: false,
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.terminate(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ opened: false, status: null }), 2_000);
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? null;
      response.resume();
      finish({ opened: false, status });
    });
    socket.once("open", () => finish({ opened: true, status: 101 }));
    socket.once("error", () => finish({ opened: false, status: null }));
  });
}

function firstSnapshotRequest(hostEpoch) {
  return {
    principalId: "base-v2-recovery-principal",
    clientInstanceId: "base-v2-recovery-client",
    expectedHostEpoch: hostEpoch,
    snapshotRequestId: "base-v2-recovery-snapshot",
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  };
}

test("isolated base-v2 composition crosses activated Broker and canonical managed Host owners", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-cross-owner-"));
  const brokerStore = new InMemoryRelayV2BrokerCredentialStateStore();
  const externalContinuity = new MemoryContinuityAuthority();
  const clients = [];
  let authority = null;
  let server = null;
  let hostComposition = null;
  let spool = null;
  let store = null;
  let oldTerminalHandle = null;
  try {
    server = await relayServer.startRelayBroker({
      host: "127.0.0.1",
      port: 0,
      secret: "base-v2-bounded-legacy-secret",
    }, {
      async openCredentialAuthority({ liveAuthorizationFence }) {
        authority = await brokerCredential.RelayV2BrokerCredentialAuthority.open(
          brokerCredentialOptions(brokerStore, externalContinuity, liveAuthorizationFence),
        );
        return authority;
      },
      resolveHttpSourceKey(socket) {
        return `loopback:${socket.remoteAddress ?? "unknown"}`;
      },
    });
    assert.notEqual(authority, null);

    const hostGrant = await createHostGrant(authority);
    const hostAuthorization = await authority.authorizeAccessToken(
      hostGrant.body.accessToken,
      "host",
    );
    const clientGrant = await createClientGrant(authority, hostAuthorization, 1);
    const localHostCredential = createHostCredentialAuthority(hostGrant, hostAuthorization);

    store = await hostState.RelayV2HostStateStore.open({
      paths: hostState.relayV2HostStatePaths(home),
    });
    const discovery = new QueueDiscovery();
    discovery.push(terminalDiscovery());
    const foundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: HOST_ID,
      discovery,
      store,
      readinessSink: { apply: () => true },
      now: () => NOW_MS,
    });
    const seeded = await foundation.reconcile();
    const spoolRoot = join(home, "snapshot-spool");
    const publisherSpool = await foundation.openStateSnapshotSpool({
      hostId: HOST_ID,
      root: spoolRoot,
      ownerInstanceId: store.hostInstanceId,
      now: () => NOW_MS,
    });
    await publisherSpool.get(firstSnapshotRequest(seeded.snapshot.hostEpoch));
    await publisherSpool.close();
    spool = await foundation.openStateSnapshotSpool({
      hostId: HOST_ID,
      root: spoolRoot,
      ownerInstanceId: store.hostInstanceId,
      now: () => NOW_MS,
    });
    const h2RecoveryCandidate = await spool.issueRecoveredHostH2Candidate();
    assert.notEqual(h2RecoveryCandidate, null);

    const commandExecutionEntered = deferred();
    const releaseCommandExecution = deferred();
    const h1RecoveryCandidate = await commandPlane.RelayV2HostCommandPlane
      .openRecoveredAuthority({
        store,
        hostId: HOST_ID,
        now: () => NOW_MS,
        executor: createCommandExecutor(commandExecutionEntered, releaseCommandExecution),
      });
    assert.notEqual(h1RecoveryCandidate, null);

    const terminalBackend = new BoundedTerminalBackend();
    const terminalControl = new BoundedTerminalControlAuthority();
    const terminalResolver = createTerminalResolver(seeded.snapshot.hostEpoch);
    const terminalLineage = new terminalDurable.RelayV2TerminalDurableLineageAuthority({
      store,
      admissionFence: terminalResolver,
    });
    let composedTerminalSender = null;
    const terminal = new terminalManager.RelayV2TerminalManager({
      hostId: HOST_ID,
      hostEpoch: seeded.snapshot.hostEpoch,
      hostInstanceId: store.hostInstanceId,
      resolver: terminalResolver,
      lineage: terminalLineage,
      backend: terminalBackend,
      terminalControl,
      now: () => NOW_MS,
      issueToken: () => `base-v2-resume-token-${randomUUID()}`,
      async send(route, frame, responseLineage) {
        await composedTerminalSender(route, frame, responseLineage);
      },
    });
    const h3RecoveryCandidate = await terminalLineage.recoverForHostH3(terminal);
    assert.notEqual(h3RecoveryCandidate, null);

    hostComposition = await hostRuntimeComposition
      .openRelayV2HostManagedWssConnectorRuntimeComposition({
        runtime: {
          hostId: HOST_ID,
          hostEpoch: seeded.snapshot.hostEpoch,
          hostInstanceId: store.hostInstanceId,
          authorities: {
            h0: store.h0ReadinessPort,
            h1RecoveryCandidate,
            h2RecoveryCandidate,
            h3RecoveryCandidate,
          },
          welcome: {
            build(input) {
              const welcome = fixture("host-welcome-snapshot-required");
              welcome.requestId = input.hello.requestId;
              welcome.hostId = HOST_ID;
              welcome.hostEpoch = input.cut.hostEpoch;
              welcome.hostInstanceId = input.cut.hostInstanceId;
              welcome.payload.eventSeq = input.cut.eventSeq;
              welcome.payload.capabilities = [...input.capabilities];
              welcome.payload.commandDedupeWindow = clone(input.commandDedupeWindow);
              return welcome;
            },
          },
        },
        connector: {
          credentialAuthority: localHostCredential,
          credentialReference: CREDENTIAL_REFERENCE,
          carrier: {
            clock: () => NOW_MS,
            idFactory: () => randomUUID(),
          },
          wss: {
            relayUrl: `wss://127.0.0.1:${server.port}/`,
            webSocketConstructor: LoopbackHostWebSocket,
          },
        },
      });
    composedTerminalSender = hostComposition.sendTerminalFrame;
    assert.equal(await hostComposition.readiness.h0.activate(), true);
    assert.equal(hostComposition.readiness.h3.activate(), true);
    try {
      await hostComposition.start({
        requestId: "base-v2-host-start",
        signal: new AbortController().signal,
      });
    } catch (error) {
      error.cause = clone(LoopbackHostWebSocket.evidence);
      throw error;
    }
    await waitFor(
      () => hostComposition.inspect().status === "registered_incomplete",
      "canonical Host controller did not reach host.registered",
    );
    assert.deepEqual(
      hostComposition.readiness.current().capabilities,
      Object.fromEntries(broker.RELAY_V2_REQUIRED_CAPABILITIES.map((capability) => [capability, true])),
    );

    const clientUrl = `ws://127.0.0.1:${server.port}/client`;
    const firstClient = await openAndHandshakeClient(
      clientUrl,
      clientGrant.body.accessToken,
      CLIENT_INSTANCE_ID,
    );
    clients.push(firstClient);

    const sessionsGet = fixture("sessions-snapshot-get-all");
    sessionsGet.requestId = randomUUID();
    sessionsGet.hostId = HOST_ID;
    sessionsGet.expectedHostEpoch = seeded.snapshot.hostEpoch;
    await sendFrame(firstClient.socket, sessionsGet);
    const sessionsSnapshot = await waitForFrame(
      firstClient,
      (frame) => frame.type === "sessions.snapshot" && frame.requestId === sessionsGet.requestId,
      "real Host runtime did not return sessions.snapshot",
    );
    assert.equal(sessionsSnapshot.payload.scopes.length, 1);
    assert.equal(sessionsSnapshot.payload.scopes[0].items.length, 1);
    const scopeId = sessionsSnapshot.payload.scopes[0].scopeId;
    const sessionId = sessionsSnapshot.payload.scopes[0].items[0].sessionId;

    discovery.push(terminalDiscovery(NOW_MS + 1));
    await foundation.reconcile();
    const sessionsChanged = await waitForFrame(
      firstClient,
      (frame) => frame.type === "sessions.changed",
      "materialized H2 event did not cross the real carrier as sessions.changed",
    );
    assert.equal(sessionsChanged.scopeId, scopeId);
    assert.equal(
      BigInt(sessionsChanged.eventSeq),
      BigInt(firstClient.hostWelcome.payload.eventSeq) + 1n,
    );

    const execute = fixture("command-execute-send-agent-message");
    execute.requestId = randomUUID();
    execute.commandId = `base-v2-command-${randomUUID()}`;
    execute.hostId = HOST_ID;
    execute.expectedHostEpoch = seeded.snapshot.hostEpoch;
    execute.scopeId = scopeId;
    execute.sessionId = sessionId;
    execute.payload.dedupeWindowId = firstClient.hostWelcome.payload.commandDedupeWindow.windowId;
    const commandResponsePending = waitForFrame(
      firstClient,
      (frame) => frame.type === "command.status" && frame.requestId === execute.requestId,
      "canonical command did not complete",
    );
    await sendFrame(firstClient.socket, execute);
    await commandExecutionEntered.promise;
    const runningSnapshot = await store.read();
    const acceptedRecord = Object.values(runningSnapshot.commands).find(
      (record) => record.commandId === execute.commandId,
    );
    assert.equal(acceptedRecord.state, "running", "command crossed durable ACCEPTED before effect");
    releaseCommandExecution.resolve();
    const commandStatus = await commandResponsePending;
    assert.equal(commandStatus.payload.state, "succeeded");
    assert.equal(commandStatus.payload.deduplicated, false);

    const query = fixture("command-query");
    query.requestId = randomUUID();
    query.hostId = HOST_ID;
    query.expectedHostEpoch = seeded.snapshot.hostEpoch;
    query.payload.items = [{
      commandId: execute.commandId,
      dedupeWindowId: execute.payload.dedupeWindowId,
    }];
    await sendFrame(firstClient.socket, query);
    const statuses = await waitForFrame(
      firstClient,
      (frame) => frame.type === "command.statuses" && frame.requestId === query.requestId,
      "canonical command query did not converge",
    );
    assert.equal(statuses.payload.items[0].state, "succeeded");

    const terminalOpen = fixture("terminal-open-new");
    terminalOpen.requestId = randomUUID();
    terminalOpen.hostId = HOST_ID;
    terminalOpen.expectedHostEpoch = seeded.snapshot.hostEpoch;
    terminalOpen.scopeId = scopeId;
    terminalOpen.sessionId = sessionId;
    terminalOpen.streamId = `base-v2-stream-${randomUUID()}`;
    terminalOpen.payload.openId = `base-v2-open-${randomUUID()}`;
    await sendFrame(firstClient.socket, terminalOpen);
    let terminalOpened;
    try {
      terminalOpened = await waitForFrame(
        firstClient,
        (frame) => frame.requestId === terminalOpen.requestId
          && (frame.type === "terminal.opened" || frame.type === "error"),
        "terminal.open did not cross the real Host runtime",
      );
    } catch (error) {
      error.cause = {
        frames: firstClient.frames,
        closes: firstClient.closes,
        backendHandles: terminalBackend.handles.length,
        terminalStats: terminal.stats(),
        hostSocket: LoopbackHostWebSocket.evidence,
      };
      throw error;
    }
    assert.equal(terminalOpened.type, "terminal.opened", JSON.stringify(terminalOpened));
    oldTerminalHandle = terminalBackend.handles[0];
    assert.notEqual(oldTerminalHandle, undefined);
    await oldTerminalHandle.emit("base-v2-output");
    const terminalOutput = await waitForFrame(
      firstClient,
      (frame) => frame.type === "terminal.output" && frame.streamId === terminalOpen.streamId,
      "live terminal output did not cross the real carrier",
    );
    assert.equal(Buffer.from(terminalOutput.payload.data, "base64").toString("utf8"), "base-v2-output");

    const terminalInput = fixture("terminal-input");
    terminalInput.streamId = terminalOpen.streamId;
    terminalInput.payload.generation = terminalOpened.payload.generation;
    terminalInput.payload.inputSeq = "1";
    terminalInput.payload.data = Buffer.from("pwd\n").toString("base64");
    await sendFrame(firstClient.socket, terminalInput);
    const inputAck = await waitForFrame(
      firstClient,
      (frame) => frame.type === "terminal.input_ack"
        && frame.streamId === terminalOpen.streamId
        && frame.payload.ackedThroughInputSeq === "1",
      "terminal input did not reach its canonical authority",
    );
    assert.equal(inputAck.payload.generation, terminalOpened.payload.generation);
    assert.equal(terminalControl.writes[0].toString("utf8"), "pwd\n");

    const terminalClose = fixture("terminal-close");
    terminalClose.requestId = randomUUID();
    terminalClose.hostId = HOST_ID;
    terminalClose.expectedHostEpoch = seeded.snapshot.hostEpoch;
    terminalClose.scopeId = scopeId;
    terminalClose.sessionId = sessionId;
    terminalClose.streamId = terminalOpen.streamId;
    terminalClose.payload.closeId = `base-v2-close-${randomUUID()}`;
    terminalClose.payload.generation = terminalOpened.payload.generation;
    terminalClose.payload.resumeToken = terminalOpened.payload.resumeToken;
    await sendFrame(firstClient.socket, terminalClose);
    await waitForFrame(
      firstClient,
      (frame) => frame.type === "terminal.closed" && frame.requestId === terminalClose.requestId,
      "terminal.close did not return its correlated response",
    );

    const refreshed = await authority.refreshGrant({
      refreshAttemptId: "base-v2-client-refresh",
      grantId: clientGrant.body.grantId,
      refreshToken: clientGrant.body.refreshToken,
      clientInstanceId: CLIENT_INSTANCE_ID,
    });
    assert.equal(firstClient.socket.readyState, WebSocket.OPEN);

    const reboundClient = await openAndHandshakeClient(
      clientUrl,
      refreshed.body.accessToken,
      CLIENT_INSTANCE_ID,
    );
    clients.push(reboundClient);
    const firstClose = waitForSocketClose(firstClient.socket);
    firstClient.socket.close(1000, "refresh_handoff");
    assert.equal((await firstClose).code, 1000);
    const reboundCount = reboundClient.frames.length;
    await oldTerminalHandle.emit("stale-after-route-rebind").catch(() => undefined);
    await settle();
    assert.equal(reboundClient.frames.length, reboundCount);

    const reboundClose = waitForSocketClose(reboundClient.socket);
    const revoked = await authority.handle({
      type: "grant.revoke",
      requestId: "base-v2-client-revoke",
      connectorId: "base-v2-credential-control",
      payload: { grantId: clientGrant.body.grantId, reason: "user_revoked" },
      currentAuthContext: hostAuthorization,
    });
    assert.equal(revoked.outcome, "success");
    assert.equal((await reboundClose).code, 4403);
    const revokedAdmission = await rejectedClientUpgrade(clientUrl, refreshed.body.accessToken);
    assert.equal(revokedAdmission.opened, false);
    assert.ok(revokedAdmission.status === 401 || revokedAdmission.status === 403);

    const successorGrant = await createClientGrant(authority, hostAuthorization, 2);
    const successorClient = await openAndHandshakeClient(
      clientUrl,
      successorGrant.body.accessToken,
      `${CLIENT_INSTANCE_ID}-2`,
    );
    clients.push(successorClient);
    const successorClose = waitForSocketClose(successorClient.socket);
    brokerStore.onCompareAndPublish = ({ defaultPublish }) => {
      defaultPublish();
      throw new Error("injected post-publication ready loss");
    };
    await assert.rejects(
      authority.adminRotateIssuerKey({
        kid: "base-v2-ready-loss-kid",
        secretBase64url: Buffer.alloc(32, 0x6a).toString("base64url"),
      }),
      (error) => error instanceof brokerCredential.RelayV2BrokerCredentialAuthorityError
        && error.code === "STORE_PUBLICATION_UNCERTAIN",
    );
    assert.equal(authority.authorityContinuityReadiness.status, "closed");
    assert.equal((await successorClose).code, 1013);
    await waitFor(
      () => hostComposition.inspect().status === "failed",
      "Broker ready-loss did not fence the canonical Host controller attempt",
    );
    const readyLossAdmission = await rejectedClientUpgrade(
      clientUrl,
      successorGrant.body.accessToken,
    );
    assert.equal(readyLossAdmission.opened, false);

    const hostCloseOne = hostComposition.closeAndDrain();
    const hostCloseTwo = hostComposition.closeAndDrain();
    await Promise.all([hostCloseOne, hostCloseTwo]);
    assert.equal(hostComposition.inspect().status, "stopped");
    const serverCloseOne = server.shutdown();
    const serverCloseTwo = server.shutdown();
    await Promise.all([serverCloseOne, serverCloseTwo]);
    assert.equal(brokerStore.closeCalls, 1);
  } finally {
    for (const client of clients) {
      try { client.socket.terminate(); } catch {}
    }
    await hostComposition?.closeAndDrain().catch(() => undefined);
    await server?.shutdown().catch(() => undefined);
    await spool?.close().catch(() => undefined);
    store?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
