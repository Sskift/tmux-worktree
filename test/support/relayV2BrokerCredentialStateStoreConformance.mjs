function utf8(value) {
  return Buffer.from(value, "utf8");
}

function errorCode(expected) {
  return (error) => error?.code === expected;
}

/**
 * Registers authority-facing port behavior against an adapter factory. Native
 * lanes can reuse this harness with isolated storage and native fault hooks;
 * an in-memory invocation is contract-model evidence only.
 */
export function registerRelayV2BrokerCredentialStateStoreConformance({
  test,
  assert,
  stateStore,
  label,
  createContext,
}) {
  test(`${label}: revisions, current snapshots, and byte ownership are closed`, async () => {
    const context = createContext();
    const opened = await context.open();
    assert.equal(opened.status, "opened");
    assert.equal(opened.selfCheck, "passed");
    const store = opened.store;
    let escapedRevision;
    let escapedTransaction;

    await store.runExclusive(async (transaction) => {
      escapedTransaction = transaction;
      const missing = await transaction.read();
      assert.equal(missing.outcome, "missing");
      assert.deepEqual(Object.keys(missing.revision), []);
      assert.throws(
        () => JSON.stringify(missing.revision),
        errorCode("INVALID_REVISION"),
      );
      escapedRevision = missing.revision;
      await assert.rejects(
        transaction.compareAndPublish(Object.freeze({}), utf8("forged")),
        errorCode("INVALID_REVISION"),
      );

      const swapped = await transaction.compareAndPublish(missing.revision, utf8("alpha"));
      assert.equal(swapped.outcome, "swapped");
      assert.equal(Buffer.from(swapped.current.bytes).toString("utf8"), "alpha");
      swapped.current.bytes[0] ^= 1;

      const same = await transaction.compareAndPublish(missing.revision, utf8("alpha"));
      assert.equal(same.outcome, "already_same");
      assert.equal(Buffer.from(same.current.bytes).toString("utf8"), "alpha");

      const conflict = await transaction.compareAndPublish(missing.revision, utf8("beta"));
      assert.equal(conflict.outcome, "conflict");
      assert.equal(conflict.current.outcome, "present");
      assert.equal(Buffer.from(conflict.current.bytes).toString("utf8"), "alpha");

      const reconciled = await transaction.compareAndPublish(
        conflict.current.revision,
        utf8("beta"),
      );
      assert.equal(reconciled.outcome, "swapped");
      assert.equal(Buffer.from(reconciled.current.bytes).toString("utf8"), "beta");
    });

    await assert.rejects(escapedTransaction.read(), errorCode("INVALID_REVISION"));
    await assert.rejects(
      store.runExclusive((transaction) => (
        transaction.compareAndPublish(escapedRevision, utf8("escaped"))
      )),
      errorCode("INVALID_REVISION"),
    );

    await store.runExclusive(async (transaction) => {
      const present = await transaction.read();
      assert.equal(Buffer.from(present.bytes).toString("utf8"), "beta");
      present.bytes.fill(0);
    });
    await store.runExclusive(async (transaction) => {
      const present = await transaction.read();
      assert.equal(Buffer.from(present.bytes).toString("utf8"), "beta");
    });

    const captured = context.deferred();
    const release = context.deferred();
    context.armPublishCapture(async () => {
      captured.resolve();
      await release.promise;
    });
    const callerBytes = utf8("captured-before-await");
    const publishing = store.runExclusive(async (transaction) => {
      const present = await transaction.read();
      return transaction.compareAndPublish(present.revision, callerBytes);
    });
    await captured.promise;
    callerBytes.fill(0);
    release.resolve();
    const published = await publishing;
    assert.equal(published.outcome, "swapped");
    assert.equal(
      Buffer.from(published.current.bytes).toString("utf8"),
      "captured-before-await",
    );
    await store.close();
  });

  test(`${label}: uncertain terminal-closes the instance until close and explicit reopen`, async () => {
    const context = createContext();
    const opened = await context.open();
    const store = opened.store;

    context.armUncertain("after");
    let poisonedTransaction;
    const uncertain = await store.runExclusive(async (transaction) => {
      poisonedTransaction = transaction;
      const before = await transaction.read();
      const outcome = await transaction.compareAndPublish(
        before.revision,
        utf8("possibly-committed"),
      );
      assert.deepEqual(outcome, { outcome: "uncertain" });
      await assert.rejects(transaction.read(), errorCode("STORE_CLOSED"));
      return outcome;
    });
    assert.deepEqual(uncertain, { outcome: "uncertain" });
    assert.equal(context.publicationAttempts(), 1, "wrapper never retries uncertain publish");
    await assert.rejects(poisonedTransaction.read(), errorCode("STORE_CLOSED"));
    await assert.rejects(store.runExclusive(() => undefined), errorCode("STORE_CLOSED"));

    await store.close();
    const reopened = await context.open();
    assert.equal(reopened.status, "opened");
    assert.equal(reopened.selfCheck, "passed");
    assert.notStrictEqual(reopened.store, store);
    await reopened.store.runExclusive(async (transaction) => {
      const observed = await transaction.read();
      assert.equal(observed.outcome, "present");
      assert.equal(Buffer.from(observed.bytes).toString("utf8"), "possibly-committed");
    });
    assert.equal(context.publicationAttempts(), 1, "reopen does not replay publication");
    await reopened.store.close();
  });

  test(`${label}: ordinary close rejects admission but preserves admitted transaction work`, async () => {
    const context = createContext();
    const opened = await context.open();
    const store = opened.store;
    const entered = context.deferred();
    const release = context.deferred();
    let admittedTransaction;
    const active = store.runExclusive(async (transaction) => {
      admittedTransaction = transaction;
      entered.resolve();
      await release.promise;
      const current = await transaction.read();
      return transaction.compareAndPublish(current.revision, utf8("during-close"));
    });
    await entered.promise;

    const close = store.close();
    assert.strictEqual(store.close(), close);
    let closeSettled = false;
    close.then(() => { closeSettled = true; });
    await Promise.resolve();
    assert.equal(closeSettled, false);
    await assert.rejects(store.runExclusive(() => undefined), errorCode("STORE_CLOSED"));

    release.resolve();
    const published = await active;
    assert.equal(published.outcome, "swapped");
    await close;
    assert.equal(context.nativeClosed(), true);
    await assert.rejects(admittedTransaction.read(), errorCode("INVALID_REVISION"));
  });
}
