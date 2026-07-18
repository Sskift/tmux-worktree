import assert from "node:assert/strict";
import test from "node:test";

const adapterModule = await import("../dist/relay/v2/terminalControlAuthorityAdapter.js");
const terminalControl = await import("../dist/terminalControl/index.js");

const TARGET = {
  hostId: "mac-admin",
  scopeId: "scope-local",
  sessionId: "ses_01JOPAQUE",
  pane: 0,
  canonicalTargetId: "canonical-target-opaque",
  controlTargetId: "control-target-opaque",
};
const AUTH = {
  principalId: "principal-opaque-id",
  clientInstanceId: "android-install-uuid",
};
const OWNER = {
  kind: "relay-v2",
  instanceId: "relay-v2:host-process:stream:generation",
};
const LEASE = {
  controlTargetId: TARGET.controlTargetId,
  controlEpoch: "control-epoch-opaque",
  leaseId: "lease-opaque",
  fence: "7",
  owner: OWNER,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function clone(value) {
  return structuredClone(value);
}

function heldView(lease = LEASE, overrides = {}) {
  return {
    controlTargetId: lease.controlTargetId,
    controlEpoch: lease.controlEpoch,
    state: "HELD",
    fence: lease.fence,
    ownerKind: "relay-v2",
    leaseExpiresAt: lease.expiresAt,
    outputGeneration: "output-generation-opaque",
    outputCursor: 0,
    revision: "11",
    ...overrides,
  };
}

function freeView(lease = LEASE, overrides = {}) {
  return {
    controlTargetId: lease.controlTargetId,
    controlEpoch: lease.controlEpoch,
    state: "FREE",
    fence: (BigInt(lease.fence) + 1n).toString(10),
    outputGeneration: "output-generation-after-release",
    outputCursor: 0,
    revision: "12",
    ...overrides,
  };
}

function leaseEnvelope(lease = LEASE, overrides = {}) {
  const exactLease = { ...clone(lease), ...clone(overrides) };
  return { lease: exactLease, ownership: heldView(exactLease) };
}

function operationResult(operationId, lease = LEASE, overrides = {}) {
  return {
    operationId,
    accepted: true,
    deduplicated: false,
    controlEpoch: lease.controlEpoch,
    fence: lease.fence,
    outputGeneration: "output-generation-opaque",
    outputCursor: 4,
    ...overrides,
  };
}

function authorityInput(lease = LEASE, overrides = {}) {
  return {
    target: clone(TARGET),
    auth: clone(AUTH),
    owner: clone(OWNER),
    lease: clone(lease),
    ...overrides,
  };
}

class ScriptedPort {
  constructor(steps = []) {
    this.steps = [...steps];
    this.calls = [];
  }

  async request(input) {
    this.calls.push(clone(input));
    const step = this.steps.shift();
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(input);
    return clone(step);
  }
}

function adapter(port) {
  return new adapterModule.RelayV2TerminalControlAuthorityAdapter(port);
}

test("injected adapter stays dormant and translates every H3 action to one exact protocol request", async () => {
  const renewedLease = { ...clone(LEASE), expiresAt: "2099-02-01T00:00:00.000Z" };
  const rawBytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
  const inputOperationId = "relay-v2:host:stream:generation:input:1";
  const resizeOperationId = "relay-v2:host:stream:generation:resize:1";
  const port = new ScriptedPort([
    leaseEnvelope(),
    heldView(),
    leaseEnvelope(renewedLease),
    operationResult(inputOperationId, renewedLease),
    operationResult(resizeOperationId, renewedLease),
    freeView(renewedLease),
  ]);
  const authority = adapter(port);
  assert.equal(port.calls.length, 0, "module load and construction must not contact or start an authority");

  const acquired = await authority.acquire({
    target: clone(TARGET),
    auth: clone(AUTH),
    owner: clone(OWNER),
  });
  assert.equal(acquired.status, "accepted");
  assert.deepEqual(acquired.lease, LEASE);

  assert.equal(await authority.hasContinuity(authorityInput()), true);
  const renewed = await authority.renew(authorityInput());
  assert.equal(renewed.status, "accepted");
  assert.deepEqual(renewed.lease, renewedLease);

  assert.deepEqual(await authority.writeInput(authorityInput(renewedLease, {
    operationId: inputOperationId,
    data: rawBytes,
  })), { accepted: true });
  assert.deepEqual(await authority.resize(authorityInput(renewedLease, {
    operationId: resizeOperationId,
    cols: 120,
    rows: 36,
  })), { accepted: true });
  await authority.release(authorityInput(renewedLease));

  assert.deepEqual(port.calls, [
    {
      type: "lease.acquire",
      controlTargetId: TARGET.controlTargetId,
      owner: OWNER,
    },
    {
      type: "ownership.status",
      controlTargetId: TARGET.controlTargetId,
    },
    {
      type: "lease.renew",
      lease: LEASE,
    },
    {
      type: "input.raw",
      lease: renewedLease,
      operationId: inputOperationId,
      pane: "0",
      dataBase64: rawBytes.toString("base64"),
    },
    {
      type: "input.resize",
      lease: renewedLease,
      operationId: resizeOperationId,
      pane: "0",
      cols: 120,
      rows: 36,
    },
    {
      type: "lease.release",
      lease: renewedLease,
    },
  ]);
  assert.deepEqual(Buffer.from(port.calls[3].dataBase64, "base64"), rawBytes);
  assert.equal(Buffer.from(port.calls[3].dataBase64, "base64").toString("base64"), port.calls[3].dataBase64);
  for (const call of port.calls) {
    assert.equal(Object.hasOwn(call, "autoStart"), false);
    assert.equal(Object.hasOwn(call, "protocolVersion"), false);
    assert.equal(Object.hasOwn(call, "requestId"), false);
  }
});

test("target, owner, lease, pane, operation and correlated success mismatches fail closed", async () => {
  const noDispatch = new ScriptedPort();
  const closed = adapter(noDispatch);
  const wrongOwner = { ...clone(OWNER), instanceId: "relay-v2:other-owner" };
  const ownerMismatch = await closed.writeInput(authorityInput(LEASE, {
    owner: wrongOwner,
    operationId: "owner-mismatch-input",
    data: Buffer.from([1]),
  }));
  assert.equal(ownerMismatch.accepted, false);
  assert.equal(ownerMismatch.uncertain, false);
  assert.equal(ownerMismatch.error.code, "PERMISSION_DENIED");

  const targetMismatch = await closed.renew(authorityInput(LEASE, {
    target: { ...clone(TARGET), controlTargetId: "different-control-target" },
  }));
  assert.equal(targetMismatch.status, "rejected");
  assert.equal(targetMismatch.error.code, "PERMISSION_DENIED");

  const invalidPane = await closed.resize(authorityInput(LEASE, {
    target: { ...clone(TARGET), pane: 65_536 },
    operationId: "invalid-pane-resize",
    cols: 120,
    rows: 36,
  }));
  assert.equal(invalidPane.accepted, false);
  assert.equal(invalidPane.uncertain, false);
  assert.equal(noDispatch.calls.length, 0, "invalid local identities must be rejected before dispatch");

  const mismatchedAcquire = new ScriptedPort([
    leaseEnvelope({ ...clone(LEASE), controlTargetId: "wrong-control-target" }),
  ]);
  const acquireResult = await adapter(mismatchedAcquire).acquire({
    target: clone(TARGET),
    auth: clone(AUTH),
    owner: clone(OWNER),
  });
  assert.equal(acquireResult.status, "uncertain", "an invalid success cannot prove acquire was not applied");

  const mismatchedOperation = new ScriptedPort([
    operationResult("different-operation-id"),
  ]);
  const inputResult = await adapter(mismatchedOperation).writeInput(authorityInput(LEASE, {
    operationId: "expected-operation-id",
    data: Buffer.from([2]),
  }));
  assert.equal(inputResult.accepted, false);
  assert.equal(inputResult.uncertain, true, "a mismatched success cannot prove raw bytes were not written");
  assert.equal(mismatchedOperation.calls.length, 1, "the adapter never retries an operation");

  const rotatedRenewal = new ScriptedPort([
    leaseEnvelope({ ...clone(LEASE), leaseId: "rotated-lease" }),
  ]);
  const renewal = await adapter(rotatedRenewal).renew(authorityInput());
  assert.equal(renewal.status, "uncertain", "a rotated success cannot prove the old renewal disposition");
});

test("definite rejections stay definite while timeout, transport and in-doubt failures stay uncertain", async () => {
  const terminalBytes = "TERMINAL_BYTES_MUST_NOT_ESCAPE";
  const definitePort = new ScriptedPort([
    new terminalControl.TerminalControlProtocolError(
      "PERMISSION_DENIED",
      `rejected ${terminalBytes}`,
    ),
  ]);
  const definite = await adapter(definitePort).writeInput(authorityInput(LEASE, {
    operationId: "definite-input",
    data: Buffer.from(terminalBytes),
  }));
  assert.equal(definite.accepted, false);
  assert.equal(definite.uncertain, false);
  assert.equal(definite.error.code, "PERMISSION_DENIED");
  assert.doesNotMatch(definite.error.message, new RegExp(terminalBytes));
  assert.equal(definitePort.calls.length, 1);

  const timeoutPort = new ScriptedPort([new Error(`request timed out after ${terminalBytes}`)]);
  const timeout = await adapter(timeoutPort).writeInput(authorityInput(LEASE, {
    operationId: "timeout-input",
    data: Buffer.from(terminalBytes),
  }));
  assert.equal(timeout.accepted, false);
  assert.equal(timeout.uncertain, true);
  assert.equal(timeout.error.code, "COMMAND_IN_DOUBT");
  assert.doesNotMatch(timeout.error.message, new RegExp(terminalBytes));
  assert.equal(timeoutPort.calls.length, 1, "timeout must not trigger an automatic resend");

  const inDoubtPort = new ScriptedPort([
    new terminalControl.TerminalControlProtocolError(
      "OPERATION_IN_DOUBT",
      `backend uncertain ${terminalBytes}`,
    ),
  ]);
  const inDoubt = await adapter(inDoubtPort).resize(authorityInput(LEASE, {
    operationId: "in-doubt-resize",
    cols: 100,
    rows: 30,
  }));
  assert.equal(inDoubt.accepted, false);
  assert.equal(inDoubt.uncertain, true);
  assert.equal(inDoubt.error.code, "COMMAND_IN_DOUBT");
  assert.doesNotMatch(inDoubt.error.message, new RegExp(terminalBytes));
  assert.equal(inDoubtPort.calls.length, 1, "in-doubt resize must never be resent");

  const capacityPort = new ScriptedPort([
    new terminalControl.TerminalControlProtocolError("RESOURCE_EXHAUSTED", "full"),
  ]);
  const capacity = await adapter(capacityPort).acquire({
    target: clone(TARGET),
    auth: clone(AUTH),
    owner: clone(OWNER),
  });
  assert.equal(capacity.status, "rejected");
  assert.equal(capacity.error.code, "BUSY");
  assert.equal(capacity.error.retryable, true);
});

test("continuity and release propagate failures and only a valid status mismatch returns false", async () => {
  const definiteContinuityPort = new ScriptedPort([
    new terminalControl.TerminalControlProtocolError("PERMISSION_DENIED", "stale lease"),
  ]);
  await assert.rejects(
    adapter(definiteContinuityPort).hasContinuity(authorityInput()),
    (error) => error?.name === "TerminalControlProtocolError"
      && error.code === "PERMISSION_DENIED",
  );
  assert.equal(definiteContinuityPort.calls.length, 1);

  const uncertainContinuityPort = new ScriptedPort([new Error("injected UDS timeout")]);
  await assert.rejects(
    adapter(uncertainContinuityPort).hasContinuity(authorityInput()),
    (error) => error?.name === "TerminalControlProtocolError"
      && error.code === "OPERATION_IN_DOUBT",
  );
  assert.equal(uncertainContinuityPort.calls.length, 1);

  const lostContinuityPort = new ScriptedPort([freeView()]);
  assert.equal(await adapter(lostContinuityPort).hasContinuity(authorityInput()), false);
  assert.equal(lostContinuityPort.calls.length, 1);

  const uncertainReleasePort = new ScriptedPort([new Error("release response was lost")]);
  await assert.rejects(
    adapter(uncertainReleasePort).release(authorityInput()),
    (error) => error?.name === "TerminalControlProtocolError"
      && error.code === "OPERATION_IN_DOUBT",
  );
  assert.equal(uncertainReleasePort.calls.length, 1, "release response loss must not be hidden or retried");

  const malformedReleasePort = new ScriptedPort([
    freeView(LEASE, { controlTargetId: "different-control-target" }),
  ]);
  await assert.rejects(
    adapter(malformedReleasePort).release(authorityInput()),
    (error) => error?.name === "TerminalControlProtocolError"
      && error.code === "OPERATION_IN_DOUBT",
  );
  assert.equal(malformedReleasePort.calls.length, 1);
});
