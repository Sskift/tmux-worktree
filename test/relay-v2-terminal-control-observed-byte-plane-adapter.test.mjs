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

function observingBackend(calls, { managedName, failTail }) {
  let output = Buffer.alloc(0);
  return {
    append(text) {
      output = Buffer.concat([output, Buffer.from(text, "utf8")]);
    },
    async inspectExactTarget() {
      calls.inspect += 1;
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
});
