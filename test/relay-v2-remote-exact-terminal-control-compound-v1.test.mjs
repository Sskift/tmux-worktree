import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const terminalControl = await import("../dist/terminalControl/index.js");
const compound = await import(
  "../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);
const transportModule = await import(
  "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js"
);
const commandTarget = await import(
  "../dist/relay/v2/canonicalCommandTargetAuthorityAdapter.js"
);
const backendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");

const encoder = new TextEncoder();
const INCARNATION = `twinc2.${"A".repeat(43)}`;
const PROCESS_TARGET = Object.freeze({ kind: "ssh", targetId: "configured-devbox" });
const OWNER = Object.freeze({ kind: "relay-v2", instanceId: "relay-v2-remote-owner" });

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

function emptyBytes() {
  return { async *[Symbol.asyncIterator]() {} };
}

function assertTransportCode(code) {
  return (error) => error?.name === "RelayV2CanonicalTwRpcQueryTransportError"
    && error.code === code;
}

function readContract() {
  const root = new URL("../contracts/tw-rpc/remote-exact-compound-v1/", import.meta.url);
  return {
    manifest: JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")),
    cases: JSON.parse(readFileSync(new URL("cases.json", root), "utf8")),
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("compound framing is allocation-bounded and injected handles are closed before activation", async () => {
  const { manifest, cases } = readContract();
  assert.equal(manifest.contract, "tmux-worktree-relay-v2-remote-exact-compound");
  assert.equal(manifest.version, compound.RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION);
  assert.equal(manifest.entrypoint, compound.RELAY_V2_REMOTE_EXACT_COMPOUND_ENTRYPOINT);
  assert.equal(manifest.fixture, "cases.json");
  assert.equal(manifest.capabilityAdvertisementAllowed, false);
  assert.deepEqual(Object.keys(cases).sort(), [
    "admit", "effect", "helloLocal", "prepare", "prepareLocal", "release", "rollback",
  ]);
  assert.deepEqual(
    [cases.helloLocal, cases.prepareLocal, cases.prepare, cases.admit,
      cases.effect, cases.release, cases.rollback]
      .map((item) => [item.request.type, item.request.request?.type]),
    [
      ["hello", undefined],
      ["prepare", undefined],
      ["prepare", undefined],
      ["admit", undefined],
      ["effect", "input.agent-message"],
      ["effect", "lease.release"],
      ["rollback", undefined],
    ],
  );
  assert.deepEqual(
    manifest.allowedEffects.filter((effect) => ["input.agent-message", "lease.release"].includes(effect)),
    ["lease.release", "input.agent-message"],
  );
  assert.equal(manifest.forbiddenEffects.includes("lease.acquire"), true);
  assert.equal(manifest.forbiddenEffects.includes("target.resolve"), true);
  assert.equal(manifest.authority.explicitLocalSiblingAllowed, true);
  assert.deepEqual(
    cases.helloLocal.response.result.processTarget,
    cases.helloLocal.request.processTarget,
  );
  assert.equal(
    cases.prepareLocal.request.input.backendInstanceKey,
    backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: cases.prepareLocal.request.input.processTarget,
      incarnation: cases.prepareLocal.request.input.managedTarget.incarnation,
    }),
  );
  assert.equal(
    cases.prepare.request.input.backendInstanceKey,
    backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: cases.prepare.request.input.processTarget,
      incarnation: cases.prepare.request.input.managedTarget.incarnation,
    }),
  );
  assert.match(
    cases.prepare.response.result.exactControlIdentity.targetIncarnationProof,
    /^twct2\.[A-Za-z0-9_-]{43}$/,
  );

  let ownerOpens = 0;
  await assert.rejects(
    compound.runRelayV2RemoteExactCompoundServerV1({
      source: {
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array(compound.RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES + 1);
        },
      },
      async write() { assert.fail("oversize input must fail before a response allocation"); },
      async openOwner() {
        ownerOpens += 1;
        assert.fail("oversize input must fail before authority activation");
      },
    }),
    (error) => error?.code === "INVALID_REQUEST" && /too large/.test(error.message),
  );
  assert.equal(ownerOpens, 0);

  const queryRunner = { spawn() { throw new Error("unexpected query"); } };
  const malformedHandles = [
    null,
    new Proxy({
      stdin: { async write() {}, end() {} },
      stdout: emptyBytes(),
      stderr: emptyBytes(),
      exited: Promise.resolve({ exitCode: 0, signal: null }),
      kill() {},
    }, {}),
    {
      stdin: { async write() {} },
      stdout: emptyBytes(),
      stderr: emptyBytes(),
      exited: Promise.resolve({ exitCode: 0, signal: null }),
      kill() {},
    },
    Object.assign(Object.create({ kill() {} }), {
      stdin: { async write() {}, end() {} },
      stdout: emptyBytes(),
      stderr: emptyBytes(),
      exited: Promise.resolve({ exitCode: 0, signal: null }),
    }),
  ];
  for (const returned of malformedHandles) {
    let kills = 0;
    if (returned && typeof returned === "object" && !Object.hasOwn(returned, "kill")) {
      Object.getPrototypeOf(returned).kill = () => { kills += 1; };
    }
    const transport = new transportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [sshTarget()],
      runner: queryRunner,
    });
    const factory = transport.captureRemoteExactCompoundChannelFactory({
      spawnCompound() { return returned; },
    });
    await assert.rejects(factory.open(PROCESS_TARGET), assertTransportCode("SPAWN_FAILED"));
    transport.beginContentAddressedTargetTransition();
    assert.equal(kills, 0, "a rejected handle is never registered as an active channel");
  }

  let oversizedKills = 0;
  const oversizedTransport = new transportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [sshTarget()],
    runner: queryRunner,
  });
  const oversizedChannel = await oversizedTransport.captureRemoteExactCompoundChannelFactory({
    spawnCompound() {
      return {
        stdin: { async write() {}, end() {} },
        stdout: {
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array(
              compound.RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES + 1,
            );
          },
        },
        stderr: emptyBytes(),
        exited: Promise.resolve({ exitCode: 1, signal: null }),
        kill() { oversizedKills += 1; },
      };
    },
  }).open(PROCESS_TARGET);
  await assert.rejects(
    oversizedChannel.request({ protocolVersion: 1, type: "prepare" }),
    assertTransportCode("OUTPUT_LIMIT"),
  );
  await oversizedChannel.close();
  assert.equal(oversizedKills, 0, "bounded rejection does not require an active fallback process");

  const unknownCodeRemote = new compound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
    owner: OWNER,
    channels: {
      async open() {
        let requestNumber = 0;
        return {
          async request() {
            requestNumber += 1;
            if (requestNumber === 1) {
              return {
                protocolVersion: 1,
                ok: true,
                result: {
                  exactControlIdentity: {
                    schemaVersion: 1,
                    controlTargetId: "control-target-unknown-code",
                    controlEpoch: "control-epoch-unknown-code",
                    targetIncarnationProof: "twct2.unknown-code-proof",
                  },
                },
              };
            }
            return {
              protocolVersion: 1,
              ok: false,
              error: {
                code: "MADE_UP_DEFINITE_REJECTION",
                message: "must not cross as a definite not-applied result",
                retryable: false,
              },
            };
          },
          async close() {},
        };
      },
    },
  });
  const unknownInput = {
    schemaVersion: 1,
    hostId: "host-unknown",
    scopeId: "scope-unknown",
    sessionId: "session-unknown",
    pane: 0,
    processTarget: { ...PROCESS_TARGET },
    backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: PROCESS_TARGET,
      incarnation: INCARNATION,
    }),
    managedTarget: { name: "managed-unknown", kind: "worktree", incarnation: INCARNATION },
  };
  const unknownEvidence = await unknownCodeRemote.resolveExactTarget(unknownInput);
  unknownCodeRemote.fenceExactTargetForAdmission(unknownInput, unknownEvidence);
  const unknownExecution = new commandTarget.RelayV2CanonicalAgentMessageTerminalExecutionAdapter(
    unknownCodeRemote,
    unknownCodeRemote,
  );
  assert.deepEqual(await unknownExecution.executeAgentMessage({
    targetBinding: {
      ...unknownInput,
      exactControlIdentity: structuredClone(unknownEvidence.exactControlIdentity),
    },
    owner: OWNER,
    operationId: "twmsg2.unknown-remote-code",
    pane: "0",
    message: "continue",
    submit: true,
  }), { state: "in_doubt" });
  await unknownCodeRemote.close();
});

test("remote exact compound keeps prepare, admission, effect, and release in one canonical SSH child", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-v2-remote-exact-"));
  const statePath = join(root, "terminal-control-state-v1.json");
  const calls = { ownerOpen: 0, inspect: 0, resolve: 0, acquire: 0, send: 0, reset: 0 };
  const protocolFrames = [];
  const invocations = [];
  terminalControl.saveTerminalControlState({
    version: 1,
    controlEpoch: "pre-server-epoch",
    targets: [{
      controlTargetId: "control-target-one",
      lifecycle: "ACTIVE",
      managedSession: {
        name: "managed-one",
        kind: "worktree",
        createdAt: "2026-07-22T00:00:00.000Z",
      },
      backend: { kind: "tmux", tmuxInstanceId: "tmux-instance-one" },
      outputGeneration: "output-generation-one",
      ownership: { state: "FREE", fence: "0" },
      revision: "1",
      completedOperations: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
  }, statePath);
  const backend = {
    async inspectExactTarget(input) {
      calls.inspect += 1;
      assert.deepEqual(input, {
        managedName: "managed-one",
        managedKind: "worktree",
        managedIncarnation: INCARNATION,
        pane: 0,
      });
      return {
        managedSession: {
          name: "managed-one",
          kind: "worktree",
          profile: "cli",
          cwd: "/repo",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
        managedIncarnation: INCARNATION,
        tmuxInstanceId: "tmux-instance-one",
        paneIdentity: "%1",
      };
    },
    async resolveManagedSession() {
      calls.resolve += 1;
      throw new Error("name-only resolution must not run");
    },
    async assertCurrent() {},
    async prepareOutput() {
      return { generation: "output-generation-one", cursor: 0 };
    },
    async resetOutput() {
      calls.reset += 1;
      return { generation: "output-generation-two", cursor: 0 };
    },
    async sendAgentMessage(name, pane, message, submit) {
      calls.send += 1;
      assert.deepEqual({ name, pane, message, submit }, {
        name: "managed-one", pane: "0", message: "continue", submit: true,
      });
    },
  };
  const compoundRunner = {
    spawnCompound(request) {
      invocations.push({ ...request, argv: [...request.argv] });
      const input = new ByteQueue();
      const output = new ByteQueue();
      const stderr = new ByteQueue();
      const server = compound.runRelayV2RemoteExactCompoundServerV1({
        source: input,
        async write(frame) { output.push(frame); },
        async openOwner(processTarget) {
          calls.ownerOpen += 1;
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
        (error) => {
          stderr.push(encoder.encode(error instanceof Error ? error.message : String(error)));
          return { exitCode: 1, signal: null };
        },
      ).finally(() => {
        output.end();
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
        stdout: output,
        stderr,
        exited: server,
        kill() { input.end(); },
      };
    },
  };
  const queryRunner = {
    spawn() { throw new Error("compound authority must not invoke read discovery"); },
  };
  const queryTransport = new transportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [sshTarget()],
    runner: queryRunner,
  });
  const remote = new compound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
    channels: queryTransport.captureRemoteExactCompoundChannelFactory(compoundRunner),
    owner: OWNER,
  });
  const input = {
    schemaVersion: 1,
    hostId: "host-one",
    scopeId: "scope-one",
    sessionId: "session-one",
    pane: 0,
    processTarget: { ...PROCESS_TARGET },
    backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: PROCESS_TARGET,
      incarnation: INCARNATION,
    }),
    managedTarget: {
      name: "managed-one",
      kind: "worktree",
      incarnation: INCARNATION,
    },
  };
  try {
    const evidence = await remote.resolveExactTarget(input);
    assert.equal(calls.ownerOpen, 1);
    assert.equal(calls.inspect, 1);
    assert.equal(calls.resolve, 0);
    assert.equal(calls.acquire, 0);
    assert.equal(calls.send, 0, "prepare is effect-closed");
    assert.match(evidence.exactControlToken, /^twrc2\./);
    remote.fenceExactTargetForAdmission(input, evidence);

    const execution = new commandTarget.RelayV2CanonicalAgentMessageTerminalExecutionAdapter(
      remote,
      remote,
    );
    const result = await execution.executeAgentMessage({
      targetBinding: {
        ...input,
        exactControlIdentity: structuredClone(evidence.exactControlIdentity),
      },
      owner: OWNER,
      operationId: "twmsg2.remote-compound-one",
      pane: "0",
      message: "continue",
      submit: true,
    });

    assert.equal(result.state, "succeeded");
    assert.equal(calls.ownerOpen, 1, "admission and effect must use the prepared process");
    assert.equal(calls.send, 1);
    assert.equal(calls.reset, 1);
    assert.equal(invocations.length, 1, "there is no retry or second acquisition process");
    assert.deepEqual(invocations[0], {
      executable: "/usr/bin/ssh",
      argv: [
        "-F", "/dev/null",
        "-o", "BatchMode=yes",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=/configured/ssh/known_hosts",
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "ClearAllForwardings=yes",
        "-o", "RequestTTY=no",
        "-o", "ConnectTimeout=10",
        "-o", "IdentitiesOnly=yes",
        "-i", "/configured/ssh/id_ed25519",
        "-p", "2222",
        "-l", "builder",
        "--",
        "devbox.example.com",
        "/opt/tw/bin/tw",
        "rpc-v2-remote-exact-v1",
      ],
      shell: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.deepEqual(protocolFrames.map((frame) => [frame.type, frame.request?.type]), [
      ["prepare", undefined],
      ["admit", undefined],
      ["effect", "input.agent-message"],
      ["effect", "lease.release"],
    ]);
    assert.equal(JSON.stringify(protocolFrames).includes("lease.acquire"), false);
    assert.equal(JSON.stringify(protocolFrames).includes(evidence.exactControlToken), false,
      "the Host channel token is not a serialized target-side claim");
    assert.equal(protocolFrames.some((frame) => frame.type === "admit" && "input" in frame), false,
      "admission consumes the claim already held by the same child");

    await assert.rejects(
      remote.resolveExactTarget({
        ...input,
        processTarget: { kind: "local", targetId: "local" },
      }),
      assertTransportCode("TARGET_UNAVAILABLE"),
    );
    assert.equal(invocations.length, 1, "remote unavailable never falls back to local");
  } finally {
    await remote.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("running daemon owns remote compound claims and drains them on target retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-v2-remote-daemon-"));
  const statePath = join(root, "terminal-control-state-v1.json");
  const socketPath = join(tmpdir(), `twv2d-${process.pid}-${root.slice(-6)}.sock`);
  const compoundSocketPath = compound.relayV2RemoteExactCompoundSocketPathV1(socketPath);
  const calls = { initialize: 0, capture: 0, inspect: 0, resolve: 0, send: 0, reset: 0 };
  terminalControl.saveTerminalControlState({
    version: 1,
    controlEpoch: "pre-daemon-epoch",
    targets: [{
      controlTargetId: "daemon-control-target",
      lifecycle: "ACTIVE",
      managedSession: {
        name: "daemon-managed-one",
        kind: "worktree",
        createdAt: "2026-07-22T00:00:00.000Z",
      },
      backend: { kind: "tmux", tmuxInstanceId: "daemon-tmux-instance" },
      outputGeneration: "daemon-output-generation-one",
      ownership: { state: "FREE", fence: "0" },
      revision: "1",
      completedOperations: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
  }, statePath);
  const backend = {
    async inspectExactTarget(input) {
      calls.inspect += 1;
      assert.deepEqual(input, {
        managedName: "daemon-managed-one",
        managedKind: "worktree",
        managedIncarnation: INCARNATION,
        pane: 0,
      });
      return {
        managedSession: {
          name: "daemon-managed-one",
          kind: "worktree",
          profile: "cli",
          cwd: "/repo",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
        managedIncarnation: INCARNATION,
        tmuxInstanceId: "daemon-tmux-instance",
        paneIdentity: "%7",
      };
    },
    async resolveManagedSession() {
      calls.resolve += 1;
      throw new Error("daemon compound must not use name-only resolution");
    },
    async assertCurrent() {},
    async prepareOutput() {
      return { generation: "daemon-output-generation-one", cursor: 0 };
    },
    async resetOutput() {
      calls.reset += 1;
      return { generation: `daemon-output-generation-${calls.reset + 1}`, cursor: 0 };
    },
    async sendAgentMessage(name, pane, message, submit) {
      calls.send += 1;
      assert.deepEqual({ name, pane, message, submit }, {
        name: "daemon-managed-one", pane: "0", message: "continue", submit: true,
      });
    },
  };
  writeFileSync(compoundSocketPath, "foreign sibling must survive\n", { mode: 0o600 });
  const foreignAuthority = new terminalControl.TerminalControlAuthority({ statePath, backend });
  await assert.rejects(
    terminalControl.runTerminalControlServer({
      socketPath,
      authority: foreignAuthority,
      relayV2RemoteExactCompoundV1: true,
    }),
    /not a same-uid real Unix socket/,
  );
  assert.equal(readFileSync(compoundSocketPath, "utf8"), "foreign sibling must survive\n");
  assert.equal(existsSync(`${socketPath}.server.lock`), false);
  rmSync(compoundSocketPath);

  const authority = new terminalControl.TerminalControlAuthority({ statePath, backend });
  const initialize = authority.initializeContinuity.bind(authority);
  authority.initializeContinuity = async () => {
    calls.initialize += 1;
    return initialize();
  };
  const capture = authority.captureRelayV2ExactProcessTarget.bind(authority);
  authority.captureRelayV2ExactProcessTarget = (target) => {
    calls.capture += 1;
    return capture(target);
  };
  const abort = new AbortController();
  const daemon = terminalControl.runTerminalControlServer({
    socketPath,
    authority,
    signal: abort.signal,
    relayV2RemoteExactCompoundV1: true,
  });
  const invocations = [];
  const protocolFrames = [];
  const socketRunner = {
    spawnCompound(request) {
      invocations.push({ ...request, argv: [...request.argv] });
      const socket = createConnection(compoundSocketPath);
      let failed = false;
      socket.on("error", () => { failed = true; });
      const exited = new Promise((resolve) => {
        socket.once("close", () => resolve({ exitCode: failed ? 1 : 0, signal: null }));
      });
      return {
        stdin: {
          write(frame) {
            protocolFrames.push(JSON.parse(Buffer.from(frame).toString("utf8")));
            return new Promise((resolve, reject) => {
              socket.write(frame, (error) => error ? reject(error) : resolve());
            });
          },
          end() { socket.end(); },
        },
        stdout: socket,
        stderr: emptyBytes(),
        exited,
        kill() { socket.destroy(); },
      };
    },
  };
  const queryTransport = new transportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [sshTarget()],
    runner: { spawn() { throw new Error("daemon compound must not run discovery"); } },
  });
  const remote = new compound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
    channels: queryTransport.captureRemoteExactCompoundChannelFactory(socketRunner),
    owner: OWNER,
  });
  const input = {
    schemaVersion: 1,
    hostId: "daemon-host",
    scopeId: "daemon-scope",
    sessionId: "daemon-session",
    pane: 0,
    processTarget: { ...PROCESS_TARGET },
    backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: PROCESS_TARGET,
      incarnation: INCARNATION,
    }),
    managedTarget: {
      name: "daemon-managed-one",
      kind: "worktree",
      incarnation: INCARNATION,
    },
  };
  try {
    await waitFor(
      () => existsSync(socketPath) && existsSync(compoundSocketPath),
      "terminal-control daemon compound ingress did not start",
    );
    assert.equal(existsSync(`${socketPath}.server.lock`), true);
    const evidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, evidence);
    const execution = new commandTarget.RelayV2CanonicalAgentMessageTerminalExecutionAdapter(
      remote,
      remote,
    );
    assert.equal((await execution.executeAgentMessage({
      targetBinding: {
        ...input,
        exactControlIdentity: structuredClone(evidence.exactControlIdentity),
      },
      owner: OWNER,
      operationId: "twmsg2.daemon-compound-one",
      pane: "0",
      message: "continue",
      submit: true,
    })).state, "succeeded");
    assert.equal(calls.initialize, 1, "compound ingress reuses the initialized daemon authority");
    assert.equal(calls.capture, 1);
    assert.equal(calls.inspect, 1);
    assert.equal(calls.resolve, 0);
    assert.equal(calls.send, 1);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].argv.at(-1), "rpc-v2-remote-exact-v1");

    const retirementEvidence = await remote.resolveExactTarget(input);
    remote.fenceExactTargetForAdmission(input, retirementEvidence);
    const retirementBinding = {
      ...input,
      exactControlIdentity: structuredClone(retirementEvidence.exactControlIdentity),
    };
    const retirementLease = await remote.consumePreparedLeaseForBinding(
      retirementBinding,
      OWNER,
    );
    assert.equal(
      terminalControl.loadTerminalControlState(statePath).targets[0].ownership.state,
      "HELD",
    );
    queryTransport.beginContentAddressedTargetTransition();
    await assert.rejects(
      remote.request({
        type: "input.agent-message",
        lease: retirementLease,
        operationId: "twmsg2.must-not-run-after-retirement",
        pane: "0",
        message: "must not run",
        submit: true,
      }),
      (error) => error?.code === "OPERATION_IN_DOUBT",
    );
    await waitFor(
      () => terminalControl.loadTerminalControlState(statePath).targets[0].ownership.state === "FREE",
      "daemon did not release the disconnected compound lease",
    );
    assert.equal(calls.send, 1, "retirement never retries or falls back to a local effect");
    assert.equal(calls.initialize, 1);
    assert.equal(calls.capture, 2);
    assert.equal(invocations.length, 2);

    const { cases } = readContract();
    assert.deepEqual(protocolFrames.slice(0, 4).map((frame) => [frame.type, frame.request?.type]), [
      [cases.prepare.request.type, undefined],
      [cases.admit.request.type, undefined],
      [cases.effect.request.type, cases.effect.request.request.type],
      [cases.release.request.type, cases.release.request.request.type],
    ]);
  } finally {
    await remote.close().catch(() => undefined);
    abort.abort();
    await daemon.catch(() => undefined);
    assert.equal(existsSync(compoundSocketPath), false);
    assert.equal(existsSync(`${socketPath}.server.lock`), false);
    rmSync(socketPath, { force: true });
    rmSync(compoundSocketPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
