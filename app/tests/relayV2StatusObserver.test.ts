import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelayV2EnrollmentState,
  deriveRelayV2EnrollmentView,
  relayV2EnrollmentReducer,
} from "../src/dashboard/Settings/relayV2EnrollmentModel.ts";
import {
  createRelayV2StatusObserver,
  type RelayV2StatusObserverClock,
} from "../src/dashboard/Settings/relayV2StatusObserver.ts";
import {
  MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
  type MobileRelayV2DashboardState,
} from "../src/platform/domainTypes.ts";
import {
  classifyMobileRelayV2OperationFailure,
  normalizeMobileRelayV2DashboardState,
} from "../src/platform/relayV2Domain.ts";
import { createFakeMobileRelayV2State } from "../src/platform/relayV2FakeAdapter.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class FakeClock implements RelayV2StatusObserverClock {
  private nextId = 1;
  private callbacks = new Map<number, { callback: () => void; delayMs: number }>();
  currentTimeMs = 0;

  now(): number {
    return this.currentTimeMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.callbacks.delete(id as number);
  }

  nextDelay(): number | null {
    return [...this.callbacks.values()][0]?.delayMs ?? null;
  }

  runNext(): void {
    const entry = [...this.callbacks.entries()][0];
    assert.ok(entry, "expected a scheduled status observation");
    const [id, timer] = entry;
    this.callbacks.delete(id);
    this.currentTimeMs += timer.delayMs;
    timer.callback();
  }

  count(): number {
    return this.callbacks.size;
  }
}

function registeredState() {
  const state = createFakeMobileRelayV2State(true);
  return {
    ...state,
    hostCredential: {
      ...state.hostCredential,
      status: "ready" as const,
      credentialReference: "fake-preview://host-grant",
      expiresAtMs: 60_000,
      retryable: null,
    },
    connector: {
      status: "registered" as const,
      acknowledgement: "host.registered" as const,
      hostId: "mac-admin",
      connectorId: "connector-1",
      negotiatedCapabilityIntersection: MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
      exitCode: null,
      error: null,
      retryable: null,
    },
  };
}

test("Relay v2 status normalization rebuilds a closed non-sensitive projection", () => {
  const registered = registeredState();
  const observed = {
    ...registered,
    accessToken: "twcap2.root-must-not-escape",
    hostCredential: {
      ...registered.hostCredential,
      refreshToken: "twref2.host-must-not-escape",
      bootstrapSecret: "twhostboot2.host-must-not-escape",
    },
    connector: {
      ...registered.connector,
      accessToken: "twcap2.connector-must-not-escape",
    },
    enrollment: {
      status: "idle",
      enrollmentCode: "twenroll2.idle-must-not-escape",
    },
    knownClientGrant: {
      status: "unknown",
      refreshToken: "twref2.grant-must-not-escape",
    },
  };

  const normalized = normalizeMobileRelayV2DashboardState(observed, 1_000);
  const serialized = JSON.stringify(normalized);

  assert.equal(deriveRelayV2EnrollmentView(normalized, 1_000).ready, true);
  assert.deepEqual(Object.keys(normalized), [
    "authority",
    "v1Profile",
    "hostCredential",
    "connector",
    "enrollment",
    "knownClientGrant",
  ]);
  for (const secret of [
    "twcap2.root-must-not-escape",
    "twref2.host-must-not-escape",
    "twhostboot2.host-must-not-escape",
    "twcap2.connector-must-not-escape",
    "twenroll2.idle-must-not-escape",
    "twref2.grant-must-not-escape",
  ]) assert.equal(serialized.includes(secret), false, secret);
});

test("Relay v2 malformed status clears cached readiness and preserves the v1 configured bit", () => {
  const registered = registeredState();
  const observed = {
    ...registered,
    enrollment: {
      status: "active",
      review: {
        enrollment: {
          enrollmentId: "enrollment-stale",
          enrollmentCode: "twenroll2.must-be-cleared",
          expiresAtMs: 50_000,
        },
        display: {
          issuerUrl: "https://relay.test",
          relayUrl: "wss://relay.test/client",
          hostId: "mac-admin",
          deviceLabel: null,
        },
      },
    },
    knownClientGrant: { status: "unexpected-discriminator" },
  };

  const normalized = normalizeMobileRelayV2DashboardState(observed, 1_000);
  const view = deriveRelayV2EnrollmentView(normalized, 1_000);

  assert.equal(normalized.authority.kind, "unavailable");
  assert.equal(normalized.connector.status, "failed");
  assert.equal(normalized.enrollment.status, "failed");
  assert.equal(normalized.v1Profile.sharedSecretConfigured, true);
  assert.equal(view.ready, false);
  assert.equal(view.qrPayload, null);
  assert.equal(view.enrollmentAction, null);
  assert.match(view.readinessDetail, /restore authoritative Relay v2 state/i);
  assert.doesNotMatch(JSON.stringify(normalized), /twenroll2\.must-be-cleared/);
});

test("Relay v2 credential references remain opaque but reject credential values", () => {
  const registered = registeredState();
  const futureReference = "node-credential-reference:v9:opaque-id";
  const accepted = normalizeMobileRelayV2DashboardState({
    ...registered,
    hostCredential: {
      ...registered.hostCredential,
      credentialReference: futureReference,
    },
  }, 1_000);
  assert.equal(accepted.hostCredential.credentialReference, futureReference);
  assert.equal(deriveRelayV2EnrollmentView(accepted, 1_000).ready, true);

  for (const credentialReference of [
    "twcap2.payload.mac",
    "twref2.refresh-secret",
    "twenroll2.one-time-secret",
    "twhostboot2.bootstrap-secret",
  ]) {
    const rejected = normalizeMobileRelayV2DashboardState({
      ...registered,
      hostCredential: { ...registered.hostCredential, credentialReference },
    }, 1_000);
    assert.equal(rejected.authority.kind, "unavailable", credentialReference);
    assert.equal(rejected.hostCredential.credentialReference, null, credentialReference);
    assert.equal(rejected.v1Profile.sharedSecretConfigured, true, credentialReference);
  }
});

test("Relay v2 polling observes external supersede, credential, and grant changes", async () => {
  const clock = new FakeClock();
  const registered = registeredState();
  const externallyChanged = {
    ...registered,
    hostCredential: {
      ...registered.hostCredential,
      status: "missing" as const,
      credentialReference: null,
      expiresAtMs: null,
    },
    connector: {
      status: "superseded" as const,
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [] as const,
      exitCode: 78 as const,
      error: "External connector superseded this process.",
      retryable: false as const,
    },
    knownClientGrant: {
      status: "revoked" as const,
      grantId: "grant-1",
      revokedAtMs: 500,
      alreadyRevoked: false,
    },
  };
  const observations = [registered, externallyChanged];
  let current = createRelayV2EnrollmentState(true);
  let reads = 0;
  const observer = createRelayV2StatusObserver({
    clock,
    intervalMs: 100,
    read: async () => observations[reads++]!,
    publish: (state) => {
      current = relayV2EnrollmentReducer(current, { type: "backendStateObserved", state });
    },
    onError: (error) => { throw error; },
  });

  observer.start();
  await flushPromises();
  assert.equal(current.connector.status, "registered");
  assert.equal(clock.nextDelay(), 100);

  clock.runNext();
  await flushPromises();
  assert.equal(current.connector.status, "superseded");
  assert.equal(current.hostCredential.status, "missing");
  assert.equal(current.knownClientGrant.status, "revoked");
  observer.stop();
});

test("Relay v2 status refresh never overlaps and fences late results after stop", async () => {
  const clock = new FakeClock();
  const first = deferred<ReturnType<typeof registeredState>>();
  const second = deferred<ReturnType<typeof registeredState>>();
  const signals: AbortSignal[] = [];
  const published: unknown[] = [];
  let reads = 0;
  const observer = createRelayV2StatusObserver({
    clock,
    intervalMs: 100,
    read: (signal) => {
      signals.push(signal);
      reads += 1;
      return reads === 1 ? first.promise : second.promise;
    },
    publish: (state) => published.push(state),
    onError: (error) => { throw error; },
  });

  observer.start();
  await flushPromises();
  observer.refresh();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(reads, 1);

  first.resolve(registeredState());
  await flushPromises();
  assert.equal(reads, 2);
  assert.deepEqual(published, []);

  observer.stop();
  second.resolve(registeredState());
  await flushPromises();
  assert.deepEqual(published, []);
  assert.equal(clock.count(), 0);
});

test("Relay v2 persistent status failure clears cached readiness and late status cannot revive it", async () => {
  const clock = new FakeClock();
  const registered = registeredState();
  const active = {
    ...registered,
    enrollment: {
      status: "active" as const,
      review: {
        enrollment: {
          enrollmentId: "enrollment-stale",
          enrollmentCode: "twenroll2.must-be-cleared",
          expiresAtMs: 50_000,
        },
        display: {
          issuerUrl: "https://relay.test",
          relayUrl: "wss://relay.test/client",
          hostId: "mac-admin",
          deviceLabel: null,
        },
      },
    },
  };
  const lateStatus = deferred<MobileRelayV2DashboardState>();
  const statusFailure = {
    code: "relay_v2_status_temporarily_unavailable",
    message: "Authoritative Relay v2 status is unavailable.",
    retryable: true,
  };
  let current = createRelayV2EnrollmentState(true);
  const observedState = (): MobileRelayV2DashboardState => current;
  let reads = 0;
  const observer = createRelayV2StatusObserver({
    clock,
    intervalMs: 100,
    read: async () => {
      reads += 1;
      if (reads === 1) return active;
      if (reads <= 3) throw statusFailure;
      return lateStatus.promise;
    },
    publish: (state) => {
      current = relayV2EnrollmentReducer(current, { type: "backendStateObserved", state });
    },
    onError: (failure) => {
      current = relayV2EnrollmentReducer(current, {
        type: "backendObservationFailed",
        failure,
      });
    },
  });

  observer.start();
  await flushPromises();
  assert.equal(deriveRelayV2EnrollmentView(observedState(), clock.now()).ready, true);
  assert.equal(observedState().enrollment.status, "active");

  clock.runNext();
  await flushPromises();
  let view = deriveRelayV2EnrollmentView(observedState(), clock.now());
  const failedState = observedState();
  assert.equal(failedState.authority.kind, "unavailable");
  assert.equal(failedState.connector.status, "failed");
  assert.equal(failedState.connector.retryable, true);
  assert.equal(failedState.enrollment.status, "failed");
  if (failedState.enrollment.status !== "failed") return;
  assert.equal(failedState.enrollment.retryable, true);
  assert.equal(view.ready, false);
  assert.equal(view.enrollmentAction, null);
  assert.equal(view.qrPayload, null);
  assert.doesNotMatch(JSON.stringify(failedState), /twenroll2\./);

  clock.runNext();
  await flushPromises();
  assert.equal(reads, 3);
  assert.equal(observedState().authority.kind, "unavailable");

  clock.runNext();
  await flushPromises();
  assert.equal(reads, 4);
  observer.stop();
  lateStatus.resolve(active);
  await flushPromises();
  view = deriveRelayV2EnrollmentView(observedState(), clock.now());
  assert.equal(observedState().authority.kind, "unavailable");
  assert.equal(view.ready, false);
  assert.equal(view.qrPayload, null);
  assert.equal(clock.count(), 0);
});

test("Relay v2 enrollment expiry schedules an authoritative observation at expiry", async () => {
  const clock = new FakeClock();
  const registered = registeredState();
  const active = {
    ...registered,
    enrollment: {
      status: "active" as const,
      review: {
        enrollment: {
          enrollmentId: "enrollment-1",
          enrollmentCode: "twenroll2.one-time-code",
          expiresAtMs: 500,
        },
        display: {
          issuerUrl: "https://relay.test",
          relayUrl: "wss://relay.test/client",
          hostId: "mac-admin",
          deviceLabel: null,
        },
      },
    },
  };
  const published: MobileRelayV2DashboardState[] = [];
  const observer = createRelayV2StatusObserver({
    clock,
    intervalMs: 2_000,
    read: async () => active,
    publish: (state) => published.push(state),
    onError: (error) => { throw error; },
  });

  observer.start();
  await flushPromises();
  assert.equal(published[0]?.enrollment.status, "active");
  assert.equal(clock.nextDelay(), 500);

  clock.runNext();
  await flushPromises();
  assert.equal(published[1]?.enrollment.status, "expired");
  assert.doesNotMatch(JSON.stringify(published[1]), /twenroll2\./);
  observer.stop();
});

test("Relay v2 operation failures are retryable only when the backend says so", () => {
  const retryable = classifyMobileRelayV2OperationFailure(
    {
      code: "relay_v2_temporarily_unavailable",
      message: "Try twcap2.payload.mac again later.",
      retryable: true,
    },
  );
  const unknown = classifyMobileRelayV2OperationFailure(
    new Error("Refresh twref2.refresh-secret failed"),
  );

  assert.equal(retryable.retryable, true);
  assert.equal(unknown.retryable, false);
  assert.match(retryable.message, /redacted Relay v2 credential/);
  assert.match(unknown.message, /redacted Relay v2 credential/);
  assert.doesNotMatch(retryable.message, /twcap2\.payload\.mac/);
  assert.doesNotMatch(unknown.message, /twref2\.refresh-secret/);

  const registered = registeredState();
  const normalized = normalizeMobileRelayV2DashboardState({
    ...registered,
    connector: {
      status: "failed",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: "Connector rejected twhostboot2.bootstrap-secret",
      retryable: false,
    },
  }, 1_000);
  assert.equal(normalized.connector.status, "failed");
  if (normalized.connector.status !== "failed") return;
  assert.match(normalized.connector.error, /redacted Relay v2 credential/);
  assert.doesNotMatch(normalized.connector.error, /twhostboot2\.bootstrap-secret/);
});
