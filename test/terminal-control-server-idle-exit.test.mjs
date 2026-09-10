import test from "node:test";
import { createConnection } from "node:net";
import {
  assert,
  spawnSync,
  existsSync,
  rmSync,
  tmpdir,
  join,
  randomUUID,
  realpathSync,
  terminalControl,
  exactCompound,
  backendIdentity,
  terminalControlCli,
  tempState,
  stopAutoStartedTerminalControl,
  isolatedManagedTmux,
  FakeBackend,
} from "./support/terminalControlHarness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function daemonPid(socketPath) {
  return terminalControl.terminalControlStoreLockOwnerProcessId(
    `${socketPath}.server.lock`,
  );
}

function daemonArgv(socketPath) {
  const pid = daemonPid(socketPath);
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  const result = spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function waitForDaemonGone(socketPath, label, timeoutMs) {
  await waitFor(
    () => !existsSync(socketPath) && !existsSync(`${socketPath}.server.lock`),
    label,
    timeoutMs,
  );
}

test("idle activity snapshot counts durable in-flight work and unexpired leases", async () => {
  const temp = tempState("tc-idle-snapshot-");
  const target = (overrides) => ({
    controlTargetId: "snapshot-control-target",
    lifecycle: "ACTIVE",
    managedSession: {
      name: "snapshot-session",
      kind: "terminal",
      createdAt: "2026-09-10T00:00:00.000Z",
    },
    backend: { kind: "tmux", tmuxInstanceId: "snapshot-tmux-instance" },
    outputGeneration: "snapshot-generation",
    ownership: { state: "FREE", fence: "1" },
    revision: "1",
    completedOperations: [],
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  });
  const heldLease = target({
    ownership: {
      state: "HELD",
      fence: "2",
      owner: { kind: "local-cli", instanceId: "snapshot-owner" },
      leaseId: "snapshot-lease",
      leaseExpiresAt: "2099-09-10T00:00:00.000Z",
    },
  });
  const expiredLease = target({
    ownership: {
      state: "HELD",
      fence: "3",
      owner: { kind: "local-cli", instanceId: "snapshot-owner" },
      leaseId: "snapshot-lease",
      leaseExpiresAt: "2001-09-10T00:00:00.000Z",
    },
  });
  const inFlight = target({
    ownership: { state: "FREE", fence: "4" },
    inFlight: {
      operationId: "snapshot-op",
      ownerInstanceId: "snapshot-owner",
      fence: "4",
      payloadHash: "a".repeat(64),
      kind: "raw",
      startedAt: "2026-09-10T00:00:00.000Z",
    },
  });
  try {
    const authority = new terminalControl.TerminalControlAuthority({
      statePath: temp.path,
      backend: new FakeBackend(),
    });
    assert.deepEqual(
      await authority.relayV2ExactIdleActivitySnapshot(),
      { observations: 0, pendingClaims: 0, activeLeases: 0 },
      "an empty daemon is idle",
    );
    terminalControl.saveTerminalControlState({
      version: 1,
      controlEpoch: "snapshot-epoch",
      targets: [heldLease],
    }, temp.path);
    let snapshot = await authority.relayV2ExactIdleActivitySnapshot();
    assert.equal(snapshot.activeLeases, 1, "an unexpired HELD lease is live work");

    terminalControl.saveTerminalControlState({
      version: 1,
      controlEpoch: "snapshot-epoch",
      targets: [expiredLease],
    }, temp.path);
    snapshot = await authority.relayV2ExactIdleActivitySnapshot();
    assert.equal(
      snapshot.activeLeases,
      0,
      "an expired HELD lease is idle: continuity fences it on the next start",
    );

    terminalControl.saveTerminalControlState({
      version: 1,
      controlEpoch: "snapshot-epoch",
      targets: [inFlight],
    }, temp.path);
    snapshot = await authority.relayV2ExactIdleActivitySnapshot();
    assert.equal(snapshot.activeLeases, 1, "an in-flight operation is live work");

    await authority.closeRelayV2ExactTargetAuthority();
    assert.deepEqual(
      await authority.relayV2ExactIdleActivitySnapshot(),
      { observations: 0, pendingClaims: 0, activeLeases: 0 },
      "a closed authority reports no live work",
    );
  } finally {
    temp.cleanup();
  }
});

test("an open compound channel keeps an idle daemon alive and drain lets it exit", async () => {
  const temp = tempState("tc-idle-channel-");
  const socketPath = join(temp.root, "channel.sock");
  const statePath = join(temp.root, "channel-state.json");
  const compoundSocketPath = exactCompound.relayV2RemoteExactCompoundSocketPathV1(
    socketPath,
  );
  try {
    await terminalControl.requestTerminalControl(
      { type: "ping" },
      {
        socketPath,
        autoStart: true,
        autoStartCliTarget: {
          executable: process.execPath,
          entrypoint: terminalControlCli,
          idleExitMs: 800,
        },
        autoStartStatePath: statePath,
        timeoutMs: 8_000,
      },
    );
    await waitFor(() => existsSync(compoundSocketPath), "compound ingress live");

    const channel = createConnection(compoundSocketPath);
    await new Promise((resolve, reject) => {
      channel.once("connect", resolve);
      channel.once("error", reject);
    });
    // No frames flow: a connected, idle compound channel still represents a
    // phone-side attachment and must pin the daemon.
    await sleep(2_400);
    assert.ok(existsSync(`${socketPath}.server.lock`), "daemon stayed alive with an open channel");

    channel.end();
    channel.destroy();
    await waitForDaemonGone(socketPath, "daemon idle exit after channel drain", 6_000);
    assert.equal(existsSync(compoundSocketPath), false);
  } finally {
    await stopAutoStartedTerminalControl(socketPath);
    temp.cleanup();
  }
});

test("a live exact observation pins the idle daemon; closing it starts the idle exit", async (t) => {
  const sessionName = `tw-term-idle-exit-${process.pid}`;
  const harness = isolatedManagedTmux(t, sessionName, { lifecycleV2: true });
  if (harness === undefined) return;
  const socketPath = join(
    tmpdir(),
    `twv2-idle-exit-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
  );
  const statePath = join(harness.twHome, "terminal-control-state-v1.json");
  const isolatedHome = realpathSync.native(harness.home);
  const processTarget = { kind: "local", targetId: "local-idle-exit" };
  let adapter;
  try {
    await terminalControl.requestTerminalControl(
      { type: "ping" },
      {
        socketPath,
        autoStart: true,
        autoStartCliTarget: {
          executable: process.execPath,
          entrypoint: terminalControlCli,
          home: isolatedHome,
          idleExitMs: 3_000,
        },
        autoStartStatePath: statePath,
        timeoutMs: 8_000,
      },
    );
    const listed = spawnSync(
      process.execPath,
      [terminalControlCli, "rpc-v2", "list"],
      { encoding: "utf8", env: { ...process.env, HOME: isolatedHome } },
    );
    assert.equal(listed.status, 0, listed.stderr);
    const session = JSON.parse(listed.stdout).sessions.find(
      (candidate) => candidate.name === sessionName,
    );
    assert.ok(session);

    adapter = new exactCompound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
      channels: exactCompound.captureRelayV2LocalExactCompoundChannelFactoryV1({
        daemonSocketPath: socketPath,
        processTarget,
      }),
      owner: { kind: "relay-v2", instanceId: "relay-v2:idle-exit-test" },
    });
    const input = {
      schemaVersion: 1,
      hostId: "host-idle-exit",
      scopeId: "scope-idle-exit",
      sessionId: "session-idle-exit",
      pane: 0,
      processTarget,
      backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
        processTarget,
        incarnation: session.incarnation,
      }),
      managedTarget: {
        name: sessionName,
        kind: "terminal",
        incarnation: session.incarnation,
      },
    };
    const evidence = await adapter.resolveExactTarget(input);
    adapter.fenceExactTargetForAdmission(input, evidence);
    const binding = await adapter.observePreparedTargetForBinding({
      schemaVersion: 1,
      hostId: input.hostId,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      pane: 0,
      processTarget,
      backendInstanceKey: input.backendInstanceKey,
      managedTarget: input.managedTarget,
      exactControlIdentity: evidence.exactControlIdentity,
    });
    const chunk = await adapter.tailObservedTarget(binding, binding.outputCursor);
    assert.ok(chunk.nextCursor >= binding.outputCursor);

    // Detached-phone window: no frames flow for >3 idle budgets; the daemon
    // must not idle-exit while the observation is open.
    await sleep(10_000);
    assert.ok(
      existsSync(`${socketPath}.server.lock`),
      "daemon must stay alive with an open observation",
    );

    await adapter.closeObservedTarget(binding);
    await adapter.close().catch(() => undefined);
    adapter = undefined;
    await waitForDaemonGone(
      socketPath,
      "daemon idle exit after observation close",
      8_000,
    );

    // A fresh request autostarts the daemon again, and the production
    // auto-start policy passes the bounded idle budget on the argv.
    await terminalControl.requestTerminalControl(
      { type: "ping" },
      {
        socketPath,
        autoStart: true,
        autoStartCliTarget: {
          executable: process.execPath,
          entrypoint: terminalControlCli,
          home: isolatedHome,
        },
        autoStartStatePath: statePath,
        timeoutMs: 10_000,
      },
    );
    await waitFor(() => daemonArgv(socketPath) !== null, "autostarted daemon");
    assert.match(
      daemonArgv(socketPath) ?? "",
      /--idle-exit-ms 600000/,
      "autostart without an explicit policy gets the bounded default idle budget",
    );
  } finally {
    await adapter?.close().catch(() => undefined);
    await stopAutoStartedTerminalControl(socketPath);
    rmSync(socketPath, { force: true });
    rmSync(exactCompound.relayV2RemoteExactCompoundSocketPathV1(socketPath), {
      force: true,
    });
    await harness.cleanup();
  }
});
