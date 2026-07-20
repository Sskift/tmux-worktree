import assert from "node:assert/strict";
import test from "node:test";

const handoffModule = await import(
  "../dist/relay/v2/hostBootstrapSecretHandoff.js"
);
const sourceModule = await import(
  "../dist/relay/v2/hostBootstrapSecretSource.js"
);

const BOOTSTRAP_SECRET = "twhostboot2.injected-source-secret";
const MAX_BOOTSTRAP_SECRET = `twhostboot2.${"a".repeat(8_192 - 12)}`;

function bytes(value) {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function recordedIntake(handoff) {
  let calls = 0;
  const intake = Object.create(null);
  Object.defineProperty(intake, "accept", {
    value: (secret) => {
      calls += 1;
      return handoff.privilegedIntake.accept(secret);
    },
  });
  return {
    port: Object.freeze(intake),
    calls: () => calls,
  };
}

class ScriptedByteSource {
  openCalls = 0;
  nextCalls = 0;
  cancelCalls = 0;

  constructor(steps, options = {}) {
    this.steps = steps;
    this.cancelImpl = options.cancelImpl ?? (() => Promise.resolve());
    this.iteratorFactory = options.iteratorFactory ?? null;
  }

  [Symbol.asyncIterator]() {
    this.openCalls += 1;
    if (this.iteratorFactory !== null) return this.iteratorFactory(this);
    let index = 0;
    return {
      next: () => {
        this.nextCalls += 1;
        if (index >= this.steps.length) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const step = this.steps[index++];
        if (step?.kind === "reject") return Promise.reject(step.error);
        if (step?.kind === "unsafe-promise") return step.value;
        return Promise.resolve({ done: false, value: step });
      },
    };
  }

  cancel() {
    this.cancelCalls += 1;
    return this.cancelImpl();
  }
}

function assertSourceError(code) {
  return (error) => error?.code === code
    && error.cause === undefined
    && !String(error).includes(BOOTSTRAP_SECRET)
    && !String(error.message).includes(BOOTSTRAP_SECRET);
}

function assertLeastAuthorityHandle(handle) {
  assert.deepEqual(
    Reflect.ownKeys(handle).sort(),
    ["closeAndDrain", "readCandidate"],
  );
  assert.equal(Object.isFrozen(handle), true);
  for (const key of Reflect.ownKeys(handle)) {
    assert.equal(Object.getOwnPropertyDescriptor(handle, key)?.enumerable, false);
  }
}

test("fragmented one-record sources transfer exactly once through the real H-Cred2 handoff", async () => {
  for (const [label, chunks, expectedSecret] of [
    ["eof-delimited", ["twhost", "boot2.injected-", "source-secret"],
      BOOTSTRAP_SECRET],
    ["terminal-lf", ["twhostboot2.", "injected-source-secret", "\n"],
      BOOTSTRAP_SECRET],
    ["8192-payload", [MAX_BOOTSTRAP_SECRET], MAX_BOOTSTRAP_SECRET],
    ["8193-raw-terminal-lf", [MAX_BOOTSTRAP_SECRET, "\n"],
      MAX_BOOTSTRAP_SECRET],
  ]) {
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const intake = recordedIntake(handoff);
    const byteSource = new ScriptedByteSource(chunks.map(bytes));
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake.port,
    );

    assertLeastAuthorityHandle(adapter);
    assert.equal(byteSource.openCalls, 0, `${label}: construction must not iterate`);
    assert.equal(byteSource.cancelCalls, 0, `${label}: construction must not cancel`);
    assert.equal(intake.calls(), 0, `${label}: construction must not call intake`);
    assert.throws(
      () => sourceModule.createRelayV2HostBootstrapSecretSource(
        byteSource,
        intake.port,
      ),
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_ALREADY_CLAIMED",
      ),
    );

    const pending = adapter.readCandidate();
    assert.equal(adapter.readCandidate(), pending, `${label}: pending Promise identity`);
    const candidate = await pending;
    assert.equal(intake.calls(), 1, label);
    assert.equal(byteSource.cancelCalls, 1, label);

    const closed = adapter.closeAndDrain();
    assert.equal(adapter.closeAndDrain(), closed, `${label}: close Promise identity`);
    await closed;
    assert.equal(
      handoff.handoff.runWithCandidate(candidate, (secret) => {
        assert.equal(secret, expectedSecret, label);
        return "consumed";
      }),
      "consumed",
      `${label}: source close must not close H-Cred2`,
    );
    await handoff.closeAndDrain();
  }

  let thenGetterCalls = 0;
  let thenCalls = 0;
  const hostileThenPrototype = Object.create(null);
  Object.defineProperty(hostileThenPrototype, "then", {
    get() {
      thenGetterCalls += 1;
      return () => {
        thenCalls += 1;
      };
    },
  });
  const hostileThenable = Object.create(hostileThenPrototype);

  for (const [label, intakeAction] of [
    ["hostile-thenable", () => hostileThenable],
    ["native-promise", () => new Promise(() => {})],
    ["proxy", () => new Proxy(Object.freeze(Object.create(null)), {})],
    ["intake-sync-throw", () => {
      throw new Error(`raw intake exposed ${BOOTSTRAP_SECRET}`);
    }],
  ]) {
    let intakeCalls = 0;
    const intake = Object.create(null);
    Object.defineProperty(intake, "accept", {
      value: () => {
        intakeCalls += 1;
        return intakeAction();
      },
    });
    Object.freeze(intake);
    const byteSource = new ScriptedByteSource([bytes(BOOTSTRAP_SECRET)]);
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake,
    );

    await assert.rejects(
      adapter.readCandidate(),
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED",
      ),
      label,
    );
    assert.equal(intakeCalls, 1, label);
    assert.equal(byteSource.cancelCalls, 1, label);
    await assert.rejects(
      adapter.closeAndDrain(),
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED",
      ),
      `${label}: close failure`,
    );
  }
  assert.equal(thenGetterCalls, 0);
  assert.equal(thenCalls, 0);

  {
    const opaqueCandidate = { ownerSpecificShape: true };
    let intakeCalls = 0;
    const intake = Object.freeze({
      accept: () => {
        intakeCalls += 1;
        return opaqueCandidate;
      },
    });
    const byteSource = new ScriptedByteSource([bytes(BOOTSTRAP_SECRET)]);
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake,
    );
    assert.equal(await adapter.readCandidate(), opaqueCandidate);
    assert.equal(intakeCalls, 1);
    await adapter.closeAndDrain();
  }

  {
    const cancelStarted = deferred();
    const cancelFinished = deferred();
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const intake = recordedIntake(handoff);
    const byteSource = new ScriptedByteSource([bytes(BOOTSTRAP_SECRET)], {
      cancelImpl: () => {
        cancelStarted.resolve();
        return cancelFinished.promise;
      },
    });
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake.port,
    );
    const pending = adapter.readCandidate();
    let readSettled = false;
    void pending.then(
      () => {
        readSettled = true;
      },
      () => {
        readSettled = true;
      },
    );
    await cancelStarted.promise;
    await Promise.resolve();
    assert.equal(readSettled, false);
    assert.equal(adapter.readCandidate(), pending);
    assert.equal(intake.calls(), 0);

    cancelFinished.resolve();
    const candidate = await pending;
    assert.equal(intake.calls(), 1);
    assert.equal(byteSource.cancelCalls, 1);
    await adapter.closeAndDrain();
    assert.equal(
      handoff.handoff.runWithCandidate(candidate, (secret) => secret),
      BOOTSTRAP_SECRET,
    );
    await handoff.closeAndDrain();
  }
});

test("invalid framing, unsafe source values, and cancel failure stay redacted before intake", async () => {
  const oversizedPayload = new Uint8Array(8_193);
  oversizedPayload.fill(0x61);
  const invalidCases = [
    ["empty", new ScriptedByteSource([]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["cr", new ScriptedByteSource([bytes(`${BOOTSTRAP_SECRET}\r`)]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["crlf", new ScriptedByteSource([bytes(`${BOOTSTRAP_SECRET}\r\n`)]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["embedded-lf", new ScriptedByteSource([bytes("twhost\nboot2.secret")]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["second-lf", new ScriptedByteSource([bytes(`${BOOTSTRAP_SECRET}\n\n`)]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["lf-trailing", new ScriptedByteSource([bytes(`${BOOTSTRAP_SECRET}\ntrailing`)]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["nul", new ScriptedByteSource([Uint8Array.from([0x61, 0x00, 0x62])]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["non-ascii", new ScriptedByteSource([Uint8Array.from([0x61, 0xc3, 0xa9])]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["8193-payload", new ScriptedByteSource([oversizedPayload]),
      "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["proxy-chunk", new ScriptedByteSource([
      new Proxy(bytes(BOOTSTRAP_SECRET), {}),
    ]), "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"],
    ["proxy-iterator", new ScriptedByteSource([], {
      iteratorFactory: () => new Proxy({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }, {}),
    }), "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED"],
    ["non-native-next-promise", new ScriptedByteSource([{
      kind: "unsafe-promise",
      value: { then() {} },
    }]), "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED"],
    ["source-rejection", new ScriptedByteSource([{
      kind: "reject",
      error: new Error(`raw source exposed ${BOOTSTRAP_SECRET}`),
    }]), "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED"],
    ["cancel-rejection", new ScriptedByteSource([bytes(BOOTSTRAP_SECRET)], {
      cancelImpl: () => Promise.reject(
        new Error(`raw cancel exposed ${BOOTSTRAP_SECRET}`),
      ),
    }), "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED"],
  ];

  for (const [label, byteSource, code] of invalidCases) {
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const intake = recordedIntake(handoff);
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake.port,
    );
    const reading = adapter.readCandidate();
    await assert.rejects(reading, assertSourceError(code), label);
    assert.equal(adapter.readCandidate(), reading, `${label}: read must not reopen`);
    assert.equal(intake.calls(), 0, `${label}: intake commit must not occur`);
    assert.equal(byteSource.cancelCalls, 1, `${label}: source cancel convergence`);

    const closing = adapter.closeAndDrain();
    assert.equal(adapter.closeAndDrain(), closing, `${label}: stable close Promise`);
    await assert.rejects(closing, assertSourceError(code), `${label}: close failure`);
    assert.equal(byteSource.cancelCalls, 1, `${label}: cancel exactly once`);
    await handoff.closeAndDrain();
  }
});

test("close fences pending next and the EOF/cancel commit race, then drains the admitted continuation", async (t) => {
  await t.test("pending next", async () => {
    const next = deferred();
    const nextStarted = deferred();
    let hostileGetterReads = 0;
    const byteSource = new ScriptedByteSource([], {
      iteratorFactory: (owner) => ({
        next: () => {
          owner.nextCalls += 1;
          nextStarted.resolve();
          return next.promise;
        },
      }),
      cancelImpl: () => Promise.reject(
        new Error(`raw cancel exposed ${BOOTSTRAP_SECRET}`),
      ),
    });
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const intake = recordedIntake(handoff);
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake.port,
    );

    const reading = adapter.readCandidate();
    await nextStarted.promise;
    const hostilePrototype = Object.create(Promise.prototype);
    Object.defineProperty(hostilePrototype, "constructor", {
      get() {
        hostileGetterReads += 1;
        throw new Error("public read Promise constructor must not be read");
      },
    });
    assert.equal(Object.isFrozen(reading), true);
    assert.equal(Reflect.setPrototypeOf(reading, hostilePrototype), false);
    assert.throws(
      () => Object.defineProperty(reading, "constructor", {
        get() {
          hostileGetterReads += 1;
          throw new Error("public read Promise constructor must not be read");
        },
      }),
      TypeError,
    );
    const closing = adapter.closeAndDrain();
    assert.equal(adapter.closeAndDrain(), closing);
    assert.equal(Object.isFrozen(closing), true);
    let closeSettled = false;
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(closeSettled, false);
    assert.equal(hostileGetterReads, 0);

    next.resolve({ done: false, value: bytes(BOOTSTRAP_SECRET) });
    await assert.rejects(
      reading,
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
      ),
    );
    await assert.rejects(
      closing,
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
      ),
    );
    assert.equal(closeSettled, true);
    assert.equal(hostileGetterReads, 0);
    assert.equal(intake.calls(), 0);
    assert.equal(byteSource.cancelCalls, 1);
    assert.equal(adapter.readCandidate(), reading);
    await handoff.closeAndDrain();
  });

  await t.test("EOF reached but cancel has not committed", async () => {
    const cancelStarted = deferred();
    const cancelFinished = deferred();
    const byteSource = new ScriptedByteSource([bytes(BOOTSTRAP_SECRET)], {
      cancelImpl: () => {
        cancelStarted.resolve();
        return cancelFinished.promise;
      },
    });
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const intake = recordedIntake(handoff);
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake.port,
    );

    const reading = adapter.readCandidate();
    await cancelStarted.promise;
    const closing = adapter.closeAndDrain();
    cancelFinished.resolve();
    await assert.rejects(
      reading,
      assertSourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED"),
    );
    await closing;
    assert.equal(intake.calls(), 0);
    assert.equal(byteSource.cancelCalls, 1);
    await handoff.closeAndDrain();
  });

  await t.test("close before read", async () => {
    const byteSource = new ScriptedByteSource([bytes(BOOTSTRAP_SECRET)]);
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const intake = recordedIntake(handoff);
    const adapter = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      intake.port,
    );
    await adapter.closeAndDrain();
    const reading = adapter.readCandidate();
    assert.equal(adapter.readCandidate(), reading);
    await assert.rejects(
      reading,
      assertSourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED"),
    );
    assert.equal(byteSource.openCalls, 0);
    assert.equal(byteSource.cancelCalls, 1);
    assert.equal(intake.calls(), 0);
    await handoff.closeAndDrain();
  });
});
