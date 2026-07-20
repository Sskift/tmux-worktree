import assert from "node:assert/strict";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const dispatchModule = await import("../dist/relay/v2/brokerHostUpgradeDispatch.js");
const upgradeModule = await import(
  "../dist/relay/v2/brokerHostWssUpgradeAuthority.js"
);
const pump = await import("../dist/relay/v2/carrierPump.js");

const NOW_MS = 1_783_700_000_000;
const TOKEN = "twcap2.host-upgrade-sensitive";

function authContext(hostId = "native-upgrade-host") {
  return {
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
  };
}

function metadata() {
  return {
    pathname: "/host",
    search: "",
    authorizationHeaders: [`Bearer ${TOKEN}`],
    legacyQuerySecret: null,
    offeredProtocols: ["tw-relay.host.v2"],
  };
}

function receipt() {
  return Object.freeze(Object.create(null));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function connectionHandle(drained = Promise.resolve()) {
  return Object.freeze({
    transportId: "transport-1",
    connectionIncarnation: "incarnation-1",
    producerGeneration: "1",
    terminal: new Promise(() => {}),
    drained,
  });
}

class FakeRawSocket {
  constructor() {
    this.destroys = 0;
    this.destroyResult = this;
    this.destroyError = null;
  }

  destroy() {
    this.destroys += 1;
    if (this.destroyError) throw this.destroyError;
    return this.destroyResult;
  }
}

class FakeUpgradedSocket {
  constructor(protocol = "tw-relay.host.v2") {
    this._readyState = 1;
    this._protocol = protocol;
    this._extensions = "";
    this._bufferedAmount = 0;
    this.listeners = new Map();
    this.terminates = 0;
    this.closes = [];
    this.terminateResult = undefined;
    this.terminateError = null;
    this.closeResult = undefined;
    this.closeError = null;
  }

  get readyState() { return this._readyState; }
  get protocol() { return this._protocol; }
  get extensions() { return this._extensions; }
  get bufferedAmount() { return this._bufferedAmount; }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event, listener) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      Reflect.apply(listener, this, args);
    }
  }

  send(_text, _options, _callback) {}
  pause() {}
  resume() {}

  terminate() {
    this.terminates += 1;
    if (this.terminateError) throw this.terminateError;
    return this.terminateResult;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
    if (this.closeError) throw this.closeError;
    return this.closeResult;
  }
}

class FakeNativeUpgrade {
  constructor(behavior) {
    this.behavior = behavior;
    this.calls = [];
  }

  handleUpgrade(request, socket, head, callback) {
    this.calls.push({ receiver: this, request, socket, head, callback });
    return this.behavior({ request, socket, head, callback });
  }
}

function upgradeInput(admissionReceipt, socket = new FakeRawSocket()) {
  return {
    admissionReceipt,
    request: Object.freeze({ kind: "request" }),
    socket,
    head: Buffer.from([1, 2, 3]),
  };
}

function admissionClaim(attachPreparedHostWss) {
  let claim;
  let open = true;
  const attach = function attach(input) {
    if (this !== claim || !open) throw new Error("invalid fake admission claim");
    open = false;
    return attachPreparedHostWss(input);
  };
  claim = Object.freeze(Object.assign(Object.create(null), { attach }));
  return claim;
}

function fakeAuthority({ behavior, attachPreparedHostWss }) {
  const nativeUpgrade = new FakeNativeUpgrade(behavior);
  const claimedReceipts = new WeakSet();
  const authority = upgradeModule.createRelayV2BrokerHostWssUpgradeAuthority({
    trustedSocketPrototype: FakeUpgradedSocket.prototype,
    nativeUpgrade,
    claimPreparedHostWss({ receipt: candidate }) {
      if (
        candidate === null
        || typeof candidate !== "object"
        || claimedReceipts.has(candidate)
      ) throw new Error("invalid fake receipt");
      claimedReceipts.add(candidate);
      return admissionClaim(attachPreparedHostWss);
    },
  });
  return { authority, nativeUpgrade };
}

function canonicalHarness(behavior) {
  let shared;
  const nativeUpgrade = new FakeNativeUpgrade(behavior);
  const authority = upgradeModule.createRelayV2BrokerHostWssUpgradeAuthority({
    trustedSocketPrototype: FakeUpgradedSocket.prototype,
    nativeUpgrade,
    claimPreparedHostWss(input) {
      return shared.hostWssRuntime.claimPreparedHostWss(input);
    },
  });
  shared = pump.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
    hostWssTrustedSocketBrand: authority.trustedSocketBrand,
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    authorizationExpiryScheduleAt: () => () => {},
  });
  return { authority, nativeUpgrade, shared };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("native Host Upgrade preserves exact B7g receipt/socket sequencing and issues only its private brand", async () => {
  const sequence = [];
  const upgradedSocket = new FakeUpgradedSocket();
  let shared;
  let authority;
  const nativeUpgrade = new FakeNativeUpgrade(({ request, callback }) => {
    sequence.push("native:start");
    callback(upgradedSocket, request);
    sequence.push("native:callback-returned");
    assert.equal(authority.trustedSocketBrand(upgradedSocket), false);
    sequence.push("native:return");
  });
  authority = upgradeModule.createRelayV2BrokerHostWssUpgradeAuthority({
    trustedSocketPrototype: FakeUpgradedSocket.prototype,
    nativeUpgrade,
    claimPreparedHostWss(input) {
      sequence.push("b7f:claim");
      const ownerClaim = shared.hostWssRuntime.claimPreparedHostWss(input);
      return admissionClaim((attachInput) => {
        sequence.push("b7f:attach");
        assert.equal(authority.trustedSocketBrand(attachInput.alreadyUpgradedSocket), true);
        return Reflect.apply(ownerClaim.attach, ownerClaim, [attachInput]);
      });
    },
  });
  shared = pump.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
    hostWssTrustedSocketBrand: authority.trustedSocketBrand,
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    authorizationExpiryScheduleAt: () => () => {},
  });
  const dispatch = new dispatchModule.RelayV2BrokerHostUpgradeDispatchOwner({
    verifyV2AccessToken(token, expectedRole) {
      assert.equal(token, TOKEN);
      assert.equal(expectedRole, "host");
      return authContext();
    },
    prepareHostWss: shared.hostWssRuntime.prepareHostWss,
  });
  const accepted = await dispatch.dispatch(metadata());
  assert.equal(accepted.outcome, "accept");

  assert.deepEqual(Reflect.ownKeys(authority), [
    "trustedSocketPrototype",
    "trustedSocketBrand",
    "handoff",
  ]);
  assert.deepEqual(Reflect.ownKeys(authority.handoff), ["upgrade", "closeAndDrain"]);
  for (const forbidden of [
    "add",
    "issue",
    "brandSocket",
    "weakSet",
    "claimPreparedHostWss",
    "attachPreparedHostWss",
  ]) {
    assert.equal(authority[forbidden], undefined);
    assert.equal(authority.handoff[forbidden], undefined);
  }

  const rawSocket = new FakeRawSocket();
  const input = upgradeInput(accepted.admissionReceipt, rawSocket);
  const handle = authority.handoff.upgrade(input);
  assert.deepEqual(sequence, [
    "b7f:claim",
    "native:start",
    "native:callback-returned",
    "native:return",
    "b7f:attach",
  ]);
  assert.equal(nativeUpgrade.calls.length, 1);
  assert.strictEqual(nativeUpgrade.calls[0].receiver, nativeUpgrade);
  assert.strictEqual(nativeUpgrade.calls[0].request, input.request);
  assert.strictEqual(nativeUpgrade.calls[0].socket, rawSocket);
  assert.strictEqual(nativeUpgrade.calls[0].head, input.head);
  assert.equal(authority.trustedSocketBrand(upgradedSocket), true);
  assert.equal(authority.trustedSocketBrand(new FakeUpgradedSocket()), false);
  assert.equal(rawSocket.destroys, 0);
  assert.match(handle.transportId, /^[0-9a-f-]{36}$/);

  upgradedSocket.emit("close", 1000);
  await handle.drained;
  assert.equal(authority.trustedSocketBrand(upgradedSocket), false);
  await Promise.all([authority.handoff.closeAndDrain(), shared.closeAndDrain()]);
});

test("receipt replay and early/multiple/late/foreign callback variants fail closed without another Upgrade", async () => {
  const replaySocket = new FakeUpgradedSocket();
  const replayHarness = canonicalHarness(({ request, callback }) => {
    callback(replaySocket, request);
  });
  const replayPrepared = replayHarness.shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext("replay-host"),
  });
  assert.equal(replayPrepared.outcome, "accept");
  const replayInput = upgradeInput(replayPrepared.receipt);
  const replayHandle = replayHarness.authority.handoff.upgrade(replayInput);
  assert.throws(
    () => replayHarness.authority.handoff.upgrade(replayInput),
    /Relay v2 Broker Host native Upgrade failed/,
  );
  assert.equal(replayHarness.nativeUpgrade.calls.length, 1);

  const receiverReceipt = receipt();
  const receiverSocket = new FakeUpgradedSocket();
  const receiverHarness = fakeAuthority({
    behavior({ request, callback }) { callback(receiverSocket, request); },
    attachPreparedHostWss() { return connectionHandle(); },
  });
  const receiverInput = upgradeInput(receiverReceipt);
  assert.throws(
    () => Reflect.apply(receiverHarness.authority.handoff.upgrade, {}, [receiverInput]),
    /Relay v2 Broker Host native Upgrade failed/,
  );
  assert.equal(receiverHarness.nativeUpgrade.calls.length, 0);
  receiverHarness.authority.handoff.upgrade(receiverInput);

  const cases = [
    {
      name: "foreign callback receiver",
      arrange() {
        const socket = new FakeUpgradedSocket();
        return {
          sockets: [socket],
          behavior({ request, callback }) { Reflect.apply(callback, {}, [socket, request]); },
        };
      },
    },
    {
      name: "multiple callbacks",
      arrange() {
        const first = new FakeUpgradedSocket();
        const second = new FakeUpgradedSocket();
        return {
          sockets: [first, second],
          behavior({ request, callback }) {
            callback(first, request);
            callback(second, request);
          },
        };
      },
    },
    {
      name: "foreign callback request",
      arrange() {
        const socket = new FakeUpgradedSocket();
        return {
          sockets: [socket],
          behavior({ callback }) { callback(socket, Object.freeze({ foreign: true })); },
        };
      },
    },
    {
      name: "foreign socket",
      arrange() {
        const socket = Object.create({ protocol: "tw-relay.host.v2" });
        return {
          sockets: [],
          behavior({ request, callback }) { callback(socket, request); },
          rawClosed: true,
        };
      },
    },
    {
      name: "foreign protocol",
      arrange() {
        const socket = new FakeUpgradedSocket("tw-relay.v2");
        return {
          sockets: [socket],
          behavior({ request, callback }) { callback(socket, request); },
        };
      },
    },
  ];

  for (const entry of cases) {
    const arranged = entry.arrange();
    const rawSocket = new FakeRawSocket();
    let attachCalls = 0;
    const harness = fakeAuthority({
      behavior: arranged.behavior,
      attachPreparedHostWss() { attachCalls += 1; return connectionHandle(); },
    });
    assert.throws(
      () => harness.authority.handoff.upgrade(upgradeInput(receipt(), rawSocket)),
      (error) => {
        assert.equal(error.message, "Relay v2 Broker Host native Upgrade failed", entry.name);
        assert.equal(error.cause, undefined, entry.name);
        assert.equal(String(error).includes(TOKEN), false, entry.name);
        return true;
      },
    );
    assert.equal(harness.nativeUpgrade.calls.length, 1, entry.name);
    assert.equal(attachCalls, 0, entry.name);
    for (const socket of arranged.sockets) {
      assert.equal(socket.terminates, 1, entry.name);
      assert.equal(harness.authority.trustedSocketBrand(socket), false, entry.name);
    }
    assert.equal(rawSocket.destroys, arranged.rawClosed ? 1 : 0, entry.name);
    await harness.authority.handoff.closeAndDrain();
  }

  let lateCallback;
  let lateRequest;
  const lateRaw = new FakeRawSocket();
  const lateHarness = fakeAuthority({
    behavior({ request, callback }) { lateRequest = request; lateCallback = callback; },
    attachPreparedHostWss() { throw new Error("late attach must not run"); },
  });
  assert.throws(
    () => lateHarness.authority.handoff.upgrade(upgradeInput(receipt(), lateRaw)),
    /Relay v2 Broker Host native Upgrade failed/,
  );
  assert.equal(lateRaw.destroys, 1);
  const lateSocket = new FakeUpgradedSocket();
  lateCallback(lateSocket, lateRequest);
  assert.equal(lateSocket.terminates, 1);
  assert.equal(lateHarness.authority.trustedSocketBrand(lateSocket), false);

  const foreignTarget = canonicalHarness(() => {
    throw new Error("foreign receipt reached native Upgrade");
  });
  const foreignOwner = canonicalHarness(() => {
    throw new Error("unused foreign owner native Upgrade");
  });
  const foreignPrepared = foreignOwner.shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext("foreign-owner-host"),
  });
  assert.equal(foreignPrepared.outcome, "accept");
  const foreignRaw = new FakeRawSocket();
  assert.throws(
    () => foreignTarget.authority.handoff.upgrade(
      upgradeInput(foreignPrepared.receipt, foreignRaw),
    ),
    (error) => error.message === "Relay v2 Broker Host native Upgrade failed"
      && !String(error).includes(TOKEN),
  );
  assert.equal(foreignTarget.nativeUpgrade.calls.length, 0);
  assert.equal(foreignRaw.destroys, 1);
  const forgedRaw = new FakeRawSocket();
  assert.throws(
    () => foreignTarget.authority.handoff.upgrade(upgradeInput(receipt(), forgedRaw)),
    /Relay v2 Broker Host native Upgrade failed/,
  );
  assert.equal(foreignTarget.nativeUpgrade.calls.length, 0);
  assert.equal(forgedRaw.destroys, 1);

  const failedHarness = canonicalHarness(() => {
    throw new Error(`native ${TOKEN}`);
  });
  const failedPrepared = failedHarness.shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext("failed-upgrade-host"),
  });
  assert.equal(failedPrepared.outcome, "accept");
  const failedRaw = new FakeRawSocket();
  assert.throws(
    () => failedHarness.authority.handoff.upgrade(
      upgradeInput(failedPrepared.receipt, failedRaw),
    ),
    (error) => error.message === "Relay v2 Broker Host native Upgrade failed"
      && !String(error).includes(TOKEN),
  );
  assert.equal(failedHarness.nativeUpgrade.calls.length, 1);
  assert.equal(failedRaw.destroys, 1);
  assert.throws(
    () => failedHarness.shared.hostWssRuntime.attachPreparedHostWss({
      receipt: failedPrepared.receipt,
      alreadyUpgradedSocket: new FakeUpgradedSocket(),
    }),
    /admission receipt/,
  );
  const replayNative = new FakeNativeUpgrade(() => {
    throw new Error("consumed receipt reached another native Upgrade");
  });
  const replayAuthority = upgradeModule.createRelayV2BrokerHostWssUpgradeAuthority({
    trustedSocketPrototype: FakeUpgradedSocket.prototype,
    nativeUpgrade: replayNative,
    claimPreparedHostWss: failedHarness.shared.hostWssRuntime.claimPreparedHostWss,
  });
  assert.throws(
    () => replayAuthority.handoff.upgrade(upgradeInput(failedPrepared.receipt)),
    /Relay v2 Broker Host native Upgrade failed/,
  );
  assert.equal(replayNative.calls.length, 0);

  replaySocket.emit("close", 1000);
  await replayHandle.drained;

  await Promise.all([
    replayHarness.authority.handoff.closeAndDrain(),
    replayHarness.shared.closeAndDrain(),
    receiverHarness.authority.handoff.closeAndDrain(),
    lateHarness.authority.handoff.closeAndDrain(),
    foreignTarget.authority.handoff.closeAndDrain(),
    foreignTarget.shared.closeAndDrain(),
    foreignOwner.authority.handoff.closeAndDrain(),
    foreignOwner.shared.closeAndDrain(),
    failedHarness.authority.handoff.closeAndDrain(),
    failedHarness.shared.closeAndDrain(),
    replayAuthority.handoff.closeAndDrain(),
  ]);
});

test("Upgrade/attach/termination failures stay generic and the close barrier fences then drains", async () => {
  const throwingRaw = new FakeRawSocket();
  const throwingHarness = fakeAuthority({
    behavior() { throw new Error(`native ${TOKEN}`); },
    attachPreparedHostWss() { throw new Error("unreachable attach"); },
  });
  assert.throws(
    () => throwingHarness.authority.handoff.upgrade(upgradeInput(receipt(), throwingRaw)),
    (error) => error.message === "Relay v2 Broker Host native Upgrade failed"
      && error.cause === undefined
      && !String(error).includes(TOKEN),
  );
  assert.equal(throwingRaw.destroys, 1);

  const attachSocket = new FakeUpgradedSocket();
  attachSocket.terminateResult = Object.freeze({ foreign: true });
  const attachHarness = fakeAuthority({
    behavior({ request, callback }) { callback(attachSocket, request); },
    attachPreparedHostWss() { throw new Error(`attach ${TOKEN}`); },
  });
  assert.throws(
    () => attachHarness.authority.handoff.upgrade(upgradeInput(receipt())),
    (error) => error.message === "Relay v2 Broker Host native Upgrade failed"
      && !String(error).includes(TOKEN),
  );
  assert.equal(attachSocket.terminates, 1);
  assert.deepEqual(attachSocket.closes, [{ code: 1013, reason: "upgrade_failed" }]);

  const drain = deferred();
  const liveSocket = new FakeUpgradedSocket();
  let liveCallback;
  let liveRequest;
  const liveHarness = fakeAuthority({
    behavior({ request, callback }) {
      liveCallback = callback;
      liveRequest = request;
      callback(liveSocket, request);
    },
    attachPreparedHostWss() { return connectionHandle(drain.promise); },
  });
  liveHarness.authority.handoff.upgrade(upgradeInput(receipt()));
  liveCallback(liveSocket, liveRequest);
  assert.equal(liveSocket.terminates, 1);
  const closing = liveHarness.authority.handoff.closeAndDrain();
  assert.strictEqual(liveHarness.authority.handoff.closeAndDrain(), closing);
  assert.equal(liveSocket.terminates, 2);
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  await settle();
  assert.equal(closeSettled, false);
  const callsBeforeClosedAttempt = liveHarness.nativeUpgrade.calls.length;
  assert.throws(
    () => liveHarness.authority.handoff.upgrade(upgradeInput(receipt())),
    /Relay v2 Broker Host native Upgrade failed/,
  );
  assert.equal(liveHarness.nativeUpgrade.calls.length, callsBeforeClosedAttempt);
  drain.resolve();
  await closing;
  assert.equal(closeSettled, true);

  const brokenDrain = deferred();
  const brokenSocket = new FakeUpgradedSocket();
  brokenSocket.terminateResult = Object.freeze({ foreign: true });
  brokenSocket.closeError = new Error(`close ${TOKEN}`);
  const brokenHarness = fakeAuthority({
    behavior({ request, callback }) { callback(brokenSocket, request); },
    attachPreparedHostWss() { return connectionHandle(brokenDrain.promise); },
  });
  brokenHarness.authority.handoff.upgrade(upgradeInput(receipt()));
  const brokenClose = brokenHarness.authority.handoff.closeAndDrain();
  brokenDrain.resolve();
  await assert.rejects(brokenClose, (error) => (
    error.message === "Relay v2 Broker Host native Upgrade failed"
    && error.cause === undefined
    && !String(error).includes(TOKEN)
  ));

  await Promise.all([
    throwingHarness.authority.handoff.closeAndDrain(),
    attachHarness.authority.handoff.closeAndDrain(),
  ]);
});
