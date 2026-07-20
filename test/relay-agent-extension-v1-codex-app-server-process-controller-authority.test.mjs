import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const controllerModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerProcessControllerAuthority.js"
);
const sourceModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerNotificationSource.js"
);
const compositionModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexTrustedSourceComposition.js"
);
const runtimeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/runtime.js"
);
const storeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/store.js"
);
const continuityModule = await import("../dist/relay/v2/continuityAnchor.js");

const OWNER = Object.freeze({ hostId: "host-controller", hostEpoch: "host-epoch-controller" });
const TARGET = Object.freeze({ scopeId: "scope-controller", sessionId: "session-controller" });
const BACKEND_INSTANCE_KEY = "backend-controller-exact";
const MANAGED_INCARNATION = `twinc2.${"a".repeat(43)}`;
const RETENTION_MS = 86_400_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function clone(value) {
  return structuredClone(value);
}

function sequentialIds(prefix) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

class PushByteSource {
  iteratorCalls = 0;
  cancelCalls = 0;
  pending = null;
  terminal = false;

  [Symbol.asyncIterator]() {
    this.iteratorCalls += 1;
    assert.equal(this.iteratorCalls, 1, "notification source is claimed by one iterator");
    return Object.freeze({ next: () => this.next() });
  }

  next() {
    if (this.terminal) return Promise.resolve({ done: true, value: undefined });
    assert.equal(this.pending, null, "only one notification read may be pending");
    this.pending = deferred();
    return this.pending.promise;
  }

  end() {
    if (this.terminal) return;
    this.terminal = true;
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve({ done: true, value: undefined });
    }
  }

  async cancel() {
    this.cancelCalls += 1;
    assert.equal(this.cancelCalls, 1, "notification source cancellation is exactly once");
    this.end();
  }
}

class FakeController {
  constructor(claim) {
    this.claim = claim;
  }

  calls = 0;

  async claimControlledProcess() {
    this.calls += 1;
    assert.equal(this.calls, 1, "controller is called at most once");
    return this.claim();
  }
}

class MemoryMonotonicCasAuthority {
  constructor(anchorId) {
    this.anchorId = anchorId;
    this.tokenSequence = 0;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "uninitialized",
      anchorId,
      casToken: "cas-0",
    };
  }

  async read(request) {
    assert.equal(request.anchorId, this.anchorId);
    return clone(this.current);
  }

  async compareAndSwap(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        outcome: "conflict",
        current: clone(this.current),
      };
    }
    this.tokenSequence += 1;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "committed",
      anchorId: this.anchorId,
      casToken: `cas-${this.tokenSequence}`,
      checkpoint: clone(request.next),
    };
    return {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      outcome: "swapped",
      current: clone(this.current),
    };
  }
}

function binding(overrides = {}) {
  return Object.freeze({
    ...OWNER,
    ...TARGET,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedIncarnation: MANAGED_INCARNATION,
    ...overrides,
  });
}

function controlledProcess(notificationSource, bindingValue = binding(), overrides = {}) {
  return Object.freeze({
    binding: bindingValue,
    notificationSource,
    ...overrides,
  });
}

function resourceTarget(overrides = {}) {
  return {
    authorization: "evidence_only",
    hostEpoch: OWNER.hostEpoch,
    discoveryGeneration: "controller-discovery-generation",
    scopeId: TARGET.scopeId,
    processTarget: { kind: "local", targetId: "controller-process-target" },
    capabilities: [],
    sessionId: TARGET.sessionId,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedTarget: {
      name: "controller-managed-session",
      kind: "worktree",
      incarnation: MANAGED_INCARNATION,
    },
    ...overrides,
  };
}

function resolver(overrides = {}) {
  const calls = [];
  return {
    calls,
    port: {
      async captureToken(hostEpoch) {
        calls.push(["capture", hostEpoch]);
        return {
          schemaVersion: 1,
          hostEpoch,
          resourceMappingDigest: "controller-resource-mapping",
          discoveryGeneration: "controller-discovery-generation",
        };
      },
      async resolveSession(token, scopeId, sessionId) {
        calls.push(["resolve", clone(token), scopeId, sessionId]);
        return resourceTarget(overrides.target);
      },
    },
  };
}

function controllerError(...codes) {
  return (error) => (
    error instanceof controllerModule.CodexAppServerProcessControllerAuthorityError
    && codes.includes(error.code)
  );
}

function compositionError(...codes) {
  return (error) => (
    error instanceof compositionModule.CodexTrustedSourceCompositionError
    && codes.includes(error.code)
  );
}

function notificationSourceError(...codes) {
  return (error) => (
    error instanceof sourceModule.CodexAppServerNotificationSourceError
    && codes.includes(error.code)
  );
}

function countingIssuer() {
  let calls = 0;
  class CountingIssuer extends compositionModule.CodexControlledSourceLeaseIssuer {
    issue(...args) {
      calls += 1;
      return super.issue(...args);
    }
  }
  return {
    issuer: new CountingIssuer(),
    get calls() { return calls; },
  };
}

function fakeCompositionAuthority(controller, options = {}) {
  const issuer = options.issuer ?? new compositionModule.CodexControlledSourceLeaseIssuer();
  const receiver = options.receiver ?? issuer.createReceiver();
  const h2 = resolver(options.resolver);
  const runtime = {
    store: { owner: OWNER },
    async ingestTrustedSource() {},
  };
  const composition = options.claimReceiver === false ? null : new compositionModule.CodexTrustedSourceComposition({
    runtime,
    canonicalResourceResolver: h2.port,
    controlledSourceIssuer: issuer,
    controlledSourceReceiver: receiver,
  });
  const authority = new controllerModule.CodexAppServerProcessControllerAuthority({
    controller,
    controlledSourceIssuer: issuer,
    controlledSourceReceiver: receiver,
  });
  return { issuer, receiver, h2, composition, authority };
}

async function integrationHarness(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-codex-process-controller-authority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const anchorId = storeModule.relayAgentAuthorityContinuityAnchorId(OWNER);
  const continuityAuthority = new MemoryMonotonicCasAuthority(anchorId);
  const store = await storeModule.RelayAgentAuthorityStore.open({
    ...OWNER,
    home,
    eventReplayRetentionMs: RETENTION_MS,
    randomId: sequentialIds("controller-durable-id"),
    randomCursor: sequentialIds("controller-cursor"),
    continuityAnchor: {
      anchorId,
      authority: continuityAuthority,
      operationTimeoutMs: 500,
      maxPendingOperations: 16,
    },
  });
  const runtime = new runtimeModule.RelayAgentTranscriptLifecycleRuntime(store);
  const h2 = resolver(options.resolver);
  const issuer = new compositionModule.CodexControlledSourceLeaseIssuer();
  const receiver = issuer.createReceiver();
  const composition = new compositionModule.CodexTrustedSourceComposition({
    runtime,
    canonicalResourceResolver: h2.port,
    controlledSourceIssuer: issuer,
    controlledSourceReceiver: receiver,
  });
  const bytes = new PushByteSource();
  const controller = new FakeController(() => controlledProcess(bytes, options.binding ?? binding()));
  const authority = new controllerModule.CodexAppServerProcessControllerAuthority({
    controller,
    controlledSourceIssuer: issuer,
    controlledSourceReceiver: receiver,
  });
  return { store, runtime, h2, issuer, receiver, composition, bytes, controller, authority };
}

test("authority is default-off and one zero-argument issue mints one exact opaque lease", async () => {
  const bytes = new PushByteSource();
  const controller = new FakeController(() => controlledProcess(bytes));
  const h = fakeCompositionAuthority(controller);

  assert.equal(h.authority.state, "disabled");
  assert.equal(controller.calls, 0);
  assert.equal(bytes.iteratorCalls, 0);
  const lease = await h.authority.issueControlledSourceLease();
  assert.equal(h.authority.state, "issued");
  assert.equal(controller.calls, 1);
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Object.getPrototypeOf(lease), null);
  assert.deepEqual(Reflect.ownKeys(lease), []);
  assert.equal(bytes.iteratorCalls, 0, "issuing a lease does not attach or read bytes");

  await assert.rejects(
    h.authority.issueControlledSourceLease(),
    controllerError("ALREADY_ISSUED"),
  );
  assert.equal(controller.calls, 1);
  const closed = h.authority.close();
  assert.equal(h.authority.close(), closed);
  await closed;
  assert.equal(bytes.cancelCalls, 1);
  assert.equal(h.authority.state, "closed");
  await h.composition.close();
});

test("caller-supplied foreign, copied, or mutated binding/source input is rejected before controller claim", async () => {
  const bytes = new PushByteSource();
  const controller = new FakeController(() => controlledProcess(bytes));
  const h = fakeCompositionAuthority(controller);
  const copiedBinding = Object.freeze({ ...binding() });
  const foreignSource = new PushByteSource();

  await assert.rejects(
    h.authority.issueControlledSourceLease(copiedBinding, foreignSource),
    controllerError("INVALID_CALL"),
  );
  assert.equal(h.authority.state, "disabled");
  assert.equal(controller.calls, 0);
  assert.equal(bytes.cancelCalls, 0);
  assert.equal(foreignSource.cancelCalls, 0);

  const lease = await h.authority.issueControlledSourceLease();
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(controller.calls, 1);
  await h.authority.close();
  await h.composition.close();
  assert.equal(bytes.cancelCalls, 1);
  assert.equal(foreignSource.cancelCalls, 0);
});

test("concurrent issue and replay never call the controller or issuer twice", async () => {
  const claim = deferred();
  const bytes = new PushByteSource();
  const controller = new FakeController(() => claim.promise);
  const countedIssuer = countingIssuer();
  const h = fakeCompositionAuthority(controller, { issuer: countedIssuer.issuer });

  const first = h.authority.issueControlledSourceLease();
  await assert.rejects(
    h.authority.issueControlledSourceLease(),
    controllerError("ISSUE_IN_PROGRESS"),
  );
  assert.equal(controller.calls, 1);
  claim.resolve(controlledProcess(bytes));
  const lease = await first;
  await assert.rejects(
    h.authority.issueControlledSourceLease(),
    controllerError("ALREADY_ISSUED"),
  );
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(controller.calls, 1);
  assert.equal(countedIssuer.calls, 1);
  await h.authority.close();
  await h.composition.close();
  assert.equal(bytes.cancelCalls, 1);
});

test("close racing the controller claim drains a late source once without issuing a lease", async () => {
  const claim = deferred();
  const bytes = new PushByteSource();
  const controller = new FakeController(() => claim.promise);
  const h = fakeCompositionAuthority(controller);

  const issue = h.authority.issueControlledSourceLease();
  const close = h.authority.close();
  claim.resolve(controlledProcess(bytes));
  await assert.rejects(issue, controllerError("CLOSED"));
  await close;
  assert.equal(controller.calls, 1);
  assert.equal(bytes.cancelCalls, 1);
  assert.equal(h.authority.state, "closed");
  await assert.rejects(
    h.authority.issueControlledSourceLease(),
    controllerError("CLOSED"),
  );
  await h.composition.close();
});

test("controller and source-cancel callback close reentry converge without self-wait", {
  timeout: 2_000,
}, async (t) => {
  const unhandled = [];
  const recordUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", recordUnhandled);
  try {
    for (const externalConcurrent of [false, true]) {
      await t.test(
        `controller callback await close; external concurrent=${externalConcurrent}`,
        async () => {
          const bytes = new PushByteSource();
          const countedIssuer = countingIssuer();
          const callbackBarriers = [];
          let callbackReturned = false;
          let authority;
          const controller = {
            calls: 0,
            async claimControlledProcess() {
              this.calls += 1;
              const first = authority.close();
              const second = authority.close();
              callbackBarriers.push(first, second);
              assert.equal(first, second, "controller reentry gets one continuation");
              await first;
              callbackReturned = true;
              return controlledProcess(bytes);
            },
          };
          const h = fakeCompositionAuthority(controller, { issuer: countedIssuer.issuer });
          authority = h.authority;

          const issue = authority.issueControlledSourceLease();
          const externalClose = externalConcurrent ? authority.close() : null;
          await assert.rejects(issue, controllerError("CLOSED"));
          const publicClose = externalClose ?? authority.close();
          assert.equal(authority.close(), publicClose, "external close has one public owner");
          assert.notEqual(callbackBarriers[0], publicClose);
          await publicClose;
          assert.equal(callbackReturned, true);
          assert.equal(controller.calls, 1);
          assert.equal(countedIssuer.calls, 0, "closing prevents late issuer admission");
          assert.equal(bytes.cancelCalls, 1);
          assert.equal(authority.state, "closed");
          await h.composition.close();
        },
      );
    }

    await t.test("cancel callback await close during internal issue-failure cleanup", async () => {
      const countedIssuer = countingIssuer();
      const callbackBarriers = [];
      let callbackReturned = false;
      let authority;
      class ReentrantCancelSource extends PushByteSource {
        async cancel() {
          this.cancelCalls += 1;
          assert.equal(this.cancelCalls, 1);
          this.end();
          const first = authority.close();
          const second = authority.close();
          callbackBarriers.push(first, second);
          assert.equal(first, second, "cancel reentry gets one continuation");
          await first;
          callbackReturned = true;
        }
      }
      const bytes = new ReentrantCancelSource();
      const controller = new FakeController(() => controlledProcess(bytes));
      const h = fakeCompositionAuthority(controller, {
        issuer: countedIssuer.issuer,
        claimReceiver: false,
      });
      authority = h.authority;

      await assert.rejects(
        authority.issueControlledSourceLease(),
        controllerError("LEASE_ISSUE_FAILED"),
      );
      const publicClose = authority.close();
      assert.equal(authority.close(), publicClose);
      assert.notEqual(callbackBarriers[0], publicClose);
      await publicClose;
      assert.equal(callbackReturned, true);
      assert.equal(controller.calls, 1);
      assert.equal(countedIssuer.calls, 1);
      assert.equal(bytes.cancelCalls, 1);
      assert.equal(authority.state, "sealed");
    });

    await t.test("cancel callback await close with concurrent external close", async () => {
      const countedIssuer = countingIssuer();
      const callbackBarriers = [];
      let callbackReturned = false;
      let authority;
      class ReentrantCancelSource extends PushByteSource {
        async cancel() {
          this.cancelCalls += 1;
          assert.equal(this.cancelCalls, 1);
          this.end();
          const first = authority.close();
          const second = authority.close();
          callbackBarriers.push(first, second);
          assert.equal(first, second, "cancel reentry gets one continuation");
          await first;
          callbackReturned = true;
        }
      }
      const bytes = new ReentrantCancelSource();
      const controller = new FakeController(() => controlledProcess(bytes));
      const h = fakeCompositionAuthority(controller, { issuer: countedIssuer.issuer });
      authority = h.authority;
      await authority.issueControlledSourceLease();

      const publicClose = authority.close();
      assert.equal(authority.close(), publicClose, "external close has one public owner");
      assert.notEqual(callbackBarriers[0], publicClose);
      await publicClose;
      assert.equal(callbackReturned, true);
      assert.equal(controller.calls, 1);
      assert.equal(countedIssuer.calls, 1);
      assert.equal(bytes.cancelCalls, 1);
      assert.equal(authority.state, "closed");
      await h.composition.close();
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", recordUnhandled);
  }
});

test("built notification-source and controller entrypoints share irreversible raw-source ownership", async (t) => {
  await t.test("notification source A then controller B", async () => {
    const bytes = new PushByteSource();
    const ownerA = new sourceModule.CodexAppServerNotificationSource(bytes);
    const firstB = fakeCompositionAuthority(
      new FakeController(() => controlledProcess(bytes)),
    );
    await assert.rejects(
      firstB.authority.issueControlledSourceLease(),
      controllerError("SOURCE_CLAIM_FAILED"),
    );
    assert.equal(bytes.cancelCalls, 0, "foreign B never closes A-owned source");
    await firstB.authority.close();
    await firstB.composition.close();

    await ownerA.closeAndDrain();
    assert.equal(bytes.cancelCalls, 1);
    const afterCleanupB = fakeCompositionAuthority(
      new FakeController(() => controlledProcess(bytes)),
    );
    await assert.rejects(
      afterCleanupB.authority.issueControlledSourceLease(),
      controllerError("SOURCE_CLAIM_FAILED"),
    );
    assert.equal(bytes.cancelCalls, 1, "cleanup never releases raw-source identity");
    await afterCleanupB.authority.close();
    await afterCleanupB.composition.close();
  });

  await t.test("controller B then notification source A", async () => {
    const bytes = new PushByteSource();
    const ownerB = fakeCompositionAuthority(
      new FakeController(() => controlledProcess(bytes)),
    );
    await ownerB.authority.issueControlledSourceLease();
    assert.throws(
      () => new sourceModule.CodexAppServerNotificationSource(bytes),
      notificationSourceError("SOURCE_ALREADY_OWNED"),
    );
    assert.equal(bytes.cancelCalls, 0, "foreign A never closes B-owned source");

    await ownerB.authority.close();
    assert.equal(bytes.cancelCalls, 1);
    assert.throws(
      () => new sourceModule.CodexAppServerNotificationSource(bytes),
      notificationSourceError("SOURCE_ALREADY_OWNED"),
    );
    assert.equal(bytes.cancelCalls, 1, "cleanup never releases raw-source identity");
    await ownerB.composition.close();
  });
});

test("controller, result, binding, source-claim, and issuer failures seal with exact owned cleanup", async (t) => {
  await t.test("controller failure owns no source and leaks no private error", async () => {
    const controller = new FakeController(() => {
      throw new Error("controller-private-credential");
    });
    const h = fakeCompositionAuthority(controller);
    await assert.rejects(h.authority.issueControlledSourceLease(), (error) => {
      assert.equal(controllerError("CONTROLLER_FAILED")(error), true);
      assert.equal(error.message.includes("controller-private-credential"), false);
      return true;
    });
    assert.equal(h.authority.state, "sealed");
    assert.equal(h.authority.failure, "CONTROLLER_FAILED");
    await h.authority.close();
    await h.composition.close();
  });

  await t.test("invalid outer shape is never treated as an owned source transfer", async () => {
    const bytes = new PushByteSource();
    const controller = new FakeController(() => ({
      binding: binding(),
      notificationSource: bytes,
    }));
    const h = fakeCompositionAuthority(controller);
    await assert.rejects(
      h.authority.issueControlledSourceLease(),
      controllerError("INVALID_CONTROLLER_RESULT"),
    );
    assert.equal(h.authority.state, "sealed");
    assert.equal(bytes.cancelCalls, 0);
    await h.authority.close();
    await h.composition.close();
  });

  for (const scenario of [
    { name: "mutable binding", make: () => ({ ...binding() }) },
    { name: "extra binding field", make: () => Object.freeze({ ...binding(), pid: 123 }) },
    { name: "binding accessor", make: () => {
      const descriptors = Object.getOwnPropertyDescriptors(binding());
      descriptors.sessionId = {
        enumerable: true,
        configurable: false,
        get() { throw new Error("private-binding-accessor"); },
      };
      return Object.freeze(Object.defineProperties({}, descriptors));
    } },
  ]) {
    await t.test(scenario.name, async () => {
      const bytes = new PushByteSource();
      const controller = new FakeController(() => controlledProcess(bytes, scenario.make()));
      const h = fakeCompositionAuthority(controller);
      await assert.rejects(
        h.authority.issueControlledSourceLease(),
        controllerError("SOURCE_BINDING_MISMATCH"),
      );
      assert.equal(h.authority.state, "sealed");
      assert.equal(h.authority.failure, "SOURCE_BINDING_MISMATCH");
      assert.equal(bytes.cancelCalls, 1, "claimed invalid binding source is cleaned once");
      await h.authority.close();
      await h.composition.close();
      assert.equal(bytes.cancelCalls, 1);
    });
  }

  await t.test("a source already claimed by a foreign authority is not cancelled", async () => {
    const bytes = new PushByteSource();
    const foreign = fakeCompositionAuthority(
      new FakeController(() => controlledProcess(bytes)),
    );
    await foreign.authority.issueControlledSourceLease();
    const h = fakeCompositionAuthority(
      new FakeController(() => controlledProcess(bytes)),
    );
    await assert.rejects(
      h.authority.issueControlledSourceLease(),
      controllerError("SOURCE_CLAIM_FAILED"),
    );
    assert.equal(h.authority.state, "sealed");
    assert.equal(bytes.cancelCalls, 0);
    await h.authority.close();
    assert.equal(bytes.cancelCalls, 0);
    await foreign.authority.close();
    assert.equal(bytes.cancelCalls, 1);
    await foreign.composition.close();
    await h.composition.close();
  });

  await t.test("a malformed source is never treated as an owned transfer", async () => {
    let foreignCancelCalls = 0;
    const malformedSource = {
      async cancel() {
        foreignCancelCalls += 1;
      },
    };
    const controller = new FakeController(() => controlledProcess(malformedSource));
    const h = fakeCompositionAuthority(controller);
    await assert.rejects(
      h.authority.issueControlledSourceLease(),
      controllerError("SOURCE_CLAIM_FAILED"),
    );
    assert.equal(h.authority.state, "sealed");
    assert.equal(foreignCancelCalls, 0);
    await h.authority.close();
    assert.equal(foreignCancelCalls, 0);
    await h.composition.close();
  });

  await t.test("issuer failure drains the source claimed by this authority", async () => {
    const bytes = new PushByteSource();
    const controller = new FakeController(() => controlledProcess(bytes));
    const h = fakeCompositionAuthority(controller, { claimReceiver: false });
    await assert.rejects(
      h.authority.issueControlledSourceLease(),
      controllerError("LEASE_ISSUE_FAILED"),
    );
    assert.equal(h.authority.state, "sealed");
    assert.equal(h.authority.failure, "LEASE_ISSUE_FAILED");
    assert.equal(bytes.cancelCalls, 1);
    await h.authority.close();
    assert.equal(bytes.cancelCalls, 1);
  });
});

test("owned source cleanup failure is exactly once, fixed, and permanently sealed", async () => {
  class FailingCancelSource extends PushByteSource {
    async cancel() {
      this.cancelCalls += 1;
      assert.equal(this.cancelCalls, 1);
      this.end();
      throw new Error("private-cancel-credential");
    }
  }
  const bytes = new FailingCancelSource();
  const controller = new FakeController(() => controlledProcess(bytes));
  const h = fakeCompositionAuthority(controller);
  await h.authority.issueControlledSourceLease();

  const close = h.authority.close();
  assert.equal(h.authority.close(), close);
  await assert.rejects(close, (error) => {
    assert.equal(controllerError("SOURCE_CLOSE_FAILED")(error), true);
    assert.equal(error.message.includes("private-cancel-credential"), false);
    return true;
  });
  assert.equal(bytes.cancelCalls, 1);
  assert.equal(h.authority.state, "sealed");
  assert.equal(h.authority.failure, "SOURCE_CLOSE_FAILED");
  await assert.rejects(
    h.authority.issueControlledSourceLease(),
    controllerError("SEALED"),
  );
  await h.composition.close();
});

test("closing an unclaimed issued lease cancels once and later composition attach fails closed", async () => {
  const bytes = new PushByteSource();
  const controller = new FakeController(() => controlledProcess(bytes));
  const h = fakeCompositionAuthority(controller);
  const lease = await h.authority.issueControlledSourceLease();

  const closed = h.authority.close();
  assert.equal(h.authority.close(), closed);
  await closed;
  assert.equal(bytes.cancelCalls, 1);
  await assert.rejects(
    h.composition.enable(lease),
    compositionError("ATTACH_FAILED"),
  );
  assert.equal(h.composition.state, "sealed");
  await h.composition.close();
  assert.equal(bytes.cancelCalls, 1);
});

test("trusted composition independently checks H2 before claiming the controller lease", async (t) => {
  await t.test("valid H2 claims the bounded source and composition alone drains it", async (subtest) => {
    const h = await integrationHarness(subtest);
    const lease = await h.authority.issueControlledSourceLease();
    await h.composition.enable(lease);
    assert.deepEqual(h.h2.calls.map(([kind]) => kind), ["capture", "resolve"]);
    assert.equal(h.authority.state, "attached");
    assert.equal(h.bytes.iteratorCalls, 1);

    const compositionClose = h.composition.close();
    const authorityClose = h.authority.close();
    await Promise.all([compositionClose, authorityClose]);
    assert.equal(h.bytes.cancelCalls, 1, "authority does not close a source transferred to composition");
    assert.equal(h.authority.state, "closed");
    assert.equal(h.composition.state, "closed");
  });

  for (const scenario of [
    { name: "H2 remains evidence-only", target: { authorization: "process_authority" } },
    { name: "H2 backend binding is independent", target: { backendInstanceKey: "other-backend" } },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const h = await integrationHarness(subtest, { resolver: { target: scenario.target } });
      const lease = await h.authority.issueControlledSourceLease();
      await assert.rejects(
        h.composition.enable(lease),
        compositionError("SOURCE_BINDING_MISMATCH"),
      );
      assert.deepEqual(h.h2.calls.map(([kind]) => kind), ["capture", "resolve"]);
      assert.equal(h.bytes.iteratorCalls, 0, "failed H2 never attaches or reads notification bytes");
      assert.equal(h.bytes.cancelCalls, 0, "composition does not own the unattached source");
      await h.composition.close();
      await h.authority.close();
      assert.equal(h.bytes.cancelCalls, 1, "controller authority closes only its unclaimed source");
      assert.equal(h.authority.state, "closed");
      assert.equal(h.composition.state, "sealed");
    });
  }
});
