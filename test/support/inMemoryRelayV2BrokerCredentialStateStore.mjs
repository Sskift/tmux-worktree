import assert from "node:assert/strict";

function copyBytes(value) {
  return Uint8Array.from(value);
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

/**
 * Behavioral N0 deep-port test implementation. It deliberately exposes no
 * path, generation, digest, native handle, or persistence-format surface.
 */
export class InMemoryRelayV2BrokerCredentialStateStore {
  #bytes;
  #revision = 0;
  #tail = Promise.resolve();
  #admissionClosed = false;
  #closed = false;
  #closePromise = null;
  #revisionOwners = new WeakMap();

  constructor(options = {}) {
    assert.equal(options !== null && typeof options === "object", true);
    this.#bytes = options.initialBytes === undefined
      ? null
      : copyBytes(options.initialBytes);
    this.onCompareAndPublish = options.onCompareAndPublish ?? null;
    this.onClose = options.onClose ?? null;
    this.runExclusiveCalls = 0;
    this.readCalls = 0;
    this.compareAndPublishCalls = 0;
    this.closeCalls = 0;
  }

  get closed() {
    return this.#closed;
  }

  snapshotBytes() {
    return this.#bytes === null ? null : copyBytes(this.#bytes);
  }

  replaceBytesForTest(bytes) {
    this.#bytes = bytes === null ? null : copyBytes(bytes);
    this.#revision += 1;
  }

  async runExclusive(operation) {
    if (this.#admissionClosed) throw new Error("store admission is closed");
    assert.equal(typeof operation, "function");
    this.runExclusiveCalls += 1;
    const preceding = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await preceding;
    const transactionIdentity = Object.freeze({});
    let active = true;
    const readCurrent = () => {
      if (!active) throw new Error("transaction is no longer active");
      const revision = Object.freeze({});
      this.#revisionOwners.set(revision, {
        transactionIdentity,
        revision: this.#revision,
      });
      return this.#bytes === null
        ? { outcome: "missing", revision }
        : { outcome: "present", revision, bytes: copyBytes(this.#bytes) };
    };
    const defaultPublish = (expected, next) => {
      const owner = this.#revisionOwners.get(expected);
      if (!owner || owner.transactionIdentity !== transactionIdentity) {
        throw new Error("revision is not owned by this transaction");
      }
      if (this.#bytes !== null && sameBytes(this.#bytes, next)) {
        return { outcome: "already_same", current: readCurrent() };
      }
      if (owner.revision !== this.#revision) {
        return { outcome: "conflict", current: readCurrent() };
      }
      this.#bytes = copyBytes(next);
      this.#revision += 1;
      return { outcome: "swapped", current: readCurrent() };
    };
    const transaction = Object.freeze({
      read: async () => {
        this.readCalls += 1;
        return readCurrent();
      },
      compareAndPublish: async (expected, next) => {
        if (!active) throw new Error("transaction is no longer active");
        assert.equal(next instanceof Uint8Array, true);
        this.compareAndPublishCalls += 1;
        if (this.onCompareAndPublish) {
          return await this.onCompareAndPublish({
            expected,
            next: copyBytes(next),
            readCurrent,
            defaultPublish: () => defaultPublish(expected, next),
          });
        }
        return defaultPublish(expected, next);
      },
    });
    try {
      return await operation(transaction);
    } finally {
      active = false;
      release();
    }
  }

  close() {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#admissionClosed = true;
    this.closeCalls += 1;
    const admitted = this.#tail;
    this.#closePromise = (async () => {
      await admitted;
      if (this.onClose) await this.onClose();
      this.#closed = true;
    })();
    return this.#closePromise;
  }
}
