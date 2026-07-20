import assert from "node:assert/strict";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const closeOwner = await import("../dist/relay/v2/brokerTransportCloseCoordinator.js");

const NOW_MS = 1_783_700_000_000;

class ManualDeadlineScheduler {
  nextHandle = 1;
  scheduled = new Map();

  schedule(callback, delayMs) {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { callback, delayMs });
    return handle;
  }

  cancel(handle) {
    this.scheduled.delete(handle);
  }

  fireAll() {
    const pending = [...this.scheduled.values()];
    this.scheduled.clear();
    for (const item of pending) item.callback();
  }
}

class SynchronousDeadlineScheduler {
  nextHandle = 1;
  scheduled = new Map();
  delays = [];

  schedule(callback, delayMs) {
    const handle = this.nextHandle++;
    this.delays.push(delayMs);
    this.scheduled.set(handle, callback);
    callback();
    return handle;
  }

  cancel(handle) {
    this.scheduled.delete(handle);
  }
}

function authContext(role) {
  return {
    scheme: "twcap2",
    role,
    hostId: "mac-admin",
    principalId: role === "host" ? "host-principal" : "client-principal",
    grantId: role === "host" ? "host-grant" : "client-grant",
    clientInstanceId: role === "host" ? null : "android-install",
    jti: role === "host" ? "host-jti" : "client-jti",
    kid: "key-2026-07",
    expiresAtMs: NOW_MS + 3_600_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
  };
}

function closeSignal(connectionKind, connectionId, connectionIncarnation, reason) {
  return {
    connectionKind,
    ...(connectionKind === "client" ? { connectionId } : { transportId: connectionId }),
    connectionIncarnation,
    reason,
    authorization: {},
  };
}

async function flushCloseRequests() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Relay v2 broker transport close coordinator foundation", async (t) => {
  await t.test("defers transport work and owns the closed reason-to-code policy", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    const observations = [];
    const registrations = [];
    const cases = [
      ["client", "client-expired", "access_expired", 4401],
      ["client", "client-revoked", "grant_revoked", 4403],
      ["host", "host-kid-removed", "kid_removed", 4403],
      ["host", "host-authority-loss", "credential_authority_unavailable", 1013],
      ["client", "client-host-fenced", "host_authorization_fenced", 1013],
    ];

    for (const [connectionKind, id, reason] of cases) {
      const registration = coordinator.registerSocket({
        connectionKind,
        ...(connectionKind === "client" ? { connectionId: id } : { transportId: id }),
        close(code, observedReason) {
          observations.push([id, code, observedReason]);
        },
        forceDestroy() {
          assert.fail(`force destroy was not expected for ${id}`);
        },
      });
      registrations.push(registration);
      const signal = closeSignal(
        connectionKind,
        id,
        registration.connectionIncarnation,
        reason,
      );
      assert.equal(coordinator.handleLiveAuthorizationClose(signal), true);
      assert.equal(coordinator.handleLiveAuthorizationClose(signal), true, "duplicate is absorbed");
      assert.equal(observations.length, 0, "business-fence callback never closes inline");
    }

    assert.deepEqual(
      [...scheduler.scheduled.values()].map((item) => item.delayMs),
      cases.map(() => 5_000),
    );
    await flushCloseRequests();
    assert.deepEqual(
      observations,
      cases.map(([, id, reason, code]) => [id, code, reason]),
    );
    for (const registration of registrations) registration.unregister();
    assert.equal(scheduler.scheduled.size, 0);
  });

  await t.test("exact kind, ID and incarnation matching fences ABA reuse and Agent failures", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    const closes = [];
    const oldRegistration = coordinator.registerSocket({
      connectionKind: "client",
      connectionId: "reused-id",
      close: () => assert.fail("unregistered old socket must not close"),
      forceDestroy: () => assert.fail("unregistered old socket must not destroy"),
    });
    oldRegistration.unregister();

    let currentSignal;
    const currentRegistration = coordinator.registerSocket({
      connectionKind: "client",
      connectionId: "reused-id",
      close(code, reason) {
        closes.push([code, reason]);
        coordinator.handleLiveAuthorizationClose(currentSignal);
      },
      forceDestroy: () => assert.fail("current socket was cleanly unregistered"),
    });
    const oldSignal = closeSignal(
      "client",
      "reused-id",
      oldRegistration.connectionIncarnation,
      "grant_revoked",
    );
    assert.equal(coordinator.handleLiveAuthorizationClose(oldSignal), false);
    assert.equal(coordinator.handleLiveAuthorizationClose(closeSignal(
      "host",
      "reused-id",
      currentRegistration.connectionIncarnation,
      "grant_revoked",
    )), false);
    assert.equal(coordinator.handleLiveAuthorizationClose({
      ...closeSignal(
        "client",
        "reused-id",
        currentRegistration.connectionIncarnation,
        "grant_revoked",
      ),
      reason: "AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE",
    }), false, "Agent namespace failure never enters credential close policy");
    assert.equal(scheduler.scheduled.size, 0);

    currentSignal = closeSignal(
      "client",
      "reused-id",
      currentRegistration.connectionIncarnation,
      "grant_revoked",
    );
    assert.equal(coordinator.handleLiveAuthorizationClose(currentSignal), true);
    await flushCloseRequests();
    assert.deepEqual(closes, [[4403, "grant_revoked"]], "callback reentry remains once-only");
    currentRegistration.unregister();
  });

  await t.test("registration preserves method receivers and rejects non-v2 connection kinds", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    assert.throws(() => coordinator.registerSocket({
      connectionKind: "agent",
      transportId: "agent-must-not-enter-host-registry",
      close() {},
      forceDestroy() {},
    }), /connection kind/);

    let gracefulRegistration;
    const gracefulSocket = {
      connectionKind: "client",
      connectionId: "receiver-graceful",
      closeCalls: 0,
      close(code, reason) {
        assert.equal(this, gracefulSocket);
        this.closeCalls += 1;
        assert.deepEqual([code, reason], [4401, "access_expired"]);
        gracefulRegistration.unregister();
      },
      forceDestroy() {
        assert.fail("graceful receiver socket must not be destroyed");
      },
    };
    gracefulRegistration = coordinator.registerSocket(gracefulSocket);
    assert.equal(coordinator.handleLiveAuthorizationClose(closeSignal(
      "client",
      gracefulSocket.connectionId,
      gracefulRegistration.connectionIncarnation,
      "access_expired",
    )), true);
    await flushCloseRequests();
    assert.equal(gracefulSocket.closeCalls, 1);

    const forcedSocket = {
      connectionKind: "host",
      transportId: "receiver-forced",
      closeCalls: 0,
      destroyCalls: 0,
      close() {
        assert.equal(this, forcedSocket);
        this.closeCalls += 1;
        return new Promise(() => {});
      },
      forceDestroy() {
        assert.equal(this, forcedSocket);
        this.destroyCalls += 1;
      },
    };
    const forcedRegistration = coordinator.registerSocket(forcedSocket);
    assert.equal(coordinator.handleLiveAuthorizationClose(closeSignal(
      "host",
      forcedSocket.transportId,
      forcedRegistration.connectionIncarnation,
      "credential_authority_unavailable",
    )), true);
    await flushCloseRequests();
    scheduler.fireAll();
    assert.deepEqual(
      [forcedSocket.closeCalls, forcedSocket.destroyCalls],
      [1, 1],
      "both receiver-dependent methods use the original socket",
    );
    forcedRegistration.unregister();
  });

  await t.test("a synchronously fired deadline is terminal before schedule returns", async () => {
    const scheduler = new SynchronousDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    let signal;
    const socket = {
      connectionKind: "client",
      connectionId: "sync-deadline",
      closeCalls: 0,
      destroyCalls: 0,
      close() {
        this.closeCalls += 1;
      },
      forceDestroy() {
        assert.equal(this, socket);
        this.destroyCalls += 1;
        assert.equal(
          coordinator.handleLiveAuthorizationClose(signal),
          true,
          "destroy reentry is absorbed by terminal state",
        );
      },
    };
    const registration = coordinator.registerSocket(socket);
    signal = closeSignal(
      "client",
      socket.connectionId,
      registration.connectionIncarnation,
      "credential_authority_unavailable",
    );

    assert.equal(coordinator.handleLiveAuthorizationClose(signal), true);
    assert.deepEqual(scheduler.delays, [5_000]);
    assert.equal(socket.destroyCalls, 1);
    assert.equal(socket.closeCalls, 0, "destroyed socket never queues graceful close");
    assert.equal(scheduler.scheduled.size, 0, "expired handle is not left armed");
    assert.equal(coordinator.handleLiveAuthorizationClose(signal), true);
    assert.deepEqual(scheduler.delays, [5_000], "terminal duplicate cannot reschedule");
    await flushCloseRequests();
    assert.equal(socket.closeCalls, 0);
    registration.unregister();
  });

  await t.test("throwing, reentrant and hanging callbacks are isolated per socket", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    const closeCalls = [];
    const destroyCalls = [];
    const registrations = new Map();
    const signals = new Map();

    for (const id of ["throws", "hangs", "closes"]) {
      const registration = coordinator.registerSocket({
        connectionKind: "client",
        connectionId: id,
        close() {
          closeCalls.push(id);
          coordinator.handleLiveAuthorizationClose(signals.get(id));
          if (id === "throws") throw new Error("injected close failure");
          if (id === "hangs") return new Promise(() => {});
          registrations.get(id).unregister();
        },
        forceDestroy() {
          destroyCalls.push(id);
          coordinator.handleLiveAuthorizationClose(signals.get(id));
          if (id === "throws") throw new Error("injected destroy failure");
        },
      });
      registrations.set(id, registration);
      signals.set(id, closeSignal(
        "client",
        id,
        registration.connectionIncarnation,
        "credential_authority_unavailable",
      ));
    }

    for (const signal of signals.values()) {
      assert.equal(coordinator.handleLiveAuthorizationClose(signal), true);
    }
    await flushCloseRequests();
    assert.deepEqual(closeCalls, ["throws", "hangs", "closes"]);
    assert.deepEqual(destroyCalls, ["throws"], "throw forces only its own socket");
    assert.equal(scheduler.scheduled.size, 1, "only the hanging socket retains its deadline");
    assert.equal([...scheduler.scheduled.values()][0].delayMs, 5_000);

    scheduler.fireAll();
    assert.deepEqual(destroyCalls, ["throws", "hangs"], "deadline force-destroys the hang");
    assert.equal(scheduler.scheduled.size, 0);
    assert.equal(coordinator.handleLiveAuthorizationClose(signals.get("hangs")), true);
    await flushCloseRequests();
    assert.deepEqual(closeCalls, ["throws", "hangs", "closes"], "all reentry is once-only");
    registrations.get("hangs").unregister();
  });

  await t.test("BrokerCore synchronous fence precedes the coordinator's async close", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    const closeLatchStates = [];
    let core;
    const registration = coordinator.registerSocket({
      connectionKind: "host",
      transportId: "host-ready-loss-order",
      close() {
        closeLatchStates.push(core.inspectLiveAuthCompositionLatch());
        registration.unregister();
      },
      forceDestroy: () => assert.fail("close callback unregisters the socket"),
    });
    core = new broker.RelayV2BrokerCore({
      now: () => NOW_MS,
      onLiveAuthorizationClose: (signal) => {
        coordinator.handleLiveAuthorizationClose(signal);
      },
    });
    core.attachHostCarrier(
      "host-ready-loss-order",
      authContext("host"),
      registration.connectionIncarnation,
    );

    core.liveAuthorizationFencePort.failClosed();
    assert.equal(core.inspectLiveAuthCompositionLatch(), "latched_fail_closed");
    assert.deepEqual(closeLatchStates, [], "transport close is not run in the fence turn");
    assert.throws(() => core.attachHostCarrier(
      "host-after-ready-loss",
      authContext("host"),
      "new-incarnation-after-ready-loss",
    ));

    await flushCloseRequests();
    assert.deepEqual(closeLatchStates, ["latched_fail_closed"]);
    assert.equal(scheduler.scheduled.size, 0);
  });

  await t.test("managed client lease is exact, one-shot, and retained until terminal", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: scheduler,
    });
    let destroys = 0;
    const registration = coordinator.registerManagedClientSocket({
      connectionKind: "client",
      connectionId: "managed-client",
      close() {},
      forceDestroy() { destroys += 1; },
    });
    assert.throws(() => closeOwner.consumeRelayV2BrokerClientTransportCloseLease(
      Object.freeze({}),
      "managed-client",
    ));
    assert.equal(
      closeOwner.consumeRelayV2BrokerClientTransportCloseLease(
        registration.lease,
        "managed-client",
      ),
      registration.connectionIncarnation,
    );
    assert.throws(() => closeOwner.consumeRelayV2BrokerClientTransportCloseLease(
      registration.lease,
      "managed-client",
    ));
    assert.equal(coordinator.forceDestroyManagedSocket(registration.lease), true);
    assert.equal(coordinator.forceDestroyManagedSocket(registration.lease), true);
    assert.equal(destroys, 1, "force request is once-only but is not terminal");
    assert.throws(() => coordinator.registerManagedClientSocket({
      connectionKind: "client",
      connectionId: "managed-client",
      close() {},
      forceDestroy() {},
    }));
    assert.equal(coordinator.terminalAndUnregisterManagedSocket(registration.lease), true);

    const unclaimed = coordinator.registerManagedClientSocket({
      connectionKind: "client",
      connectionId: "managed-client",
      close() {},
      forceDestroy() {},
    });
    assert.equal(coordinator.terminalAndUnregisterManagedSocket(unclaimed.lease), false);
    assert.throws(() => coordinator.registerManagedClientSocket({
      connectionKind: "client",
      connectionId: "managed-client",
      close() {},
      forceDestroy() {},
    }));
    closeOwner.consumeRelayV2BrokerClientTransportCloseLease(
      unclaimed.lease,
      "managed-client",
    );
    assert.equal(coordinator.terminalAndUnregisterManagedSocket(unclaimed.lease), true);
  });
});
