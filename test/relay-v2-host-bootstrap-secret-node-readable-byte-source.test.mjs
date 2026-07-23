import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

const handoffModule = await import(
  "../dist/relay/v2/hostBootstrapSecretHandoff.js"
);
const nodeReadableModule = await import(
  "../dist/relay/v2/hostBootstrapSecretNodeReadableByteSource.js"
);
const sourceModule = await import(
  "../dist/relay/v2/hostBootstrapSecretSource.js"
);

const BOOTSTRAP_SECRET = "twhostboot2.node-readable-secret";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function assertRedacted(error) {
  return error?.cause === undefined
    && !String(error).includes(BOOTSTRAP_SECRET)
    && !String(error?.message).includes(BOOTSTRAP_SECRET);
}

function assertAdapterError(code) {
  return (error) => error?.code === code && assertRedacted(error);
}

function assertSourceError(code) {
  return (error) => error?.code === code && assertRedacted(error);
}

function controlledReadable({ chunks = null, pending = null, destroyError = null } = {}) {
  let readCalls = 0;
  let destroyCalls = 0;
  let emitted = false;
  const readable = new Readable({
    autoDestroy: false,
    read() {
      readCalls += 1;
      pending?.resolve();
      if (emitted || chunks === null) return;
      emitted = true;
      for (const chunk of chunks) this.push(chunk);
      this.push(null);
    },
    destroy(error, callback) {
      destroyCalls += 1;
      queueMicrotask(() => callback(destroyError ?? error));
    },
  });
  return {
    readable,
    readCalls: () => readCalls,
    destroyCalls: () => destroyCalls,
  };
}

test("Node Readable bootstrap byte source transfers once and closes unsafe lifecycles", async () => {
  {
    const stream = controlledReadable({
      chunks: [Buffer.from("twhostboot2.node-", "utf8"), Buffer.from("readable-secret\n", "utf8")],
    });
    const byteSource = nodeReadableModule
      .createRelayV2HostBootstrapSecretNodeReadableByteSource(stream.readable);
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const source = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      handoff.privilegedIntake,
    );

    assert.equal(stream.readCalls(), 0, "construction must not read");
    assert.equal(stream.destroyCalls(), 0, "construction must not destroy");
    assert.throws(
      () => nodeReadableModule.createRelayV2HostBootstrapSecretNodeReadableByteSource(
        stream.readable,
      ),
      assertAdapterError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_ALREADY_CLAIMED",
      ),
    );

    const candidate = await source.readCandidate();
    const firstCancel = byteSource.cancel();
    assert.equal(byteSource.cancel(), firstCancel, "cancel Promise must be stable");
    await firstCancel;
    await source.closeAndDrain();
    assert.equal(stream.destroyCalls(), 1, "Readable destroy must run exactly once");
    assert.equal(
      handoff.handoff.runWithCandidate(candidate, (secret) => secret),
      BOOTSTRAP_SECRET,
    );
    assert.throws(
      () => handoff.handoff.runWithCandidate(candidate, () => undefined),
      (error) => error?.code
        === "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE"
        && assertRedacted(error),
    );
    await handoff.closeAndDrain();
  }

  {
    const readStarted = deferred();
    const stream = controlledReadable({ pending: readStarted });
    const byteSource = nodeReadableModule
      .createRelayV2HostBootstrapSecretNodeReadableByteSource(stream.readable);
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const source = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      handoff.privilegedIntake,
    );
    const reading = source.readCandidate();
    void reading.catch(() => undefined);
    await readStarted.promise;
    const closing = source.closeAndDrain();
    assert.equal(source.closeAndDrain(), closing, "close Promise must be stable");
    await closing;
    await assert.rejects(
      reading,
      assertSourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED"),
    );
    assert.equal(stream.destroyCalls(), 1, "pending iterator must be destroyed once");
    await handoff.closeAndDrain();
  }

  {
    const stream = controlledReadable({
      destroyError: new Error(`raw destroy exposed ${BOOTSTRAP_SECRET}`),
    });
    const byteSource = nodeReadableModule
      .createRelayV2HostBootstrapSecretNodeReadableByteSource(stream.readable);
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const source = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      handoff.privilegedIntake,
    );
    await assert.rejects(
      source.closeAndDrain(),
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
      ),
    );
    assert.equal(stream.destroyCalls(), 1);
    await handoff.closeAndDrain();
  }

  {
    let destroyCalls = 0;
    const readable = new Readable({
      autoDestroy: false,
      read() {},
      destroy() {
        destroyCalls += 1;
        // Deliberately never complete Node's _destroy callback. The adapter's
        // own deadline must still close its public cancellation lifecycle.
      },
    });
    const byteSource = nodeReadableModule
      .createRelayV2HostBootstrapSecretNodeReadableByteSource(readable);
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    const source = sourceModule.createRelayV2HostBootstrapSecretSource(
      byteSource,
      handoff.privilegedIntake,
    );
    await assert.rejects(
      source.closeAndDrain(),
      assertSourceError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
      ),
    );
    assert.equal(destroyCalls, 1, "hung destroy must not be retried");
    await handoff.closeAndDrain();
  }

  {
    let accessorReads = 0;
    const accessorStream = new Readable({ read() {} });
    Object.defineProperty(accessorStream, Symbol.asyncIterator, {
      get() {
        accessorReads += 1;
        throw new Error(`accessor exposed ${BOOTSTRAP_SECRET}`);
      },
    });
    const proxyStream = new Proxy(new Readable({ read() {} }), {});
    for (const [label, value] of [
      ["foreign", Object.create(null)],
      ["proxy", proxyStream],
      ["accessor", accessorStream],
    ]) {
      assert.throws(
        () => nodeReadableModule.createRelayV2HostBootstrapSecretNodeReadableByteSource(value),
        assertAdapterError("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_INVALID"),
        label,
      );
    }
    assert.equal(accessorReads, 0, "accessor must not be invoked during capture");
    Reflect.apply(Readable.prototype.destroy, accessorStream, []);
  }

  for (const [label, iteratorFactory] of [
    ["proxy iterator", () => new Proxy({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }, {})],
    ["non-native next Promise", () => ({
      next: () => ({
        then() {
          throw new Error(`thenable exposed ${BOOTSTRAP_SECRET}`);
        },
      }),
    })],
  ]) {
    const stream = controlledReadable();
    Object.defineProperty(stream.readable, Symbol.asyncIterator, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: iteratorFactory,
    });
    const byteSource = nodeReadableModule
      .createRelayV2HostBootstrapSecretNodeReadableByteSource(stream.readable);
    const handoff = handoffModule.createRelayV2HostBootstrapSecretHandoffAuthority();
    let intakeCalls = 0;
    const intake = Object.freeze({
      accept(secret) {
        intakeCalls += 1;
        return handoff.privilegedIntake.accept(secret);
      },
    });
    const source = sourceModule.createRelayV2HostBootstrapSecretSource(byteSource, intake);
    await assert.rejects(
      source.readCandidate(),
      assertSourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED"),
      label,
    );
    await assert.rejects(
      source.closeAndDrain(),
      assertSourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED"),
      `${label}: close`,
    );
    assert.equal(intakeCalls, 0, `${label}: intake must remain fenced`);
    assert.equal(stream.destroyCalls(), 1, `${label}: cancel must destroy once`);
    await handoff.closeAndDrain();
  }
});
