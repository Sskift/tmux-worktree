import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES,
  RelayV2DashboardManagementProtocolV2Error,
  decodeRelayV2DashboardManagementProtocolV2Request,
  encodeRelayV2DashboardManagementProtocolV2ReadyFrame,
  encodeRelayV2DashboardManagementProtocolV2ResponseFrame,
} from "../dist/relay/v2/relayV2DashboardManagementProtocolV2.js";
import {
  RelayV2DashboardManagementAuthority,
  RelayV2DashboardManagementAuthorityClosedError,
  RelayV2DashboardManagementAuthorityFailure,
} from "../dist/relay/v2/relayV2DashboardManagementAuthority.js";

const contractRoot = new URL(
  "../contracts/dashboard-relay-v2-management/v2/",
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", contractRoot), "utf8"));
const cases = JSON.parse(readFileSync(new URL("cases.json", contractRoot), "utf8"));

const REQUIRED = Object.freeze([...manifest.dashboardProjection.requiredCapabilities]);
const IDS = Object.freeze({
  status: "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw",
  bootstrap: "dmgmt2.wkHofchV36_U1sOtXF-hvA",
  refresh: "dmgmt2.m-XajdYifbX8v1Dvxfua9g",
  start: "dmgmt2.GGg3IoUgDIXzfENx8QbHlw",
  stop: "dmgmt2.XXdOhONQuogS0f2jMdFnOQ",
  create: "dmgmt2.ocsJ9anwzHRz4iyXdA5cjA",
  revoke: "dmgmt2._rgZ2FBzDmkt9MwqnM3uDg",
});

function decodeFrame(frame) {
  return decodeRelayV2DashboardManagementProtocolV2Request(
    Buffer.from(frame.slice(0, -1), "utf8"),
  );
}

function request(operation, input = null) {
  const idByOperation = {
    status: IDS.status,
    bootstrap_host: IDS.bootstrap,
    refresh_host: IDS.refresh,
    start_connector: IDS.start,
    stop_connector: IDS.stop,
    create_enrollment: IDS.create,
    revoke_client_grant: IDS.revoke,
  };
  return decodeRelayV2DashboardManagementProtocolV2Request(Buffer.from(JSON.stringify({
    protocolVersion: 2,
    requestId: idByOperation[operation],
    operation,
    input,
  })));
}

function readyCredential(
  reference = "host-credential-ref-2",
  hostId = "mac-admin",
  expiresAtMs = 1_783_707_200_000,
) {
  return {
    status: "ready",
    hostId,
    credentialReference: reference,
    expiresAtMs,
  };
}

function registeredConnector(
  capabilities = REQUIRED,
  hostId = "mac-admin",
  connectorId = "connector-1",
) {
  return {
    status: "registered",
    acknowledgement: "host.registered",
    hostId,
    connectorId,
    negotiatedCapabilityIntersection: [...capabilities],
  };
}

function harness(options = {}) {
  let now = options.now ?? 1_783_700_000_000;
  let credentialState = structuredClone(options.credential ?? { status: "missing" });
  let connectorState = structuredClone(options.connector ?? { status: "stopped" });
  const calls = [];
  const control = {
    createEnrollment: async (input) => {
      calls.push(["createEnrollment", structuredClone(input)]);
      if (options.createFailure) throw options.createFailure;
      return options.enrollmentReceipt ?? {
        enrollmentId: "enrollment-1",
        enrollmentCode: "twenroll2.one-time-code",
        expiresAtMs: 1_783_700_300_000,
        issuerUrl: "https://relay.example.com",
        relayUrl: "wss://relay.example.com/client",
        hostId: "mac-admin",
        connectorId: "connector-1",
        deviceLabel: input.deviceLabel,
      };
    },
    revokeGrant: async (input) => {
      calls.push(["revokeGrant", structuredClone(input)]);
      if (options.revokeFailure) throw options.revokeFailure;
      return options.revocationReceipt ?? {
        grantId: input.grantId,
        revokedAtMs: 1_783_700_200_000,
        alreadyRevoked: false,
        hostId: "mac-admin",
        connectorId: "connector-1",
      };
    },
  };
  const credentialPort = {
    inspect: async () => {
      calls.push(["credential.inspect"]);
      return structuredClone(credentialState);
    },
    bootstrap: async (input) => {
      calls.push(["credential.bootstrap", structuredClone(input)]);
      if (options.operationFailure) throw options.operationFailure;
      credentialState = readyCredential(
        "host-credential-ref-1",
        "mac-admin",
        1_783_703_600_000,
      );
    },
    refresh: async (input) => {
      calls.push(["credential.refresh", structuredClone(input)]);
      if (options.operationFailure) throw options.operationFailure;
      credentialState = readyCredential("host-credential-ref-2");
    },
  };
  const connectorPort = {
    inspectCut: async () => {
      calls.push(["connector.inspectCut"]);
      return structuredClone(connectorState);
    },
    start: async (input) => {
      calls.push(["connector.start", structuredClone(input)]);
      if (options.operationFailure) throw options.operationFailure;
      connectorState = registeredConnector();
    },
    stop: async (input) => {
      calls.push(["connector.stop", structuredClone(input)]);
      if (options.operationFailure) throw options.operationFailure;
      connectorState = { status: "stopped" };
    },
  };
  const authority = new RelayV2DashboardManagementAuthority({
    credential: credentialPort,
    connector: connectorPort,
    carrierControl: control,
    clock: () => now,
  });
  return {
    authority,
    calls,
    setNow(value) { now = value; },
    setCredential(value) { credentialState = structuredClone(value); },
    setConnector(value) {
      connectorState = structuredClone(value);
    },
  };
}

test("protocol v2 directly consumes every D2 golden request, response, and ready frame", () => {
  assert.equal(
    encodeRelayV2DashboardManagementProtocolV2ReadyFrame(cases.constants.runtimeVersion),
    cases.startupReadyFrame,
  );
  assert.equal(cases.goldenExchanges.length, manifest.requestSchema.operations.length);
  for (const exchange of cases.goldenExchanges) {
    const decoded = decodeFrame(exchange.requestFrame);
    assert.deepEqual(decoded, exchange.normalizedRequest, exchange.name);
    const response = JSON.parse(exchange.responseFrame);
    assert.equal(
      encodeRelayV2DashboardManagementProtocolV2ResponseFrame(response, decoded),
      exchange.responseFrame,
      exchange.name,
    );
  }
});

test("protocol v2 rejects unknown, duplicate, coercion, requestId, input, and secret material", () => {
  const marker = "twref2.forbidden-marker";
  const invalid = [
    { protocolVersion: 2, requestId: IDS.status, operation: "status", input: null, extra: 1 },
    { protocolVersion: "2", requestId: IDS.status, operation: "status", input: null },
    { protocolVersion: 2, requestId: "dmgmt2.not-canonical", operation: "status", input: null },
    { protocolVersion: 2, requestId: IDS.status, operation: "status", input: {} },
    { protocolVersion: 2, requestId: IDS.create, operation: "create_enrollment", input: {} },
    { protocolVersion: 2, requestId: IDS.create, operation: "create_enrollment", input: { deviceLabel: " Pixel " } },
    { protocolVersion: 2, requestId: IDS.create, operation: "create_enrollment", input: { deviceLabel: marker } },
    { protocolVersion: 2, requestId: IDS.revoke, operation: "revoke_client_grant", input: { grantId: "grant", reason: "admin" } },
    { protocolVersion: 2, requestId: IDS.revoke, operation: "revoke_client_grant", input: { grantId: marker, reason: "user_revoked" } },
  ];
  for (const value of invalid) {
    assert.throws(
      () => decodeRelayV2DashboardManagementProtocolV2Request(Buffer.from(JSON.stringify(value))),
      (error) => error instanceof RelayV2DashboardManagementProtocolV2Error
        && !error.message.includes(marker),
    );
  }
  const duplicate = `{"protocolVersion":2,"requestId":"${IDS.create}","operation":"create_enrollment","input":{"deviceLabel":"Pixel","deviceLabel":"${marker}"}}`;
  assert.throws(
    () => decodeRelayV2DashboardManagementProtocolV2Request(Buffer.from(duplicate)),
    RelayV2DashboardManagementProtocolV2Error,
  );
  assert.throws(
    () => decodeRelayV2DashboardManagementProtocolV2Request(
      Buffer.alloc(RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES + 1, 0x20),
    ),
    RelayV2DashboardManagementProtocolV2Error,
  );
});

test("response encoder rejects D2 forbidden projections, correlation mismatches, and local errors", () => {
  const statusRequest = request("status");
  for (const invalid of cases.invalidResponseFrameCases) {
    if (invalid.name === "malformed-json") continue;
    const response = JSON.parse(invalid.frame);
    assert.throws(
      () => encodeRelayV2DashboardManagementProtocolV2ResponseFrame(response, statusRequest),
      RelayV2DashboardManagementProtocolV2Error,
      invalid.name,
    );
  }
  const incomplete = structuredClone(cases.projectionCases.registeredIncomplete);
  assert.doesNotThrow(() => encodeRelayV2DashboardManagementProtocolV2ResponseFrame(
    incomplete,
    statusRequest,
  ));
  const incompleteWithEnrollment = structuredClone(cases.projectionCases.incompleteWithEnrollment);
  assert.throws(
    () => encodeRelayV2DashboardManagementProtocolV2ResponseFrame(
      incompleteWithEnrollment,
      statusRequest,
    ),
    RelayV2DashboardManagementProtocolV2Error,
  );
});

test("each authority operation invokes its mutation port once with only the closed input", async (t) => {
  const scenarios = [
    {
      operation: "status",
      setup: {},
      input: null,
      expectedCall: null,
      expected: cases.goldenExchanges[0].responseFrame,
    },
    {
      operation: "bootstrap_host",
      setup: {},
      input: null,
      expectedCall: ["credential.bootstrap", { requestId: IDS.bootstrap }],
      expected: cases.goldenExchanges[1].responseFrame,
    },
    {
      operation: "refresh_host",
      setup: { credential: readyCredential("host-credential-ref-1") },
      input: null,
      expectedCall: ["credential.refresh", { requestId: IDS.refresh }],
      expected: cases.goldenExchanges[2].responseFrame,
    },
    {
      operation: "start_connector",
      setup: { credential: readyCredential() },
      input: null,
      expectedCall: ["connector.start", { requestId: IDS.start }],
      expected: cases.goldenExchanges[3].responseFrame,
    },
    {
      operation: "stop_connector",
      setup: {
        credential: readyCredential(),
        connector: registeredConnector(),
      },
      input: null,
      expectedCall: ["connector.stop", { requestId: IDS.stop }],
      expected: cases.goldenExchanges[4].responseFrame,
    },
    {
      operation: "create_enrollment",
      setup: {
        credential: readyCredential(),
        connector: registeredConnector(),
      },
      input: { deviceLabel: "Pixel" },
      expectedCall: ["createEnrollment", {
        requestId: IDS.create,
        hostId: "mac-admin",
        connectorId: "connector-1",
        deviceLabel: "Pixel",
      }],
      expected: cases.goldenExchanges[5].responseFrame,
    },
    {
      operation: "revoke_client_grant",
      setup: {
        credential: readyCredential(),
        connector: registeredConnector(),
      },
      input: { grantId: "client-grant-1", reason: "user_revoked" },
      expectedCall: ["revokeGrant", {
        requestId: IDS.revoke,
        hostId: "mac-admin",
        connectorId: "connector-1",
        grantId: "client-grant-1",
        reason: "user_revoked",
      }],
      expected: cases.goldenExchanges[6].responseFrame,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.operation, async () => {
      const h = harness(scenario.setup);
      const decodedRequest = request(scenario.operation, scenario.input);
      const response = await h.authority.handle(decodedRequest);
      assert.deepEqual(response, JSON.parse(scenario.expected));
      const mutationCalls = h.calls.filter(([name]) => !name.includes(".inspect"));
      assert.deepEqual(mutationCalls, scenario.expectedCall ? [scenario.expectedCall] : []);
      const serialized = JSON.stringify(response);
      assert.equal(serialized.includes("accessToken"), false);
      assert.equal(serialized.includes("refreshToken"), false);
      assert.equal(serialized.includes("sharedSecret"), false);
    });
  }
});

test("enrollment control is gated by the exact registered six-capability credential host cut", async (t) => {
  const nonReady = [
    {
      name: "credential missing",
      options: { connector: registeredConnector() },
    },
    {
      name: "connector stopped",
      options: { credential: readyCredential() },
    },
    {
      name: "missing capability",
      options: {
        credential: readyCredential(),
        connector: registeredConnector(REQUIRED.slice(0, 5)),
      },
    },
    {
      name: "credential host mismatch",
      options: {
        credential: readyCredential("host-credential-ref-2", "other-host"),
        connector: registeredConnector(),
      },
    },
  ];
  for (const scenario of nonReady) {
    await t.test(scenario.name, async () => {
      const h = harness(scenario.options);
      if (scenario.name === "missing capability") {
        const status = await h.authority.handle(request("status"));
        assert.equal(status.result.connector.status, "registered_incomplete");
        assert.deepEqual(
          status.result.connector.negotiatedCapabilityIntersection,
          REQUIRED.slice(0, 5),
        );
      }
      const response = await h.authority.handle(request(
        "create_enrollment",
        { deviceLabel: null },
      ));
      assert.deepEqual(response.error, {
        code: "NOT_READY",
        message: "Relay v2 management is not ready",
        retryable: false,
      });
      assert.equal(h.calls.some(([name]) => name === "createEnrollment"), false);
    });
  }
});

test("expiry and gate loss synchronously clear the only retained enrollment code", async () => {
  const h = harness({
    credential: readyCredential(),
    connector: registeredConnector(),
  });
  const created = await h.authority.handle(request(
    "create_enrollment",
    { deviceLabel: "Pixel" },
  ));
  assert.equal(created.result.enrollment.status, "active");
  assert.equal(JSON.stringify(created).includes("twenroll2.one-time-code"), true);

  h.setNow(1_783_700_300_000);
  const expired = await h.authority.handle(request("status"));
  assert.deepEqual(expired.result.enrollment, {
    status: "expired",
    enrollmentId: "enrollment-1",
    expiredAtMs: 1_783_700_300_000,
  });
  assert.equal(JSON.stringify(expired).includes("twenroll2."), false);
  const afterExpiry = await h.authority.handle(request("status"));
  assert.deepEqual(afterExpiry.result.enrollment, { status: "idle" });

  h.setNow(1_783_700_000_000);
  await h.authority.handle(request("create_enrollment", { deviceLabel: null }));
  h.setConnector({ status: "stopped" });
  const lost = await h.authority.handle(request("status"));
  assert.deepEqual(lost.result.enrollment, { status: "idle" });
  assert.equal(JSON.stringify(lost).includes("twenroll2."), false);
});

test("typed failures use only the fixed D2 error table; unknown output closes silently", async (t) => {
  const expected = {
    UNAVAILABLE: ["Relay v2 management is unavailable", false],
    INVALID_ARGUMENT: ["Relay v2 management input is invalid", false],
    NOT_READY: ["Relay v2 management is not ready", false],
    BUSY: ["Relay v2 management is busy", true],
    OPERATION_FAILED: ["Relay v2 management operation failed", false],
  };
  for (const [code, [message, retryable]] of Object.entries(expected)) {
    await t.test(code, async () => {
      const h = harness({
        operationFailure: new RelayV2DashboardManagementAuthorityFailure(code),
      });
      const response = await h.authority.handle(request("bootstrap_host"));
      assert.deepEqual(response.error, { code, message, retryable });
    });
  }

  const marker = "twref2.secret-that-must-not-reflect";
  const unknown = harness({ operationFailure: new Error(marker) });
  await assert.rejects(
    unknown.authority.handle(request("bootstrap_host")),
    (error) => error instanceof RelayV2DashboardManagementAuthorityClosedError
      && !error.message.includes(marker),
  );
  await assert.rejects(
    unknown.authority.handle(request("status")),
    RelayV2DashboardManagementAuthorityClosedError,
  );

  const contradictory = harness({
    credential: readyCredential(),
    connector: {
      ...registeredConnector(),
      acknowledgement: "host.connected",
    },
  });
  await assert.rejects(
    contradictory.authority.handle(request("status")),
    RelayV2DashboardManagementAuthorityClosedError,
  );

  const credentialLeak = harness({
    credential: { ...readyCredential(), accessToken: "twcap2.must-not-reflect" },
  });
  await assert.rejects(
    credentialLeak.authority.handle(request("status")),
    (error) => error instanceof RelayV2DashboardManagementAuthorityClosedError
      && !error.message.includes("twcap2.must-not-reflect"),
  );
});

test("authority serializes concurrent requests through each atomic connector cut", async () => {
  let releaseBootstrap;
  const events = [];
  let credential = { status: "missing" };
  const bootstrapBarrier = new Promise((resolve) => { releaseBootstrap = resolve; });
  const authority = new RelayV2DashboardManagementAuthority({
    credential: {
      inspect() { events.push("credential.inspect"); return credential; },
      async bootstrap(input) {
        events.push(`bootstrap:${input.requestId}`);
        await bootstrapBarrier;
        credential = readyCredential("host-credential-ref-1");
        events.push("bootstrap.done");
      },
      refresh() {},
    },
    connector: {
      inspectCut() { events.push("connector.inspectCut"); return { status: "stopped" }; },
      start() {},
      stop() {},
    },
    carrierControl: {
      createEnrollment() { assert.fail("not called"); },
      revokeGrant() { assert.fail("not called"); },
    },
    clock: () => 1_783_700_000_000,
  });
  const first = authority.handle(request("bootstrap_host"));
  const second = authority.handle(request("status"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [`bootstrap:${IDS.bootstrap}`]);
  releaseBootstrap();
  const [bootstrap, status] = await Promise.all([first, second]);
  assert.equal(bootstrap.result.hostCredential.status, "ready");
  assert.equal(status.result.hostCredential.status, "ready");
  assert.deepEqual(events, [
    `bootstrap:${IDS.bootstrap}`,
    "bootstrap.done",
    "credential.inspect",
    "connector.inspectCut",
    "credential.inspect",
    "connector.inspectCut",
  ]);
});
