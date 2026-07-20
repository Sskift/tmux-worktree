import assert from "node:assert/strict";
import test from "node:test";
import { deriveRelayV2EnrollmentView } from "../src/dashboard/Settings/relayV2EnrollmentModel.ts";
import { MOBILE_RELAY_V2_REQUIRED_CAPABILITIES } from "../src/platform/domainTypes.ts";
import { MobileRelayV2BackendOperationError } from "../src/platform/relayV2Domain.ts";
import { createRelayV2ManagementAdapter } from "../src/platform/relayV2ManagementAdapter.ts";

const requestIdV1 = "dmgmt1.AquZUdkZ9FXG7OEIfRHmjw";
const requestIdV2 = "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw";
const futureMs = 4_000_000_000_000;

type Operation =
  | "status"
  | "bootstrap_host"
  | "refresh_host"
  | "start_connector"
  | "stop_connector"
  | "create_enrollment"
  | "revoke_client_grant";

function defaultProjection() {
  return {
    authority: { kind: "node", reason: null },
    hostCredential: { status: "missing" },
    connector: { status: "stopped" },
    enrollment: { status: "idle" },
    knownClientGrant: { status: "unknown" },
  };
}

function readyCredential() {
  return {
    status: "ready",
    credentialReference: "host-credential-ref-1",
    expiresAtMs: futureMs,
  };
}

function registeredConnector(capabilities = [...MOBILE_RELAY_V2_REQUIRED_CAPABILITIES]) {
  return {
    status: capabilities.length === MOBILE_RELAY_V2_REQUIRED_CAPABILITIES.length
      ? "registered"
      : "registered_incomplete",
    acknowledgement: "host.registered",
    hostId: "mac-admin",
    connectorId: "connector-1",
    negotiatedCapabilityIntersection: capabilities,
  };
}

function activeEnrollment() {
  return {
    status: "active",
    review: {
      enrollment: {
        enrollmentId: "enrollment-1",
        enrollmentCode: "twenroll2.one-time-code",
        expiresAtMs: futureMs,
      },
      display: {
        issuerUrl: "https://relay.example.com",
        relayUrl: "wss://relay.example.com/client",
        hostId: "mac-admin",
        deviceLabel: "Pixel",
      },
    },
  };
}

function projectionFor(operation: Operation) {
  const base = defaultProjection();
  switch (operation) {
    case "status":
      return base;
    case "bootstrap_host":
    case "refresh_host":
      return { ...base, hostCredential: readyCredential() };
    case "start_connector":
      return {
        ...base,
        hostCredential: readyCredential(),
        connector: registeredConnector(),
      };
    case "stop_connector":
      return { ...base, hostCredential: readyCredential() };
    case "create_enrollment":
      return {
        ...base,
        hostCredential: readyCredential(),
        connector: registeredConnector(),
        enrollment: activeEnrollment(),
      };
    case "revoke_client_grant":
      return {
        ...base,
        hostCredential: readyCredential(),
        connector: registeredConnector(),
        knownClientGrant: {
          status: "revoked",
          grantId: "client-grant-1",
          revokedAtMs: 1_783_700_200_000,
          alreadyRevoked: false,
        },
      };
  }
}

function successOutcome(operation: Operation, result = projectionFor(operation)) {
  return {
    protocolVersion: 2,
    requestId: requestIdV2,
    ok: true,
    result,
    error: null,
  };
}

function v1StatusOutcome() {
  return {
    protocolVersion: 1,
    requestId: requestIdV1,
    ok: true,
    result: {
      availability: "unavailable",
      capabilities: [],
      reason: "default_off",
    },
    error: null,
  };
}

function errorOutcome(
  protocolVersion: 1 | 2,
  code: "UNAVAILABLE" | "CHANNEL_CLOSED" | "SUPERSEDED",
) {
  const errors = {
    UNAVAILABLE: {
      code: "UNAVAILABLE",
      message: "Relay v2 management is unavailable",
      retryable: false,
    },
    CHANNEL_CLOSED: {
      code: "CHANNEL_CLOSED",
      message: "Relay v2 management channel closed",
      retryable: false,
    },
    SUPERSEDED: {
      code: "SUPERSEDED",
      message: "Relay v2 management owner was superseded",
      retryable: false,
    },
  } as const;
  return {
    protocolVersion,
    requestId: protocolVersion === 1 ? requestIdV1 : requestIdV2,
    ok: false,
    result: null,
    error: errors[code],
  };
}

test("management adapter preserves the permanent v1 default-off child behavior", async () => {
  const calls: Array<{ command: string; args?: unknown }> = [];
  const adapter = createRelayV2ManagementAdapter(async (command, args) => {
    calls.push({ command, args });
    const operation = (args as { operation: Operation }).operation;
    return operation === "status" ? v1StatusOutcome() : errorOutcome(1, "UNAVAILABLE");
  });

  const state = await adapter.status();
  assert.equal(state.authority.kind, "unavailable");
  assert.deepEqual(state.connector.negotiatedCapabilityIntersection, []);
  await assert.rejects(adapter.createEnrollment({ intent: "retry", deviceLabel: "Pixel" }),
    (error: unknown) => error instanceof MobileRelayV2BackendOperationError
      && error.code === "UNAVAILABLE");
  assert.deepEqual(calls, [
    {
      command: "mobile_relay_v2_management_call",
      args: { operation: "status", input: null },
    },
    {
      command: "mobile_relay_v2_management_call",
      args: { operation: "create_enrollment", input: { deviceLabel: "Pixel" } },
    },
  ]);
  assert.equal(JSON.stringify(state).includes(requestIdV1), false);
});

test("management v2 maps all seven successful projections and only approved inputs", async () => {
  const calls: Array<{ command: string; args?: unknown }> = [];
  const adapter = createRelayV2ManagementAdapter(async (command, args) => {
    calls.push({ command, args });
    return successOutcome((args as { operation: Operation }).operation);
  });

  const states = await Promise.all([
    adapter.status(),
    adapter.bootstrapHost(),
    adapter.refreshHost(),
    adapter.startConnector(),
    adapter.stopConnector(),
    adapter.createEnrollment({ intent: "rebuild", deviceLabel: "Pixel" }),
    adapter.revokeClientGrant({ grantId: "client-grant-1", reason: "user_revoked" }),
  ]);

  assert.deepEqual(calls.map((call) => call.args), [
    { operation: "status", input: null },
    { operation: "bootstrap_host", input: null },
    { operation: "refresh_host", input: null },
    { operation: "start_connector", input: null },
    { operation: "stop_connector", input: null },
    { operation: "create_enrollment", input: { deviceLabel: "Pixel" } },
    {
      operation: "revoke_client_grant",
      input: { grantId: "client-grant-1", reason: "user_revoked" },
    },
  ]);
  assert.equal(JSON.stringify(calls).includes("rebuild"), false);
  assert.equal(states[3].connector.status, "registered");
  assert.equal(states[5].enrollment.status, "active");
  assert.deepEqual(states[6].knownClientGrant, {
    status: "revoked",
    grantId: "client-grant-1",
    revokedAtMs: 1_783_700_200_000,
    alreadyRevoked: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(states[6], "devices"), false);
});

test("incomplete registration or any missing required capability cannot expose enrollment QR", async () => {
  for (const missing of MOBILE_RELAY_V2_REQUIRED_CAPABILITIES) {
    const capabilities = MOBILE_RELAY_V2_REQUIRED_CAPABILITIES.filter(
      (capability) => capability !== missing,
    );
    const result = {
      ...defaultProjection(),
      hostCredential: readyCredential(),
      connector: registeredConnector(capabilities),
    };
    const adapter = createRelayV2ManagementAdapter(async () => successOutcome("status", result));
    const state = await adapter.status();
    const view = deriveRelayV2EnrollmentView(state, 1_000);
    assert.equal(state.connector.status, "registered_incomplete", missing);
    assert.equal(view.ready, false, missing);
    assert.equal(view.qrPayload, null, missing);
  }

  const adapter = createRelayV2ManagementAdapter(async () => successOutcome(
    "create_enrollment",
    projectionFor("create_enrollment"),
  ));
  const state = await adapter.createEnrollment({ intent: "create", deviceLabel: "Pixel" });
  const view = deriveRelayV2EnrollmentView(state, 1_000);
  assert.equal(view.ready, true);
  assert.match(view.qrPayload ?? "", /enrollmentCode=twenroll2.one-time-code/);
});

test("closed v2 outcomes reject malformed, unknown, credential, and contradictory state", async () => {
  const malformed = [
    { ...successOutcome("status"), extra: null },
    {
      ...successOutcome("status"),
      result: { ...defaultProjection(), accessToken: "twcap2.forbidden" },
    },
    {
      ...successOutcome("status"),
      result: {
        ...defaultProjection(),
        hostCredential: { status: "missing", refreshToken: "twref2.forbidden" },
      },
    },
    {
      ...successOutcome("status"),
      result: {
        ...defaultProjection(),
        hostCredential: readyCredential(),
        connector: { ...registeredConnector(), status: "registered_incomplete" },
      },
    },
    {
      ...successOutcome("status"),
      result: {
        ...defaultProjection(),
        hostCredential: readyCredential(),
        connector: { ...registeredConnector(), hostId: "twref2.forbidden" },
      },
    },
    {
      ...successOutcome("create_enrollment"),
      result: {
        ...projectionFor("create_enrollment"),
        enrollment: {
          ...activeEnrollment(),
          review: {
            ...activeEnrollment().review,
            display: {
              ...activeEnrollment().review.display,
              issuerUrl: "https://relay.example.com?accessToken=forbidden",
            },
          },
        },
      },
    },
    {
      ...successOutcome("create_enrollment"),
      result: {
        ...projectionFor("create_enrollment"),
        enrollment: {
          ...activeEnrollment(),
          review: {
            ...activeEnrollment().review,
            display: { ...activeEnrollment().review.display, issuerUrl: "https://:" },
          },
        },
      },
    },
    {
      ...successOutcome("create_enrollment"),
      result: {
        ...projectionFor("create_enrollment"),
        enrollment: {
          ...activeEnrollment(),
          review: {
            ...activeEnrollment().review,
            display: { ...activeEnrollment().review.display, relayUrl: "wss://:/client" },
          },
        },
      },
    },
    {
      ...successOutcome("create_enrollment"),
      result: {
        ...projectionFor("create_enrollment"),
        enrollment: {
          ...activeEnrollment(),
          review: {
            ...activeEnrollment().review,
            display: {
              ...activeEnrollment().review.display,
              relayUrl: "wss://relay.example.com:65536/client",
            },
          },
        },
      },
    },
    {
      ...successOutcome("create_enrollment"),
      result: {
        ...projectionFor("create_enrollment"),
        enrollment: {
          ...activeEnrollment(),
          review: {
            ...activeEnrollment().review,
            display: {
              ...activeEnrollment().review.display,
              issuerUrl: "HTTPS://relay.example.com",
            },
          },
        },
      },
    },
    {
      ...successOutcome("create_enrollment"),
      result: {
        ...projectionFor("create_enrollment"),
        enrollment: {
          ...activeEnrollment(),
          review: {
            ...activeEnrollment().review,
            display: {
              ...activeEnrollment().review.display,
              relayUrl: "wss:relay.example.com/client",
            },
          },
        },
      },
    },
    { ...successOutcome("status"), requestId: "caller-request-id" },
  ];
  for (const value of malformed) {
    let calls = 0;
    const adapter = createRelayV2ManagementAdapter(async () => {
      calls += 1;
      return value;
    });
    await assert.rejects(adapter.status(), (error: unknown) => (
      error instanceof MobileRelayV2BackendOperationError
      && error.code === "CHANNEL_CLOSED"
      && error.retryable === false
    ));
    assert.equal(calls, 1);
  }
});

test("only exact native supervisor failures cross the adapter", async () => {
  for (const code of ["UNAVAILABLE", "CHANNEL_CLOSED", "SUPERSEDED"] as const) {
    const nativeError = errorOutcome(2, code).error;
    const adapter = createRelayV2ManagementAdapter(async () => {
      throw nativeError;
    });
    await assert.rejects(adapter.status(), (error: unknown) => (
      error instanceof MobileRelayV2BackendOperationError
      && error.code === code
      && error.retryable === false
    ));
  }

  const adapter = createRelayV2ManagementAdapter(async () => {
    throw { code: "CHANNEL_CLOSED", message: "twref2.secret", retryable: false };
  });
  await assert.rejects(adapter.status(), (error: unknown) => (
    error instanceof MobileRelayV2BackendOperationError
    && error.code === "CHANNEL_CLOSED"
    && !error.message.includes("twref2.secret")
  ));
});

test("status abort ends only the caller wait and preserves native serialization", async () => {
  let completeFirst!: (value: unknown) => void;
  const firstCompletion = new Promise<unknown>((resolve) => {
    completeFirst = resolve;
  });
  const calls: Operation[] = [];
  const adapter = createRelayV2ManagementAdapter(async (_command, args) => {
    const operation = (args as { operation: Operation }).operation;
    calls.push(operation);
    if (operation === "status") return firstCompletion;
    return successOutcome(operation);
  });
  const controller = new AbortController();
  const reason = new Error("poll superseded");
  const status = adapter.status(controller.signal);
  await Promise.resolve();
  assert.deepEqual(calls, ["status"]);

  controller.abort(reason);
  await assert.rejects(status, (error: unknown) => error === reason);
  const next = adapter.stopConnector();
  await Promise.resolve();
  assert.deepEqual(calls, ["status"]);

  completeFirst(successOutcome("status"));
  assert.equal((await next).connector.status, "stopped");
  assert.deepEqual(calls, ["status", "stop_connector"]);
});

test("renderer input and returned projection contain no credential or v1 secret material", async () => {
  const calls: unknown[] = [];
  const adapter = createRelayV2ManagementAdapter(async (_command, args) => {
    calls.push(args);
    return successOutcome((args as { operation: Operation }).operation);
  });
  const state = await adapter.createEnrollment({ intent: "retry", deviceLabel: null });
  const serializedCalls = JSON.stringify(calls);
  const serializedState = JSON.stringify(state);
  for (const forbidden of [
    '"accessToken":',
    '"refreshToken":',
    '"bootstrapToken":',
    '"sharedSecret":',
    '"v1SharedSecret":',
    "twcap2.",
    "twref2.",
    "twhostboot2.",
  ]) {
    assert.equal(serializedCalls.includes(forbidden), false, forbidden);
    assert.equal(serializedState.includes(forbidden), false, forbidden);
  }
  assert.equal(serializedState.includes("twenroll2.one-time-code"), true);
});
