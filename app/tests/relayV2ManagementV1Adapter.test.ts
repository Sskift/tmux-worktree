import assert from "node:assert/strict";
import test from "node:test";
import { createRelayV2ManagementV1Adapter } from "../src/platform/relayV2ManagementV1Adapter.ts";
import { MobileRelayV2BackendOperationError } from "../src/platform/relayV2Domain.ts";

const requestId = "dmgmt1.AquZUdkZ9FXG7OEIfRHmjw";

function statusOutcome() {
  return {
    protocolVersion: 1,
    requestId,
    ok: true,
    result: {
      availability: "unavailable",
      capabilities: [],
      reason: "default_off",
    },
    error: null,
  };
}

function errorOutcome(code: "UNAVAILABLE" | "CHANNEL_CLOSED" | "SUPERSEDED") {
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
    protocolVersion: 1,
    requestId,
    ok: false,
    result: null,
    error: errors[code],
  };
}

test("management v1 status maps only the permanent default-off projection", async () => {
  const calls: Array<{ command: string; args?: unknown }> = [];
  const adapter = createRelayV2ManagementV1Adapter(async (command, args) => {
    calls.push({ command, args });
    return statusOutcome();
  });

  const state = await adapter.status();

  assert.deepEqual(calls, [{
    command: "mobile_relay_v2_management_call",
    args: { operation: "status" },
  }]);
  assert.deepEqual(state, {
    authority: {
      kind: "unavailable",
      reason: "Relay v2 management is unavailable (default off).",
    },
    v1Profile: {
      protocolVersion: 1,
      credentialKind: "legacy_shared_secret",
      sharedSecretConfigured: false,
    },
    hostCredential: {
      protocolVersion: 2,
      credentialKind: "twcap2_grant",
      status: "missing",
      credentialReference: null,
      expiresAtMs: null,
      error: null,
      retryable: null,
    },
    connector: {
      status: "stopped",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    },
    enrollment: { status: "idle" },
    knownClientGrant: { status: "unknown" },
  });
  assert.equal(JSON.stringify(state).includes(requestId), false);
});

test("management v1 mutations send no arguments or caller credential references", async () => {
  const calls: Array<{ command: string; args?: unknown }> = [];
  const adapter = createRelayV2ManagementV1Adapter(async (command, args) => {
    calls.push({ command, args });
    return errorOutcome("UNAVAILABLE");
  });

  const attempts = [
    adapter.bootstrapHost(),
    adapter.refreshHost(),
    adapter.startConnector(),
    adapter.stopConnector(),
    adapter.createEnrollment({ intent: "retry", deviceLabel: "private-device-label" }),
    adapter.revokeClientGrant({ grantId: "private-grant-id", reason: "user_revoked" }),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, (error: unknown) => (
      error instanceof MobileRelayV2BackendOperationError
      && error.code === "UNAVAILABLE"
      && error.retryable === false
    ));
  }

  assert.deepEqual(calls, [
    "bootstrap_host",
    "refresh_host",
    "start_connector",
    "stop_connector",
    "create_enrollment",
    "revoke_client_grant",
  ].map((operation) => ({
    command: "mobile_relay_v2_management_call",
    args: { operation },
  })));
  assert.equal(JSON.stringify(calls).includes("private-device-label"), false);
  assert.equal(JSON.stringify(calls).includes("private-grant-id"), false);
});

test("management v1 strictly rejects malformed outcomes without retry", async () => {
  const malformed = [
    { ...statusOutcome(), requestId: "caller-request-id" },
    { ...statusOutcome(), extra: null },
    {
      ...statusOutcome(),
      result: { availability: "unavailable", capabilities: ["relay-v2"], reason: "default_off" },
    },
    errorOutcome("UNAVAILABLE"),
  ];

  for (const value of malformed) {
    let calls = 0;
    const adapter = createRelayV2ManagementV1Adapter(async () => {
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

test("management v1 maps only exact native supervisor failures", async () => {
  for (const code of ["UNAVAILABLE", "CHANNEL_CLOSED", "SUPERSEDED"] as const) {
    const nativeError = errorOutcome(code).error;
    const adapter = createRelayV2ManagementV1Adapter(async () => {
      throw nativeError;
    });
    await assert.rejects(adapter.status(), (error: unknown) => (
      error instanceof MobileRelayV2BackendOperationError
      && error.code === code
      && error.retryable === false
    ));
  }

  const adapter = createRelayV2ManagementV1Adapter(async () => {
    throw { code: "UNAVAILABLE", message: "secret-reflected-message", retryable: false };
  });
  await assert.rejects(adapter.status(), (error: unknown) => (
    error instanceof MobileRelayV2BackendOperationError
    && error.code === "CHANNEL_CLOSED"
    && !error.message.includes("secret-reflected-message")
  ));
});

test("status abort rejects its caller but preserves the native completion barrier", async () => {
  let completeFirst!: (value: unknown) => void;
  const firstCompletion = new Promise<unknown>((resolve) => {
    completeFirst = resolve;
  });
  const calls: string[] = [];
  const adapter = createRelayV2ManagementV1Adapter(async (_command, args) => {
    const operation = (args as { operation: string }).operation;
    calls.push(operation);
    if (operation === "status") return firstCompletion;
    return errorOutcome("UNAVAILABLE");
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

  completeFirst(statusOutcome());
  await assert.rejects(next, (error: unknown) => (
    error instanceof MobileRelayV2BackendOperationError
    && error.code === "UNAVAILABLE"
  ));
  assert.deepEqual(calls, ["status", "stop_connector"]);
});
