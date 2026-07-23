import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const terminalControl = await import("../dist/terminalControl/index.js");
const compound = await import(
  "../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);
const bytePlaneModule = await import(
  "../dist/relay/v2/terminalControlObservedBytePlaneAdapter.js"
);
const authorityAdapterModule = await import(
  "../dist/relay/v2/terminalControlAuthorityAdapter.js"
);
const transportModule = await import(
  "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js"
);
const backendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");

const INCARNATION = `twinc2.${"A".repeat(43)}`;
const PROCESS_TARGET = Object.freeze({ kind: "ssh", targetId: "configured-devbox" });
const RESERVATION_OWNER = Object.freeze({
  kind: "relay-v2",
  instanceId: "relay-v2-byte-plane-reservation",
});
const CONSUMER_OWNER = Object.freeze({
  kind: "relay-v2",
  instanceId: "relay-v2-byte-plane-consumer",
});
const AUTH = Object.freeze({
  principalId: "byte-plane-principal",
  clientInstanceId: "byte-plane-client",
});
const EXACT_EFFECT_BRAND = Symbol.for("tmux-worktree.relay-v2.terminal-exact-effect-target");

class ByteQueue {
  values = [];
  waiters = [];
  ended = false;

  push(value) {
    assert.equal(this.ended, false);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: Uint8Array.from(value), done: false });
    else this.values.push(Uint8Array.from(value));
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function sshTarget() {
  return {
    kind: "ssh",
    targetId: PROCESS_TARGET.targetId,
    host: "devbox.example.com",
    knownHostsFile: "/configured/ssh/known_hosts",
    sshExecutable: "/usr/bin/ssh",
    user: "builder",
    port: 2222,
    identityFile: "/configured/ssh/id_ed25519",
    twExecutable: "/opt/tw/bin/tw",
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function makeExactInput(suffix) {
  return {
    schemaVersion: 1,
    hostId: `host-${suffix}`,
    scopeId: `scope-${suffix}`,
    sessionId: `session-${suffix}`,
    pane: 0,
    processTarget: { ...PROCESS_TARGET },
    backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: PROCESS_TARGET,
      incarnation: INCARNATION,
    }),
    managedTarget: {
      name: `managed-${suffix}`,
      kind: "worktree",
      incarnation: INCARNATION,
    },
  };
}

function exactEffectTarget(input, evidence) {
  return {
    schemaVersion: 1,
    resolvedTarget: {
      hostId: input.hostId,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      pane: input.pane,
      canonicalTargetId: input.backendInstanceKey,
      controlTargetId: evidence.exactControlIdentity.controlTargetId,
    },
    binding: {
      ...structuredClone(input),
      exactControlIdentity: structuredClone(evidence.exactControlIdentity),
    },
    [EXACT_EFFECT_BRAND]: true,
  };
}

function observingBackend(calls, {
  managedName,
  failTail,
  failInspectAtCall,
  dataTailDelayMs,
  onDataTailEnter,
}) {
  let output = Buffer.alloc(0);
  return {
    append(text) {
      output = Buffer.concat([output, Buffer.from(text, "utf8")]);
    },
    async inspectExactTarget() {
      calls.inspect += 1;
      if (failInspectAtCall !== undefined && calls.inspect === failInspectAtCall) {
        throw new Error("injected exact target inspection failure");
      }
      return {
        managedSession: {
          name: managedName,
          kind: "worktree",
          profile: "cli",
          cwd: "/repo",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
        managedIncarnation: INCARNATION,
        tmuxInstanceId: "tmux-instance-byte-plane",
        paneIdentity: "%5",
      };
    },
    async resolveManagedSession() {
      throw new Error("name-only resolution must not run");
    },
    async assertCurrent() {},
    async prepareOutput() {
      return { generation: "output-generation-one", cursor: output.byteLength };
    },
    async resetOutput() {
      calls.reset += 1;
      output = Buffer.alloc(0);
      return { generation: "output-generation-two", cursor: 0 };
    },
    async tailOutput(_target, _session, _pane, generation, cursor, maxBytes) {
      if (failTail?.() === true
        || generation !== "output-generation-one"
        || cursor > output.byteLength) {
        throw new terminalControl.TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "observation cursor is fenced",
        );
      }
      const chunk = output.subarray(cursor, cursor + maxBytes);
      if (chunk.byteLength > 0 && dataTailDelayMs !== undefined) {
        onDataTailEnter?.();
        await new Promise((resolve) => setTimeout(resolve, dataTailDelayMs));
      }
      return {
        generation,
        cursor,
        dataBase64: chunk.toString("base64"),
        nextCursor: cursor + chunk.byteLength,
      };
    },
    async writeRaw(_name, _pane, data) {
      calls.writeRaw += 1;
      output = Buffer.concat([output, Buffer.from(data)]);
    },
    async sendAgentMessage() {
      throw new Error("the byte plane must not send agent-message effects");
    },
    async resize() {
      throw new Error("the byte plane must not resize");
    },
    async scroll() {
      throw new Error("the byte plane must not scroll");
    },
    async killManaged() {
      throw new Error("the byte plane must not kill");
    },
  };
}

async function openStack(label, backend) {
  const root = mkdtempSync(join(tmpdir(), `tw-relay-v2-byte-plane-${label}-`));
  const statePath = join(root, "terminal-control-state-v1.json");
  terminalControl.saveTerminalControlState({
    version: 1,
    controlEpoch: "byte-plane-epoch",
    targets: [{
      controlTargetId: `control-target-${label}`,
      lifecycle: "ACTIVE",
      managedSession: {
        name: `managed-${label}`,
        kind: "worktree",
        createdAt: "2026-07-22T00:00:00.000Z",
      },
      backend: { kind: "tmux", tmuxInstanceId: "tmux-instance-byte-plane" },
      outputGeneration: "output-generation-one",
      ownership: { state: "FREE", fence: "0" },
      revision: "1",
      completedOperations: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
  }, statePath);
  const protocolFrames = [];
  const invocations = [];
  const compoundRunner = {
    spawnCompound(request) {
      invocations.push({ ...request, argv: [...request.argv] });
      const input = new ByteQueue();
      const stdout = new ByteQueue();
      const stderr = new ByteQueue();
      const server = compound.runRelayV2RemoteExactCompoundServerV1({
        source: input,
        async write(frame) { stdout.push(frame); },
        async openOwner(processTarget) {
          assert.deepEqual(processTarget, PROCESS_TARGET);
          const authority = new terminalControl.TerminalControlAuthority({
            statePath,
            backend,
            relayV2ProcessTarget: processTarget,
          });
          await authority.initializeContinuity();
          let closed = false;
          return {
            authority,
            async close() {
              if (closed) return;
              closed = true;
              await authority.closeRelayV2ExactTargetAuthority();
            },
          };
        },
      }).then(
        () => ({ exitCode: 0, signal: null }),
        (error) => ({ exitCode: 1, signal: null, error }),
      ).finally(() => {
        stdout.end();
        stderr.end();
      });
      return {
        stdin: {
          async write(frame) {
            protocolFrames.push(JSON.parse(Buffer.from(frame).toString("utf8")));
            input.push(frame);
          },
          end() { input.end(); },
        },
        stdout,
        stderr,
        exited: server,
        kill() { input.end(); },
      };
    },
  };
  const queryTransport = new transportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [sshTarget()],
    runner: { spawn() { throw new Error("the byte plane must not run discovery"); } },
  });
  const remote = new compound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
    channels: queryTransport.captureRemoteExactCompoundChannelFactory(compoundRunner),
    owner: RESERVATION_OWNER,
  });
  return { root, statePath, protocolFrames, invocations, remote };
}

function frameSequence(protocolFrames) {
  return protocolFrames.map((frame) => (
    frame.type === "effect" ? `effect:${frame.request.type}` : frame.type
  ));
}

function foreignObservation(label) {
  return Object.freeze({
    schemaVersion: 1,
    controlTargetId: `control-${label}`,
    controlEpoch: `epoch-${label}`,
    targetIncarnationProof: `proof-${label}`,
    outputGeneration: `generation-${label}`,
    outputCursor: 0,
  });
}

function foreignTarget(label) {
  return exactEffectTarget(makeExactInput(label), {
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: `control-${label}`,
      controlEpoch: `epoch-${label}`,
      targetIncarnationProof: `proof-${label}`,
    },
  });
}

function fakeExactPort({ label, tail, prepare, close, observe }) {
  let pinned;
  return {
    async observePreparedTargetForBinding(binding) {
      if (observe !== undefined) return observe();
      pinned = binding === undefined
        ? foreignObservation(label)
        : Object.freeze({
          schemaVersion: 1,
          controlTargetId: binding.exactControlIdentity.controlTargetId,
          controlEpoch: binding.exactControlIdentity.controlEpoch,
          targetIncarnationProof: binding.exactControlIdentity.targetIncarnationProof,
          outputGeneration: `generation-${label}`,
          outputCursor: 0,
        });
      return pinned;
    },
    async tailObservedTarget() {
      return tail(pinned);
    },
    async prepareObservedTargetLease() {
      if (prepare !== undefined) return prepare();
      throw new Error("unexpected lease preparation");
    },
    fenceExactTargetForAdmission() {
      throw new Error("unexpected fence");
    },
    async consumePreparedLeaseForBinding() {
      throw new Error("unexpected consume");
    },
    async closeObservedTarget() {
      return close?.();
    },
  };
}

test("observed byte plane tails the exact observation and lazily reclaims the lease on one channel", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  const backend = observingBackend(calls, { managedName: "managed-lifecycle" });
  const stack = await openStack("lifecycle", backend);
  const { remote, protocolFrames, invocations, statePath } = stack;
  const input = makeExactInput("lifecycle");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const control = new authorityAdapterModule.RelayV2TerminalControlAuthorityAdapter(
      remote,
      bytePlane.lazyLeasePort,
    );
    const events = [];
    const handle = await bytePlane.open(
      target,
      { maxChunkBytes: 4, displaySizeHint: { cols: 80, rows: 24 } },
      {
        async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
        async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
      },
    );
    const delivered = () => Buffer.concat(
      events.filter((event) => event.kind === "bytes").map((event) => event.data),
    ).toString("utf8");
    // Open consumed the admitted claim into a read-only observation: no producer
    // lease is held, no second channel exists, and no generic lease.acquire ran.
    assert.equal(
      terminalControl.loadTerminalControlState(statePath).targets[0].ownership.state,
      "FREE",
      "the observation holds no input ownership",
    );
    assert.equal(invocations.length, 1);

    backend.append("abcdef");
    await waitFor(() => delivered() === "abcdef", "observation tail did not deliver");
    assert.deepEqual(
      events.map((event) => event.data.toString("utf8")),
      ["abcd", "ef"],
      "the tail delivers in order from the observation cursor within maxChunkBytes",
    );

    // The first input reclaims the lease lazily through the byte-plane port on
    // the same channel, re-proving the original controlEpoch.
    const acquired = await control.acquire({ target, auth: AUTH, owner: CONSUMER_OWNER });
    assert.equal(acquired.status, "accepted");
    assert.equal(
      acquired.lease.controlEpoch,
      evidence.exactControlIdentity.controlEpoch,
      "the lazy lease must re-prove the open-time control epoch",
    );
    assert.deepEqual(acquired.lease.owner, CONSUMER_OWNER);
    assert.deepEqual(await control.writeInput({
      target,
      auth: AUTH,
      owner: CONSUMER_OWNER,
      lease: acquired.lease,
      operationId: "byte-plane-write-one",
      data: Buffer.from("hi", "utf8"),
    }), { accepted: true });
    assert.equal(calls.writeRaw, 1);
    await waitFor(() => delivered() === "abcdefhi", "tail stalled while the lease was held");

    await control.release({
      target,
      auth: AUTH,
      owner: CONSUMER_OWNER,
      lease: acquired.lease,
    });
    assert.equal(
      terminalControl.loadTerminalControlState(statePath).targets[0].ownership.state,
      "FREE",
    );
    assert.equal(calls.reset, 0, "release must not reset the observed output generation");

    // The release returns the channel to observing and the tail continues.
    backend.append("xy");
    await waitFor(() => delivered() === "abcdefhixy", "tail did not continue after release");

    const closing = handle.close();
    assert.equal(handle.close(), closing, "handle close is idempotent");
    await closing;
    assert.equal(calls.reset, 1, "close-observe runs the deferred reset exactly once");
    const framesAfterClose = protocolFrames.length;
    const eventsAfterClose = events.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(protocolFrames.length, framesAfterClose, "the pump never tails after close");
    assert.equal(events.length, eventsAfterClose, "fenced callbacks never fire after close");
    assert.equal(
      events.some((event) => event.kind === "closed"),
      false,
      "a consumer-initiated close delivers no onClosed",
    );

    const sequence = frameSequence(protocolFrames);
    assert.deepEqual(
      sequence.filter((type) => type !== "tail"),
      ["prepare", "observe", "prepare", "admit", "effect:input.raw", "effect:lease.release", "close-observe"],
      "claim, observation, lazy lease, effect, release, and close share one order",
    );
    const admitIndex = sequence.indexOf("admit");
    assert.ok(
      sequence.slice(0, admitIndex).includes("tail"),
      "the observation tail precedes the lazy lease",
    );
    const releaseIndex = sequence.indexOf("effect:lease.release");
    assert.ok(
      sequence.slice(releaseIndex + 1, -1).includes("tail"),
      "the observation tail resumes after the release",
    );
    assert.equal(sequence.at(-1), "close-observe", "no frame follows the observation close");
    assert.equal(JSON.stringify(protocolFrames).includes("lease.acquire"), false);
    assert.equal(invocations.length, 1, "everything stays on one canonical child");

    await bytePlane.close();
    await assert.rejects(
      bytePlane.open(target, { maxChunkBytes: 4, displaySizeHint: { cols: 80, rows: 24 } }, {
        async onBytes() {},
        async onClosed() {},
      }),
      (error) => error?.code === "RESOURCE_EXHAUSTED",
      "a closed byte plane fences new attachments",
    );
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test("a fenced observation tail fails closed exactly once and never retries", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  let failTail = false;
  const backend = observingBackend(calls, {
    managedName: "managed-fenced",
    failTail: () => failTail,
  });
  const stack = await openStack("fenced", backend);
  const { remote, protocolFrames, invocations } = stack;
  const input = makeExactInput("fenced");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const control = new authorityAdapterModule.RelayV2TerminalControlAuthorityAdapter(
      remote,
      bytePlane.lazyLeasePort,
    );
    const events = [];
    await bytePlane.open(
      target,
      { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
      {
        async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
        async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
      },
    );
    backend.append("chunk-one");
    await waitFor(
      () => events.some((event) => event.kind === "bytes"),
      "tail did not deliver before the fence",
    );

    failTail = true;
    await waitFor(
      () => events.some((event) => event.kind === "closed"),
      "a fenced tail did not close the attachment",
    );
    assert.deepEqual(
      events.map((event) => event.kind),
      ["bytes", "closed"],
      "onClosed follows the final onBytes",
    );
    assert.deepEqual(events[1].result, { reason: "backend_error", exitCode: null });
    const tailsAtClose = protocolFrames.filter((frame) => frame.type === "tail").length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      protocolFrames.filter((frame) => frame.type === "tail").length,
      tailsAtClose,
      "a fenced tail never retries",
    );
    assert.equal(
      events.filter((event) => event.kind === "closed").length,
      1,
      "onClosed is delivered exactly once",
    );

    // The fenced observation cannot reclaim a lease or open a fallback channel.
    const lateAcquire = await control.acquire({ target, auth: AUTH, owner: CONSUMER_OWNER });
    assert.equal(lateAcquire.status, "rejected");
    assert.equal(invocations.length, 1, "no fallback channel is spawned");

    // The fence also drains the observation behind the dropped handle: the
    // compound owner already retired its record on the fencing tail error, so
    // cleanup confirms silently and adapter close resolves without a retry.
    await bytePlane.close();
    assert.equal(
      events.filter((event) => event.kind === "closed").length,
      1,
      "adapter close never redelivers onClosed",
    );
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }

  // An onBytes rejection takes the same fail-closed path: the fenced
  // observation is cleaned behind the dropped handle, onClosed fires once,
  // and adapter close never repeats a completed cleanup.
  let rejectCloseAttempts = 0;
  let rejectChunkDelivered = false;
  const rejectPlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: fakeExactPort({
      label: "reject",
      tail: (obs) => {
        if (rejectChunkDelivered) {
          return Object.freeze({
            controlEpoch: obs.controlEpoch,
            outputGeneration: obs.outputGeneration,
            cursor: 1,
            dataBase64: "",
            nextCursor: 1,
          });
        }
        rejectChunkDelivered = true;
        return Object.freeze({
          controlEpoch: obs.controlEpoch,
          outputGeneration: obs.outputGeneration,
          cursor: 0,
          dataBase64: Buffer.from("x", "utf8").toString("base64"),
          nextCursor: 1,
        });
      },
      close: () => { rejectCloseAttempts += 1; },
    }),
    idlePollMs: 2,
  });
  const rejectEvents = [];
  await rejectPlane.open(
    foreignTarget("reject"),
    { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
    {
      async onBytes() { throw new Error("consumer failure"); },
      async onClosed(result) { rejectEvents.push({ kind: "closed", result: { ...result } }); },
    },
  );
  await waitFor(
    () => rejectEvents.some((event) => event.kind === "closed"),
    "an onBytes rejection did not fail closed",
  );
  await waitFor(
    () => rejectCloseAttempts === 1,
    "an onBytes rejection never cleaned the fenced observation",
  );
  assert.equal(rejectEvents.length, 1, "onClosed is delivered exactly once");
  await rejectPlane.close();
  assert.equal(
    rejectCloseAttempts,
    1,
    "adapter close never repeats a completed cleanup",
  );
  assert.equal(
    rejectEvents.length,
    1,
    "adapter close never redelivers onClosed",
  );
});

test("open snapshots foreign input once and rejects malformed shapes before any frame", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  const backend = observingBackend(calls, { managedName: "managed-snapshot" });
  const stack = await openStack("snapshot", backend);
  const { remote, protocolFrames, invocations } = stack;
  const input = makeExactInput("snapshot");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const goodOptions = { maxChunkBytes: 4, displaySizeHint: { cols: 80, rows: 24 } };
    const observed = { delivered: [], closedWith: null, receiverOk: true };
    const goodObserver = {
      async onBytes(data) {
        if (this !== goodObserver) observed.receiverOk = false;
        observed.delivered.push(Buffer.from(data));
      },
      async onClosed(result) {
        if (this !== goodObserver) observed.receiverOk = false;
        observed.closedWith = result;
      },
    };
    const nonEnumerableBinding = structuredClone(target.binding);
    Object.defineProperty(nonEnumerableBinding, "hidden", {
      value: "x",
      enumerable: false,
    });
    const malformedAttempts = [
      { ...target, binding: new Proxy(structuredClone(target.binding), {}) },
      {
        ...target,
        binding: {
          ...structuredClone(target.binding),
          get hostId() { return target.binding.hostId; },
        },
      },
      { ...target, binding: nonEnumerableBinding },
    ];
    for (const malformedTarget of malformedAttempts) {
      await assert.rejects(
        bytePlane.open(malformedTarget, goodOptions, goodObserver),
        (error) => error?.code === "PERMISSION_DENIED",
      );
    }
    await assert.rejects(
      bytePlane.open(target, { ...goodOptions, unexpected: true }, goodObserver),
      (error) => error?.code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      bytePlane.open(target, goodOptions, new Proxy(goodObserver, {})),
      (error) => error?.code === "PERMISSION_DENIED",
    );
    assert.deepEqual(
      frameSequence(protocolFrames),
      ["prepare"],
      "a rejected open never consumes the admitted claim or touches the channel",
    );

    // A valid open still consumes the intact claim, and the observer keeps its
    // original receiver for every callback.
    const handle = await bytePlane.open(target, goodOptions, goodObserver);
    backend.append("abcd");
    await waitFor(() => observed.delivered.length === 1, "snapshot open did not tail");
    assert.equal(observed.delivered[0].toString("utf8"), "abcd");

    // The lazy lease port snapshots binding and owner before touching the
    // record: malformed values fail without a frame and leave the attachment
    // alive.
    const control = new authorityAdapterModule.RelayV2TerminalControlAuthorityAdapter(
      remote,
      bytePlane.lazyLeasePort,
    );
    const framesBefore = protocolFrames.length;
    await assert.rejects(
      bytePlane.lazyLeasePort.consumePreparedLeaseForBinding(
        target.binding,
        new Proxy({ kind: "relay-v2", instanceId: "foreign-owner" }, {}),
      ),
      (error) => error?.code === "PERMISSION_DENIED",
      "a Proxy owner never reaches the lease preparation",
    );
    const foreignBindingTarget = {
      ...target,
      binding: new Proxy(structuredClone(target.binding), {}),
    };
    assert.equal(
      (await control.acquire({ target: foreignBindingTarget, auth: AUTH, owner: CONSUMER_OWNER }))
        .status,
      "rejected",
      "a Proxy binding fails closed at the byte-plane boundary",
    );
    assert.equal(protocolFrames.length, framesBefore, "malformed lease input sends no frame");
    backend.append("ef");
    await waitFor(() => observed.delivered.length === 2, "attachment was fenced by input rejection");
    assert.equal(observed.delivered[1].toString("utf8"), "ef");
    assert.equal(observed.closedWith, null);

    await handle.close();
    assert.equal(observed.receiverOk, true, "every callback kept the original receiver");
    assert.equal(invocations.length, 1);
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test("a failed lazy lease fences the attachment once, stays fenced, and cleans the claim", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  // The third inspection is the lazy lease re-preparation on the same channel;
  // it must fail the whole attachment closed rather than leave a live claim.
  const backend = observingBackend(calls, {
    managedName: "managed-lazy-fence",
    failInspectAtCall: 3,
  });
  const stack = await openStack("lazy-fence", backend);
  const { remote, protocolFrames, invocations } = stack;
  const input = makeExactInput("lazy-fence");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const control = new authorityAdapterModule.RelayV2TerminalControlAuthorityAdapter(
      remote,
      bytePlane.lazyLeasePort,
    );
    const events = [];
    await bytePlane.open(
      target,
      { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
      {
        async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
        async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
      },
    );
    backend.append("before");
    await waitFor(() => events.some((event) => event.kind === "bytes"), "tail did not start");

    const acquired = await control.acquire({ target, auth: AUTH, owner: CONSUMER_OWNER });
    assert.equal(acquired.status, "uncertain", "the failed re-preparation stays in doubt");
    await waitFor(
      () => events.some((event) => event.kind === "closed"),
      "lazy lease failure did not fence the attachment",
    );
    assert.deepEqual(events[events.length - 1].result, { reason: "backend_error", exitCode: null });
    const tailsAtFence = protocolFrames.filter((frame) => frame.type === "tail").length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      protocolFrames.filter((frame) => frame.type === "tail").length,
      tailsAtFence,
      "the fenced pump never retries a tail",
    );
    assert.equal(
      events.filter((event) => event.kind === "closed").length,
      1,
      "onClosed is delivered exactly once",
    );

    // The record is not re-enterable and no fallback channel appears.
    assert.equal(
      (await control.acquire({ target, auth: AUTH, owner: CONSUMER_OWNER })).status,
      "rejected",
    );
    assert.equal(invocations.length, 1);
    await bytePlane.close();
    assert.equal(
      events.filter((event) => event.kind === "closed").length,
      1,
      "cleanup never redelivers onClosed",
    );
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test("pause buffers one in-order chunk until resume and close discards the buffer", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  const backend = observingBackend(calls, { managedName: "managed-pause" });
  const stack = await openStack("pause", backend);
  const { remote, protocolFrames } = stack;
  const input = makeExactInput("pause");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const events = [];
    const handle = await bytePlane.open(
      target,
      { maxChunkBytes: 4, displaySizeHint: { cols: 80, rows: 24 } },
      {
        async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
        async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
      },
    );
    const delivered = () => events
      .filter((event) => event.kind === "bytes")
      .map((event) => event.data.toString("utf8"));

    backend.append("abcd");
    await waitFor(() => delivered().length === 1, "first chunk was not delivered");

    await handle.pause();
    backend.append("efgh");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(delivered(), ["abcd"], "no onBytes starts while paused");

    await handle.resume();
    await waitFor(() => delivered().length === 2, "buffered chunk was not resumed");
    assert.deepEqual(delivered(), ["abcd", "efgh"], "the buffered chunk keeps source order");

    await handle.pause();
    backend.append("zz");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closing = handle.close();
    await handle.resume();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(delivered(), ["abcd", "efgh"], "close discards the paused buffer");
    assert.equal(
      events.some((event) => event.kind === "closed"),
      false,
      "a consumer-initiated close delivers no onClosed",
    );
    assert.equal(frameSequence(protocolFrames).at(-1), "close-observe");
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test("close settles the in-flight tail on the bounded channel request before close-observe", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  let dataTailEntered = false;
  const backend = observingBackend(calls, {
    managedName: "managed-bounded-close",
    dataTailDelayMs: 60,
    onDataTailEnter: () => { dataTailEntered = true; },
  });
  const stack = await openStack("bounded-close", backend);
  const { remote, protocolFrames } = stack;
  const input = makeExactInput("bounded-close");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const events = [];
    const handle = await bytePlane.open(
      target,
      { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
      {
        async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
        async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
      },
    );
    backend.append("slow-chunk");
    await waitFor(() => dataTailEntered, "the data tail never entered the channel");
    const closing = handle.close();
    assert.equal(handle.close(), closing, "handle close is idempotent");
    await closing;
    const sequence = frameSequence(protocolFrames);
    assert.equal(sequence.at(-1), "close-observe");
    assert.ok(
      sequence.slice(0, -1).includes("tail"),
      "the bounded in-flight tail settles before the observation close",
    );
    assert.equal(
      events.some((event) => event.kind === "closed"),
      false,
      "a consumer-initiated close delivers no onClosed",
    );
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test("hint bounds are enforced strictly and a malformed chunk fails closed without delivery", async () => {
  const calls = { inspect: 0, reset: 0, writeRaw: 0 };
  const backend = observingBackend(calls, { managedName: "managed-limits" });
  const stack = await openStack("limits", backend);
  const { remote, protocolFrames } = stack;
  const input = makeExactInput("limits");
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: remote,
    idlePollMs: 2,
  });
  try {
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const target = exactEffectTarget(input, evidence);
    const observer = { async onBytes() {}, async onClosed() {} };
    for (const displaySizeHint of [
      { cols: 1001, rows: 24 },
      { cols: 80, rows: 501 },
    ]) {
      await assert.rejects(
        bytePlane.open(target, { maxChunkBytes: 4, displaySizeHint }, observer),
        (error) => error?.code === "INVALID_REQUEST",
      );
    }
    await assert.rejects(
      bytePlane.open(
        target,
        { maxChunkBytes: 384 * 1024 + 1, displaySizeHint: { cols: 80, rows: 24 } },
        observer,
      ),
      (error) => error?.code === "PERMISSION_DENIED",
    );
    assert.deepEqual(frameSequence(protocolFrames), ["prepare"]);

    const handle = await bytePlane.open(
      target,
      { maxChunkBytes: 4, displaySizeHint: { cols: 80, rows: 24 } },
      observer,
    );
    await assert.rejects(
      handle.setDisplaySizeHint({ cols: 1001, rows: 24 }),
      (error) => error?.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      handle.setDisplaySizeHint({ cols: 80, rows: 501 }),
      (error) => error?.code === "INVALID_REQUEST",
    );
    await handle.setDisplaySizeHint({ cols: 120, rows: 40 });
    await handle.close();
  } finally {
    await bytePlane.close().catch(() => undefined);
    await remote.close().catch(() => undefined);
    rmSync(stack.root, { recursive: true, force: true });
  }

  // A chunk that violates the byte-plane boundary never reaches the observer
  // and fails the attachment closed exactly once: no delivery, exactly one
  // tail, exactly one backend_error close.
  const canonicalChunk = (obs) => Object.freeze({
    controlEpoch: obs.controlEpoch,
    outputGeneration: obs.outputGeneration,
    cursor: 0,
    dataBase64: Buffer.from("hi", "utf8").toString("base64"),
    nextCursor: 2,
  });
  const accessorChunk = (obs) => {
    const chunk = { ...canonicalChunk(obs) };
    Object.defineProperty(chunk, "nextCursor", {
      get() { return 2; },
      enumerable: true,
    });
    return chunk;
  };
  const malformedChunks = [
    ["proxy", (obs) => new Proxy(canonicalChunk(obs), {})],
    ["accessor", accessorChunk],
    ["extra-key", (obs) => ({ ...canonicalChunk(obs), unexpected: true })],
    ["noncanonical-base64", (obs) => ({ ...canonicalChunk(obs), dataBase64: "aGk" })],
    ["cursor-gap", (obs) => ({ ...canonicalChunk(obs), nextCursor: 3 })],
    ["non-integer-cursor", (obs) => ({ ...canonicalChunk(obs), nextCursor: Number.NaN })],
    ["oversize-encoded", (obs) => ({
      ...canonicalChunk(obs),
      dataBase64: "A".repeat(4 * (Math.ceil(64 / 3) + 1)),
    })],
  ];
  let tailCalls = 0;
  let badChunk = canonicalChunk;
  const foreignPlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: fakeExactPort({
      label: "foreign",
      tail: (obs) => {
        tailCalls += 1;
        return badChunk(obs);
      },
    }),
    idlePollMs: 2,
  });
  for (const [label, chunk] of malformedChunks) {
    badChunk = chunk;
    const events = [];
    await foreignPlane.open(
      foreignTarget(`foreign-${label}`),
      { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
      {
        async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
        async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
      },
    );
    await waitFor(
      () => events.some((event) => event.kind === "closed"),
      `${label} chunk did not fail closed`,
    );
    assert.deepEqual(events.map((event) => event.kind), ["closed"], label);
    assert.deepEqual(events[0].result, { reason: "backend_error", exitCode: null }, label);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tailCalls, malformedChunks.length, "a malformed chunk is never retried");
  await foreignPlane.close();

  // The open-time observation cut faces the same boundary: a foreign shape or
  // a binding correlation mismatch is rejected before any record or tail.
  for (const [label, observe] of [
    ["proxy-observation", () => new Proxy(foreignObservation("cut-proxy-observation"), {})],
    ["mismatched-observation", () => ({
      ...foreignObservation("cut-mismatched-observation"),
      controlEpoch: "epoch-other",
    })],
  ]) {
    const cutPlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
      exactTargets: fakeExactPort({
        label: `cut-${label}`,
        observe,
        tail: () => { throw new Error("a rejected observation cut never tails"); },
      }),
      idlePollMs: 2,
    });
    await assert.rejects(
      cutPlane.open(
        foreignTarget(`cut-${label}`),
        { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
        { async onBytes() {}, async onClosed() {} },
      ),
      (error) => error?.code === "PERMISSION_DENIED",
      label,
    );
    await cutPlane.close();
  }
});

test("a failed observation cleanup retains the fenced record for an explicit re-drain", async () => {
  let consumeCalls = 0;
  let closeAttempts = 0;
  let closeFailures = 2;
  const port = fakeExactPort({
    label: "cleanup",
    tail: () => Object.freeze({
      controlEpoch: "epoch-cleanup",
      outputGeneration: "generation-cleanup",
      cursor: 0,
      dataBase64: "",
      nextCursor: 0,
    }),
    prepare: () => {
      throw new terminalControl.TerminalControlProtocolError(
        "OPERATION_IN_DOUBT",
        "injected preparation failure",
      );
    },
    close: () => {
      closeAttempts += 1;
      if (closeFailures > 0) {
        closeFailures -= 1;
        throw new terminalControl.TerminalControlProtocolError(
          "OPERATION_IN_DOUBT",
          "injected cleanup failure",
        );
      }
    },
  });
  port.consumePreparedLeaseForBinding = async () => {
    consumeCalls += 1;
    throw new Error("unexpected consume");
  };
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: port,
    idlePollMs: 2,
  });
  const target = foreignTarget("cleanup");
  const events = [];
  await bytePlane.open(
    target,
    { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
    {
      async onBytes(data) { events.push({ kind: "bytes", data: Buffer.from(data) }); },
      async onClosed(result) { events.push({ kind: "closed", result: { ...result } }); },
    },
  );

  // The lazy lease failure fails closed once and starts cleanup, which fails
  // too: the record must stay fenced, not re-enterable, and never redeliver.
  await assert.rejects(
    bytePlane.lazyLeasePort.consumePreparedLeaseForBinding(target.binding, CONSUMER_OWNER),
    (error) => error?.code === "OPERATION_IN_DOUBT",
  );
  await waitFor(
    () => events.some((event) => event.kind === "closed"),
    "lazy lease failure did not fence the attachment",
  );
  assert.deepEqual(events.map((event) => event.kind), ["closed"]);
  assert.equal(closeAttempts, 1, "cleanup starts at the failure and fails there");
  await assert.rejects(
    bytePlane.lazyLeasePort.consumePreparedLeaseForBinding(target.binding, CONSUMER_OWNER),
    (error) => error?.code === "PERMISSION_DENIED",
    "a fenced record is not re-enterable",
  );
  assert.equal(consumeCalls, 0, "a failed preparation is never re-consumed");

  // The retained record is re-drained explicitly: adapter.close() retries the
  // same cleanup, surfaces the still-failing attempt, and never drops it.
  await assert.rejects(
    bytePlane.close(),
    (error) => error?.code === "OPERATION_IN_DOUBT",
    "adapter close surfaces the unfinished cleanup",
  );
  assert.equal(closeAttempts, 2, "adapter close retried the same record");
  await bytePlane.close();
  assert.equal(closeAttempts, 3, "the retained record drains once the authority recovers");
  await bytePlane.close();
  assert.equal(closeAttempts, 3, "a drained record is never cleaned twice");
  assert.equal(
    events.filter((event) => event.kind === "closed").length,
    1,
    "onClosed is delivered exactly once across every retry",
  );
});

test("constructor snapshots options once and preserves the port receiver", async () => {
  const calls = { observe: 0, tail: 0 };
  const port = fakeExactPort({
    label: "constructor",
    tail: () => {
      calls.tail += 1;
      return Object.freeze({
        controlEpoch: "epoch-constructor",
        outputGeneration: "generation-constructor",
        cursor: 0,
        dataBase64: "",
        nextCursor: 0,
      });
    },
  });
  const observe = port.observePreparedTargetForBinding;
  port.observePreparedTargetForBinding = async function wrappedObserve() {
    calls.observe += Number(this === port);
    return observe();
  };
  const getterOptions = {};
  Object.defineProperty(getterOptions, "exactTargets", {
    get() { return port; },
    enumerable: true,
  });
  const accessorIdleOptions = { exactTargets: port };
  Object.defineProperty(accessorIdleOptions, "idlePollMs", {
    get() { return 2; },
    enumerable: true,
  });
  for (const malformed of [
    getterOptions,
    accessorIdleOptions,
    { exactTargets: port, idlePollMs: 2, unexpected: true },
    new Proxy({ exactTargets: port }, {}),
    { exactTargets: new Proxy(port, {}) },
  ]) {
    assert.throws(
      () => new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1(malformed),
      TypeError,
    );
  }

  // A valid construction captures every callable once with its original
  // receiver: methods that rely on `this` keep working.
  const bytePlane = new bytePlaneModule.RelayV2TerminalControlObservedBytePlaneAdapterV1({
    exactTargets: port,
    idlePollMs: 2,
  });
  const handle = await bytePlane.open(
    foreignTarget("constructor"),
    { maxChunkBytes: 64, displaySizeHint: { cols: 80, rows: 24 } },
    { async onBytes() {}, async onClosed() {} },
  );
  assert.equal(calls.observe, 1, "the observed call kept its receiver");
  await waitFor(() => calls.tail > 0, "the tail lost its receiver");
  await handle.close();
  await bytePlane.close();
});
