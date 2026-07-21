import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const compositionModule = await import(
  "../dist/relay/v2/brokerHostWssListenerFreeComposition.js"
);

const NOW_MS = 1_783_700_000_000;
const HOST_PROTOCOL = "tw-relay.host.v2";
const TOKEN = "twcap2.listener-free-sensitive";
const INVALID_TOKEN = "twcap2.listener-free-invalid";
const FORBIDDEN_TOKEN = "twcap2.listener-free-forbidden";
const FAILURE = "Relay v2 Broker Host WSS listener-free composition failed";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function trustedHostAuthorization(hostId = "listener-free-host") {
  return Object.freeze({
    scheme: "twcap2",
    role: "host",
    hostId,
    principalId: `${hostId}-principal`,
    grantId: `${hostId}-grant`,
    clientInstanceId: null,
    jti: `${hostId}-jti`,
    kid: "kid-current",
    expiresAtMs: NOW_MS + 3_600_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
  });
}

function metadata(overrides = {}) {
  return {
    pathname: "/host",
    search: "",
    authorizationHeaders: [`Bearer ${TOKEN}`],
    legacyQuerySecret: null,
    offeredProtocols: [HOST_PROTOCOL],
    ...overrides,
  };
}

class MemoryDuplex extends Duplex {
  constructor() {
    super();
    this.writes = [];
    this.destroyCalls = 0;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  _destroy(error, callback) {
    this.destroyCalls += 1;
    callback(error);
  }

  responseText() {
    return Buffer.concat(this.writes).toString("latin1");
  }
}

class GatedDestroyDuplex extends MemoryDuplex {
  constructor() {
    super();
    this.destroyStarted = deferred();
    this.finishDestroy = null;
  }

  _destroy(error, callback) {
    this.destroyCalls += 1;
    this.finishDestroy = () => callback(error);
    this.destroyStarted.resolve();
  }
}

function upgradeRequest(socket, protocol = HOST_PROTOCOL) {
  const headers = {
    upgrade: "websocket",
    "sec-websocket-key": Buffer.alloc(16, 9).toString("base64"),
    "sec-websocket-version": "13",
  };
  if (protocol !== undefined) headers["sec-websocket-protocol"] = protocol;
  return Object.freeze({
    method: "GET",
    url: "/host",
    headers: Object.freeze(headers),
    socket,
  });
}

function upgradeInput(request, socket, upgradeMetadata = metadata()) {
  return {
    metadata: upgradeMetadata,
    request,
    socket,
    head: Buffer.alloc(0),
  };
}

function sharedRuntimeOptions() {
  return {
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    authorizationExpiryScheduleAt: () => () => {},
  };
}

async function createComposition(verifyV2AccessToken) {
  return compositionModule.createRelayV2BrokerHostWssListenerFreeComposition({
    verifyV2AccessToken,
    sharedRuntimeOptions: sharedRuntimeOptions(),
  });
}

async function activateComposition(openCredentialAuthority) {
  return compositionModule.activateRelayV2BrokerHostWssListenerFreeComposition({
    openCredentialAuthority,
    sharedRuntimeOptions: sharedRuntimeOptions(),
  });
}

function isGenericFailure(error) {
  assert.equal(error.message, FAILURE);
  assert.equal(error.cause, undefined);
  assert.equal(String(error).includes(TOKEN), false);
  return true;
}

function untouchedRawInput() {
  let touches = 0;
  const trap = {
    get() { touches += 1; throw new Error("raw getter must stay untouched"); },
    getOwnPropertyDescriptor() {
      touches += 1;
      throw new Error("raw descriptor must stay untouched");
    },
    getPrototypeOf() {
      touches += 1;
      throw new Error("raw prototype must stay untouched");
    },
    ownKeys() { touches += 1; throw new Error("raw keys must stay untouched"); },
  };
  return {
    request: new Proxy({}, trap),
    socket: new Proxy({}, trap),
    head: new Proxy(new Uint8Array(0), trap),
    touches: () => touches,
  };
}

test("real in-memory Duplex reaches 101 and one connection through the closed facade", async () => {
  let verifierCalls = 0;
  const composition = await createComposition((token, expectedRole) => {
    verifierCalls += 1;
    assert.equal(token, TOKEN);
    assert.equal(expectedRole, "host");
    return trustedHostAuthorization();
  });

  assert.equal(Object.getPrototypeOf(composition), null);
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Reflect.ownKeys(composition), ["hostUpgrade", "closeAndDrain"]);
  assert.equal(Object.getPrototypeOf(composition.hostUpgrade), null);
  assert.equal(Object.isFrozen(composition.hostUpgrade), true);
  assert.deepEqual(Reflect.ownKeys(composition.hostUpgrade), ["upgrade"]);
  for (const forbidden of [
    "dispatch",
    "admissionReceipt",
    "prepareHostWss",
    "claimPreparedHostWss",
    "attachPreparedHostWss",
    "authority",
    "trustedSocketBrand",
    "nativeUpgrade",
    "adapter",
    "trustedSocketPrototype",
    "runtime",
    "core",
    "producerRegistry",
  ]) {
    assert.equal(composition[forbidden], undefined);
    assert.equal(composition.hostUpgrade[forbidden], undefined);
  }

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket);
  const accepted = await composition.hostUpgrade.upgrade(upgradeInput(request, socket));
  assert.equal(accepted.outcome, "upgraded");
  assert.equal(accepted.selectedProtocol, undefined);
  assert.equal(Object.isFrozen(accepted), true);
  assert.deepEqual(Reflect.ownKeys(accepted), ["outcome", "connection"]);
  assert.equal(accepted.admissionReceipt, undefined);
  assert.match(accepted.connection.transportId, /^[0-9a-f-]{36}$/);
  assert.match(socket.responseText(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(
    socket.responseText(),
    /\r\nSec-WebSocket-Protocol: tw-relay\.host\.v2\r\n/,
  );
  assert.equal(verifierCalls, 1);

  await composition.closeAndDrain();
  await accepted.connection.drained;
  assert.equal(socket.destroyCalls, 1);
});

test("pre-101 rejects never touch raw input and metadata/request protocol cross-binding fails closed", async () => {
  let verifierCalls = 0;
  const composition = await createComposition(() => {
    verifierCalls += 1;
    return trustedHostAuthorization("cross-binding-host");
  });

  for (const [name, rejectedMetadata, expectedStatus] of [
    ["missing auth", metadata({ authorizationHeaders: [] }), 401],
    ["missing protocol", metadata({ offeredProtocols: [] }), 426],
    ["extra protocol", metadata({
      offeredProtocols: [HOST_PROTOCOL, "tw-relay.v2"],
    }), 426],
  ]) {
    const raw = untouchedRawInput();
    const result = await composition.hostUpgrade.upgrade({
      metadata: rejectedMetadata,
      request: raw.request,
      socket: raw.socket,
      head: raw.head,
    });
    assert.equal(result.outcome, "reject", name);
    assert.equal(result.status, expectedStatus, name);
    assert.equal(raw.touches(), 0, name);
  }
  assert.equal(verifierCalls, 0);

  const mismatchedSocket = new MemoryDuplex();
  const mismatchedRequest = upgradeRequest(mismatchedSocket, "tw-relay.v2");
  await assert.rejects(
    composition.hostUpgrade.upgrade(upgradeInput(mismatchedRequest, mismatchedSocket)),
    isGenericFailure,
  );
  assert.equal(verifierCalls, 1);
  assert.equal(
    mismatchedSocket.responseText().includes("101 Switching Protocols"),
    false,
  );
  assert.equal(mismatchedSocket.destroyed, true);
  await composition.closeAndDrain();
});

test("exact receivers and close races fence native work, return 503, and drain accepted sockets first", async () => {
  await assert.rejects(
    compositionModule.createRelayV2BrokerHostWssListenerFreeComposition({
      verifyV2AccessToken() {
        throw new Error("invalid construction must not reach verification");
      },
      sharedRuntimeOptions: {
        ...sharedRuntimeOptions(),
        unknownRuntimeOption: true,
      },
    }),
    isGenericFailure,
  );

  const verifierEntered = deferred();
  const verifierDecision = deferred();
  let verifierCalls = 0;
  const composition = await createComposition(async () => {
    verifierCalls += 1;
    verifierEntered.resolve();
    return await verifierDecision.promise;
  });

  const wrongReceiverRaw = untouchedRawInput();
  await assert.rejects(
    Reflect.apply(composition.hostUpgrade.upgrade, Object.create(null), [new Proxy({}, {
      get() { throw new Error("wrong receiver must not read input"); },
      ownKeys() { throw new Error("wrong receiver must not inspect input"); },
    })]),
    isGenericFailure,
  );
  await assert.rejects(
    Reflect.apply(composition.closeAndDrain, Object.create(null), []),
    isGenericFailure,
  );
  await assert.rejects(composition.hostUpgrade.upgrade({
    metadata: metadata(),
    request: wrongReceiverRaw.request,
    socket: wrongReceiverRaw.socket,
    head: wrongReceiverRaw.head,
    extra: true,
  }), isGenericFailure);
  assert.equal(wrongReceiverRaw.touches(), 0);
  assert.equal(verifierCalls, 0);

  const pendingRaw = untouchedRawInput();
  const pendingUpgrade = composition.hostUpgrade.upgrade({
    metadata: metadata(),
    request: pendingRaw.request,
    socket: pendingRaw.socket,
    head: pendingRaw.head,
  });
  await verifierEntered.promise;
  const close = composition.closeAndDrain();
  assert.strictEqual(composition.closeAndDrain(), close);
  let closeSettled = false;
  void close.then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  verifierDecision.resolve(trustedHostAuthorization("close-race-host"));
  const closedResult = await pendingUpgrade;
  assert.deepEqual(closedResult, { outcome: "reject", status: 503 });
  assert.equal(Object.isFrozen(closedResult), true);
  assert.equal(pendingRaw.touches(), 0);
  await close;

  let postCloseTouches = 0;
  const postCloseInput = new Proxy({}, {
    get() { postCloseTouches += 1; throw new Error("post-close getter"); },
    ownKeys() { postCloseTouches += 1; throw new Error("post-close keys"); },
  });
  await assert.rejects(
    composition.hostUpgrade.upgrade(postCloseInput),
    isGenericFailure,
  );
  assert.equal(postCloseTouches, 0);
  assert.equal(verifierCalls, 1);

  const drainingComposition = await createComposition(() => (
    trustedHostAuthorization("draining-host")
  ));
  const drainingSocket = new GatedDestroyDuplex();
  const drainingRequest = upgradeRequest(drainingSocket);
  const accepted = await drainingComposition.hostUpgrade.upgrade(
    upgradeInput(drainingRequest, drainingSocket),
  );
  assert.equal(accepted.outcome, "upgraded");
  const drainingClose = drainingComposition.closeAndDrain();
  assert.strictEqual(drainingComposition.closeAndDrain(), drainingClose);
  await drainingSocket.destroyStarted.promise;
  let drainingCloseSettled = false;
  let connectionDrained = false;
  void drainingClose.then(() => { drainingCloseSettled = true; });
  void accepted.connection.drained.then(() => { connectionDrained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainingCloseSettled, false);
  assert.equal(connectionDrained, false);
  drainingSocket.finishDestroy();
  await drainingClose;
  await accepted.connection.drained;
  assert.equal(drainingCloseSettled, true);
  assert.equal(connectionDrained, true);
});

test("credential activation binds one exact authority to Host Upgrade and ready-loss", async () => {
  let liveAuthorizationFence;
  let exactDownstreamOpenerInput;
  let exactDownstreamFence;
  let authorityOpenerInput;
  let authorityCloseCalls = 0;
  let authorizerCalls = 0;
  let exactAuthority;
  class ExactCredentialAuthority {
    authorityContinuityReadiness = Object.freeze({ status: "ready" });

    async handle() {
      throw new Error("auth-control is not used by this Host Upgrade case");
    }

    authorizeAccessToken(token, expectedRole) {
      assert.strictEqual(this, exactAuthority);
      assert.strictEqual(authorityOpenerInput, exactDownstreamOpenerInput);
      assert.strictEqual(authorityOpenerInput.liveAuthorizationFence, exactDownstreamFence);
      authorizerCalls += 1;
      assert.equal(expectedRole, "host");
      if (token === INVALID_TOKEN) {
        throw Object.assign(new Error("invalid credential"), { code: "AUTH_INVALID" });
      }
      if (token === FORBIDDEN_TOKEN) {
        throw Object.assign(new Error("forbidden credential"), {
          code: "PERMISSION_DENIED",
        });
      }
      assert.equal(token, TOKEN);
      return trustedHostAuthorization("credential-activated-host");
    }

    async close() {
      assert.strictEqual(this, exactAuthority);
      authorityCloseCalls += 1;
    }
  }
  exactAuthority = new ExactCredentialAuthority();
  const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, "freeze");
  assert.ok(freezeDescriptor);
  assert.equal(typeof freezeDescriptor.value, "function");
  Object.defineProperty(Object, "freeze", {
    ...freezeDescriptor,
    value(value) {
      const frozen = Reflect.apply(freezeDescriptor.value, Object, [value]);
      try {
        if (
          exactDownstreamOpenerInput === undefined
          && frozen !== null
          && typeof frozen === "object"
        ) {
          const descriptors = Object.getOwnPropertyDescriptors(frozen);
          const keys = Reflect.ownKeys(descriptors);
          const fence = descriptors.liveAuthorizationFence;
          if (
            keys.length === 1
            && keys[0] === "liveAuthorizationFence"
            && fence
            && Object.hasOwn(fence, "value")
          ) {
            exactDownstreamOpenerInput = frozen;
            exactDownstreamFence = fence.value;
          }
        }
      } catch {
        // Transparent identity capture must not alter Object.freeze behavior.
      }
      return frozen;
    },
  });
  let composition;
  try {
    composition = await activateComposition(async (input) => {
      assert.equal(this, undefined);
      assert.strictEqual(input, exactDownstreamOpenerInput);
      assert.equal(Object.isFrozen(input), true);
      assert.deepEqual(Reflect.ownKeys(input), ["liveAuthorizationFence"]);
      assert.strictEqual(input.liveAuthorizationFence, exactDownstreamFence);
      authorityOpenerInput = input;
      liveAuthorizationFence = input.liveAuthorizationFence;
      return exactAuthority;
    });
  } finally {
    Object.defineProperty(Object, "freeze", freezeDescriptor);
  }

  assert.equal(Object.getPrototypeOf(composition), null);
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Reflect.ownKeys(composition), ["hostUpgrade", "closeAndDrain"]);
  assert.deepEqual(Reflect.ownKeys(composition.hostUpgrade), ["upgrade"]);
  for (const forbidden of [
    "credentialAuthority",
    "authorizeAccessToken",
    "verifyV2AccessToken",
    "runtime",
    "core",
    "trustedSocketBrand",
    "trustedSocketPrototype",
  ]) {
    assert.equal(composition[forbidden], undefined);
    assert.equal(composition.hostUpgrade[forbidden], undefined);
  }

  for (const [token, status] of [
    [INVALID_TOKEN, 401],
    [FORBIDDEN_TOKEN, 403],
  ]) {
    const raw = untouchedRawInput();
    const result = await composition.hostUpgrade.upgrade({
      metadata: metadata({ authorizationHeaders: [`Bearer ${token}`] }),
      request: raw.request,
      socket: raw.socket,
      head: raw.head,
    });
    assert.equal(result.outcome, "reject");
    assert.equal(result.status, status);
    assert.equal(raw.touches(), 0);
  }

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket);
  const accepted = await composition.hostUpgrade.upgrade(upgradeInput(request, socket));
  assert.equal(accepted.outcome, "upgraded");
  assert.match(socket.responseText(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);

  liveAuthorizationFence.failClosed();
  const fencedRaw = untouchedRawInput();
  const fenced = await composition.hostUpgrade.upgrade({
    metadata: metadata(),
    request: fencedRaw.request,
    socket: fencedRaw.socket,
    head: fencedRaw.head,
  });
  assert.deepEqual(fenced, { outcome: "reject", status: 503 });
  assert.equal(fencedRaw.touches(), 0);

  await composition.closeAndDrain();
  await accepted.connection.drained;
  assert.equal(authorityCloseCalls, 1);
  assert.equal(authorizerCalls, 4);
  assert.equal(socket.destroyCalls, 1);
});

test("credential activation rolls back every unpublished authority shape", async () => {
  const cases = [
    { name: "missing authorizer", descriptor: null },
    {
      name: "accessor authorizer",
      descriptor(state) {
        return {
          configurable: true,
          get() {
            state.authorizerExecutions += 1;
            throw new Error("authorizer accessor must not execute");
          },
        };
      },
    },
    {
      name: "Proxy authorizer",
      descriptor(state) {
        return {
          configurable: true,
          value: new Proxy(function proxyAuthorizer() {
            state.authorizerExecutions += 1;
            throw new Error("Proxy authorizer must not execute");
          }, {}),
        };
      },
    },
  ];

  for (const entry of cases) {
    const state = { authorizerExecutions: 0, closeCalls: 0 };
    const authority = {
      authorityContinuityReadiness: Object.freeze({ status: "ready" }),
      async handle() {
        throw new Error("unpublished authority must not handle auth-control");
      },
      async close() {
        assert.strictEqual(this, authority);
        state.closeCalls += 1;
      },
    };
    if (entry.descriptor) {
      Object.defineProperty(
        authority,
        "authorizeAccessToken",
        entry.descriptor(state),
      );
    }
    await assert.rejects(
      activateComposition(async () => authority),
      isGenericFailure,
      entry.name,
    );
    assert.equal(state.authorizerExecutions, 0, entry.name);
    assert.equal(state.closeCalls, 1, entry.name);
  }

  for (const [name, readiness, failFence] of [
    ["not ready", Object.freeze({ status: "opening" }), false],
    ["closed live fence", Object.freeze({ status: "ready" }), true],
  ]) {
    let closeCalls = 0;
    const authority = {
      authorityContinuityReadiness: readiness,
      async handle() {
        throw new Error("unpublished authority must not handle auth-control");
      },
      authorizeAccessToken() {
        throw new Error("unpublished authority must not authorize");
      },
      async close() {
        closeCalls += 1;
      },
    };
    await assert.rejects(
      activateComposition(async ({ liveAuthorizationFence }) => {
        if (failFence) liveAuthorizationFence.failClosed();
        return authority;
      }),
      isGenericFailure,
      name,
    );
    assert.equal(closeCalls, 1, name);
  }

  let openerCalls = 0;
  await assert.rejects(
    compositionModule.activateRelayV2BrokerHostWssListenerFreeComposition({
      openCredentialAuthority: async () => {
        openerCalls += 1;
        throw new Error("extra verifier reached opener");
      },
      sharedRuntimeOptions: sharedRuntimeOptions(),
      verifyV2AccessToken() {
        throw new Error("foreign verifier must not be accepted");
      },
    }),
    isGenericFailure,
  );
  assert.equal(openerCalls, 0);
});

test("synchronous authorizer reentry closes only after the registered Upgrade settles", async () => {
  const authorizerEntered = deferred();
  const authorizerDecision = deferred();
  let composition;
  let reentrantClose;
  let authorityCloseCalls = 0;
  let exactAuthority;
  const authority = {
    authorityContinuityReadiness: Object.freeze({ status: "ready" }),
    async handle() {
      throw new Error("auth-control is not used by this close race");
    },
    authorizeAccessToken(token, expectedRole) {
      assert.strictEqual(this, exactAuthority);
      assert.equal(token, TOKEN);
      assert.equal(expectedRole, "host");
      reentrantClose ??= composition.closeAndDrain();
      authorizerEntered.resolve();
      return authorizerDecision.promise;
    },
    async close() {
      assert.strictEqual(this, exactAuthority);
      authorityCloseCalls += 1;
    },
  };
  exactAuthority = authority;
  composition = await activateComposition(async () => authority);

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket);
  const pendingUpgrade = composition.hostUpgrade.upgrade(
    upgradeInput(request, socket),
  );
  await authorizerEntered.promise;
  assert.ok(reentrantClose);
  assert.strictEqual(composition.closeAndDrain(), reentrantClose);
  let closeSettled = false;
  void reentrantClose.then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(authorityCloseCalls, 0);

  authorizerDecision.resolve(trustedHostAuthorization("reentrant-close-host"));
  const result = await pendingUpgrade;
  assert.deepEqual(result, { outcome: "reject", status: 503 });
  assert.equal(socket.responseText().includes("101 Switching Protocols"), false);
  assert.equal(socket.destroyCalls, 0);
  await reentrantClose;
  assert.equal(closeSettled, true);
  assert.equal(authorityCloseCalls, 1);

  const postCloseRaw = untouchedRawInput();
  await assert.rejects(
    composition.hostUpgrade.upgrade({
      metadata: metadata(),
      request: postCloseRaw.request,
      socket: postCloseRaw.socket,
      head: postCloseRaw.head,
    }),
    isGenericFailure,
  );
  assert.equal(postCloseRaw.touches(), 0);
});
