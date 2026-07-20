import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "../dist/relay/v2/codec.js";
import {
  RelayV2HostCarrierActor,
} from "../dist/relay/v2/hostCarrier.js";

const HOST_ID = "mac-admin";
const ENROLLMENT_REQUEST_ID = "dmgmt2.enrollment-one";
const REVOCATION_REQUEST_ID = "dmgmt2.revocation-one";

function wire(frame) {
  return encodeRelayV2WebSocketFrame("carrier", frame);
}

function decoded(frames) {
  return frames.map((frame) => decodeRelayV2WebSocketFrame("carrier", frame).frame);
}

class FakeTransport {
  accepting = true;
  bufferedBytes = 0;
  pendingDeliveries = [];
  sent = [];
  closes = [];

  trySend(frame, deliveryToken) {
    if (!this.accepting) return false;
    const bytes = Uint8Array.from(frame);
    this.sent.push(bytes);
    this.bufferedBytes += bytes.byteLength;
    this.pendingDeliveries.push({ deliveryToken, byteLength: bytes.byteLength });
    return true;
  }

  bufferedAmount() {
    return this.bufferedBytes;
  }

  confirmNext() {
    const delivery = this.pendingDeliveries.shift();
    assert.ok(delivery, "no pending fake delivery");
    this.bufferedBytes -= delivery.byteLength;
    return delivery.deliveryToken;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

class FakeCredentials {
  read(reference) {
    assert.equal(reference, "credential-one");
    return {
      reference,
      version: "1",
      grantId: "host-grant-one",
      accessJti: "host-access-jti-one",
      accessToken: "twcap2.credential-one.payload.mac",
    };
  }

  prepareReauthentication() {
    assert.fail("reauthentication is outside this suite");
  }

  acknowledgeReauthentication() {
    assert.fail("reauthentication is outside this suite");
  }
}

function harness(options = {}) {
  let nextHello = 1;
  const actor = new RelayV2HostCarrierActor({
    hostId: HOST_ID,
    hostEpoch: "host-epoch-one",
    hostInstanceId: "host-instance-one",
    credentialReferences: new FakeCredentials(),
    advertisedCapabilities: [],
    clock: () => 1_783_700_100_000,
    idFactory: () => `host-hello-${nextHello++}`,
    queueLimits: options.queueLimits,
    routeSink: {
      onRouteBound() {},
      onClientFrame() {},
      onRouteUnbound() {},
    },
  });
  const adapter = actor.createDashboardManagementCarrierControlAdapter();
  return { actor, adapter };
}

function connect(h, connectorId = "connector-one", transport = new FakeTransport()) {
  const connection = h.actor.connect(transport, "credential-one");
  const hello = decoded(transport.sent).at(-1);
  assert.equal(hello.type, "host.hello");
  connection.receive(wire({
    carrierVersion: 1,
    type: "host.registered",
    requestId: hello.requestId,
    connectorId,
    payload: {
      brokerEpoch: "broker-epoch-one",
      hostsRevision: "1",
      disposition: "connected",
      supersededHostInstanceId: null,
      limits: {
        maxCarrierFrameBytes: 1_500_000,
        brokerCarrierBufferedBytes: 16_777_216,
        brokerCarrierLowWaterBytes: 8_388_608,
      },
    },
  }));
  connection.acknowledge(transport.confirmNext());
  return { connection, transport, connectorId };
}

function createInput(connectorId = "connector-one", requestId = ENROLLMENT_REQUEST_ID) {
  return {
    requestId,
    hostId: HOST_ID,
    connectorId,
    deviceLabel: "Pixel",
  };
}

function revokeInput(connectorId = "connector-one", requestId = REVOCATION_REQUEST_ID) {
  return {
    requestId,
    hostId: HOST_ID,
    connectorId,
    grantId: "client-grant-one",
    reason: "user_revoked",
  };
}

function enrollmentCreated(
  connectorId = "connector-one",
  requestId = ENROLLMENT_REQUEST_ID,
) {
  return {
    carrierVersion: 1,
    type: "enrollment.created",
    requestId,
    connectorId,
    payload: {
      deduplicated: false,
      enrollmentId: "enrollment-one",
      enrollmentCode: "twenroll2.one-time-code",
      hostId: HOST_ID,
      issuerUrl: "https://relay.example.com/",
      relayUrl: "wss://relay.example.com/client",
      expiresAtMs: 1_783_700_300_000,
    },
  };
}

function grantRevoked(
  connectorId = "connector-one",
  requestId = REVOCATION_REQUEST_ID,
) {
  return {
    carrierVersion: 1,
    type: "grant.revoked",
    requestId,
    connectorId,
    payload: {
      grantId: "client-grant-one",
      revokedAtMs: 1_783_700_200_000,
      alreadyRevoked: false,
    },
  };
}

function carrierError(connectorId, requestId, failedType, code, retryable) {
  return {
    carrierVersion: 1,
    type: "carrier.error",
    requestId,
    connectorId,
    payload: { failedType },
    error: {
      code,
      message: "private broker detail must not reflect",
      retryable,
      retryAfterMs: retryable ? 1_000 : null,
      commandDisposition: "not_applicable",
      details: null,
    },
  };
}

function superseded(connectorId) {
  return {
    carrierVersion: 1,
    type: "host.superseded",
    connectorId,
    payload: {
      hostId: HOST_ID,
      losingConnectorId: connectorId,
      winningConnectorId: "connector-winner",
      losingHostInstanceId: "host-instance-one",
      winningHostInstanceId: "host-instance-winner",
      reason: "new_authenticated_connector",
    },
  };
}

function routeOpen(connectorId) {
  return {
    carrierVersion: 1,
    type: "route.open",
    requestId: "route-open-one",
    connectorId,
    routeId: "route-one",
    routeFence: "route-fence-one",
    payload: {
      connectionId: "client-connection-one",
      clientDialect: "tw-relay.v2",
      authContext: {
        scheme: "twcap2",
        role: "client",
        hostId: HOST_ID,
        principalId: "principal-one",
        grantId: "client-grant-one",
        clientInstanceId: "client-instance-one",
        jti: "client-jti-one",
        kid: "issuer-key-one",
        expiresAtMs: 1_783_703_600_000,
      },
      limits: { maxFrameBytes: 1_048_576 },
    },
  };
}

function authorityFailure(code) {
  return (error) => error?.name === "RelayV2DashboardManagementAuthorityFailure"
    && error.code === code;
}

test("the native-private adapter exposes no reflective owner or bypass port", async () => {
  const h = harness();
  assert.equal(h.actor.createDashboardManagementCarrierControlAdapter(), h.adapter);
  assert.deepEqual(Reflect.ownKeys(h.adapter), []);
  assert.deepEqual(Object.getOwnPropertyDescriptors(h.adapter), {});
  assert.equal(Reflect.get(h.adapter, "owner"), undefined);
  assert.equal(Reflect.get(h.adapter, "#owner"), undefined);
  assert.equal(Reflect.get(h.adapter, "terminallyClosed"), undefined);
  assert.equal(Reflect.get(h.adapter, "debug"), undefined);
  assert.equal(Reflect.get(h.adapter, "toJSON"), undefined);

  let bypassCalls = 0;
  const forgedFrozenOwner = Object.freeze({
    invoke() { bypassCalls += 1; },
  });
  const ActorOwnedAdapter = h.adapter.constructor;
  assert.throws(
    () => Reflect.construct(ActorOwnedAdapter, [{ owner: forgedFrozenOwner }]),
    (error) => error?.name
      === "RelayV2DashboardManagementHostCarrierControlAdapterClosedError",
  );
  const transport = new FakeTransport();
  h.actor.connect(transport, "credential-one");
  await assert.rejects(h.adapter.createEnrollment(createInput()), authorityFailure("NOT_READY"));
  assert.equal(
    decoded(transport.sent).some(({ type }) => type === "enrollment.create"),
    false,
  );
  assert.equal(bypassCalls, 0);
});

test("registered create and revoke each emit one fixed control and return exact receipts", async () => {
  const h = harness();
  const active = connect(h);

  const enrollmentPending = h.adapter.createEnrollment(createInput());
  const enrollmentFrames = decoded(active.transport.sent)
    .filter(({ type }) => type === "enrollment.create");
  assert.deepEqual(JSON.parse(JSON.stringify(enrollmentFrames)), [{
    carrierVersion: 1,
    type: "enrollment.create",
    requestId: ENROLLMENT_REQUEST_ID,
    connectorId: active.connectorId,
    payload: { expiresInMs: 300_000, deviceLabel: "Pixel" },
  }]);
  active.connection.receive(wire(enrollmentCreated()));
  const enrollment = await enrollmentPending;
  assert.deepEqual(enrollment, {
    enrollmentId: "enrollment-one",
    enrollmentCode: "twenroll2.one-time-code",
    expiresAtMs: 1_783_700_300_000,
    issuerUrl: "https://relay.example.com/",
    relayUrl: "wss://relay.example.com/client",
    hostId: HOST_ID,
    connectorId: active.connectorId,
    deviceLabel: "Pixel",
  });

  const revocationPending = h.adapter.revokeGrant(revokeInput());
  const revocationFrames = decoded(active.transport.sent)
    .filter(({ type }) => type === "grant.revoke");
  assert.deepEqual(JSON.parse(JSON.stringify(revocationFrames)), [{
    carrierVersion: 1,
    type: "grant.revoke",
    requestId: REVOCATION_REQUEST_ID,
    connectorId: active.connectorId,
    payload: { grantId: "client-grant-one", reason: "user_revoked" },
  }]);
  active.connection.receive(wire(grantRevoked()));
  assert.deepEqual(await revocationPending, {
    grantId: "client-grant-one",
    revokedAtMs: 1_783_700_200_000,
    alreadyRevoked: false,
    hostId: HOST_ID,
    connectorId: active.connectorId,
  });

  const serialized = JSON.stringify(enrollment);
  assert.equal(serialized.includes("twenroll2.one-time-code"), true);
  assert.equal(serialized.includes("twcap2."), false);
  assert.equal(serialized.includes("twref2."), false);
  assert.equal(serialized.includes("twhostboot2."), false);
  assert.equal(serialized.includes("accessToken"), false);
  assert.equal(serialized.includes("refreshToken"), false);
  assert.equal(serialized.includes("bootstrapToken"), false);
});

test("one exact pending fingerprint sends once while every different request is BUSY", async () => {
  const h = harness();
  const active = connect(h);
  const first = h.adapter.createEnrollment(createInput());
  const duplicate = h.adapter.createEnrollment(createInput());
  await assert.rejects(
    h.adapter.createEnrollment(createInput(active.connectorId, "dmgmt2.enrollment-two")),
    authorityFailure("BUSY"),
  );
  await assert.rejects(h.adapter.revokeGrant(revokeInput()), authorityFailure("BUSY"));
  assert.equal(
    decoded(active.transport.sent).filter(({ type }) => type === "enrollment.create").length,
    1,
  );
  active.connection.receive(wire(enrollmentCreated()));
  assert.deepEqual(await duplicate, await first);
});

test("replacement fences the old generation and a late old response cannot settle the winner", async () => {
  const h = harness();
  const old = connect(h, "connector-old");
  const oldPending = h.adapter.createEnrollment(createInput("connector-old"));
  const oldRejected = assert.rejects(oldPending, authorityFailure("NOT_READY"));

  const replacement = connect(h, "connector-new", new FakeTransport());
  await oldRejected;
  const winnerPending = h.adapter.createEnrollment(createInput("connector-new"));
  let winnerSettled = false;
  winnerPending.finally(() => { winnerSettled = true; });
  old.connection.receive(wire(enrollmentCreated("connector-old")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(winnerSettled, false);
  replacement.connection.receive(wire(enrollmentCreated("connector-new")));
  assert.equal((await winnerPending).connectorId, "connector-new");
});

test("disconnect, supersede, and dispose settle pending once and ignore late callbacks", async (t) => {
  for (const mode of ["disconnect", "supersede", "dispose"]) {
    await t.test(mode, async () => {
      const h = harness();
      const active = connect(h);
      const pending = h.adapter.createEnrollment(createInput());
      let settlements = 0;
      pending.then(
        () => { settlements += 1; },
        () => { settlements += 1; },
      );
      const rejected = assert.rejects(pending, authorityFailure("NOT_READY"));
      if (mode === "disconnect") active.connection.closed(1006);
      if (mode === "supersede") active.connection.receive(wire(superseded(active.connectorId)));
      if (mode === "dispose") h.actor.dispose();
      await rejected;
      active.connection.receive(wire(enrollmentCreated()));
      active.connection.closed(1006);
      h.actor.dispose();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settlements, 1);
    });
  }
});

test("requestId, response type, connectorId, failedType, and unknown correlation fail closed", async (t) => {
  const mismatches = [
    ["requestId", (active) => enrollmentCreated(active.connectorId, "dmgmt2.foreign")],
    ["response type", (active) => grantRevoked(active.connectorId, ENROLLMENT_REQUEST_ID)],
    ["connectorId", () => enrollmentCreated("connector-foreign")],
    ["failedType", (active) => carrierError(
      active.connectorId,
      ENROLLMENT_REQUEST_ID,
      "grant.revoke",
      "PERMISSION_DENIED",
      false,
    )],
  ];
  for (const [name, response] of mismatches) {
    await t.test(name, async () => {
      const h = harness();
      const active = connect(h);
      const pending = h.adapter.createEnrollment(createInput());
      const rejected = assert.rejects(pending, authorityFailure("NOT_READY"));
      active.connection.receive(wire(response(active)));
      await rejected;
      assert.equal(h.actor.status().phase, "offline");
      assert.equal(active.transport.closes.length, 1);
    });
  }

  await t.test("response without pending request", () => {
    const h = harness();
    const active = connect(h);
    active.connection.receive(wire(enrollmentCreated()));
    assert.equal(h.actor.status().phase, "offline");
    assert.deepEqual(active.transport.closes, [{
      code: 4400,
      reason: "invalid_dashboard_control_correlation",
    }]);
  });
});

test("bounded control queue refusal maps closed to BUSY without sending the request", async () => {
  const h = harness({ queueLimits: { maxQueuedControlFrames: 1 } });
  const active = connect(h);
  active.transport.accepting = false;
  active.connection.receive(wire(routeOpen(active.connectorId)));
  await assert.rejects(h.adapter.createEnrollment(createInput()), authorityFailure("BUSY"));
  assert.equal(
    decoded(active.transport.sent).some(({ type }) => type === "enrollment.create"),
    false,
  );
  assert.equal(h.actor.status().phase, "registered");
});

test("carrier.error uses the closed authority mapping and never reflects broker text", async (t) => {
  for (const [carrierCode, retryable, authorityCode] of [
    ["BUSY", true, "BUSY"],
    ["CAPABILITY_UNAVAILABLE", false, "UNAVAILABLE"],
    ["PERMISSION_DENIED", false, "OPERATION_FAILED"],
  ]) {
    await t.test(carrierCode, async () => {
      const h = harness();
      const active = connect(h);
      const pending = h.adapter.createEnrollment(createInput());
      const rejected = assert.rejects(
        pending,
        (error) => authorityFailure(authorityCode)(error)
          && !error.message.includes("private broker detail"),
      );
      active.connection.receive(wire(carrierError(
        active.connectorId,
        ENROLLMENT_REQUEST_ID,
        "enrollment.create",
        carrierCode,
        retryable,
      )));
      await rejected;
      assert.equal(h.actor.status().phase, "registered");
    });
  }
});
