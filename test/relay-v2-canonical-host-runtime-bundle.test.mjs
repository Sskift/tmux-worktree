import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const bundleModule = await import(
  "../dist/relay/v2/canonicalHostRuntimeBundle.js"
);
const admissionModule = await import(
  "../dist/relay/v2/canonicalCreateTargetAdmissionAdapter.js"
);
const observationModule = await import("../dist/createTargetObservationV1.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const terminalControl = await import("../dist/terminalControl/index.js");
const exactCompound = await import(
  "../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);
const { RPC_V2_CAPABILITIES } = await import("../dist/rpcV2.js");

const HOST_ID = "mac-admin";
const encoder = new TextEncoder();
const corpus = loadRelayV2FixtureCorpus();
const incarnation = (letter) => `twinc2.${letter.repeat(43)}`;

function emptyBytes() {
  return { async *[Symbol.asyncIterator]() {} };
}

function jsonProcess(value) {
  const output = encoder.encode(`${JSON.stringify(value)}\n`);
  return {
    stdout: {
      async *[Symbol.asyncIterator]() {
        yield output;
      },
    },
    stderr: emptyBytes(),
    exited: Promise.resolve({ exitCode: 0, signal: null }),
    kill() {},
  };
}

function controlledJsonProcess(value) {
  const output = encoder.encode(`${JSON.stringify(value)}\n`);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  return {
    handle: {
      stdout: {
        async *[Symbol.asyncIterator]() {
          await barrier;
          yield output;
        },
      },
      stderr: {
        async *[Symbol.asyncIterator]() {
          await barrier;
        },
      },
      exited: barrier.then(() => ({ exitCode: 0, signal: null })),
      kill() {},
    },
    release,
  };
}

function rpcSession(name, suffix, reservationCorrelation = null) {
  return {
    name,
    kind: "terminal",
    profile: "dashboard",
    project: null,
    label: suffix,
    repoPath: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    cwd: `/repo/${suffix}`,
    createdAt: "2026-07-27T00:00:00.000Z",
    attached: false,
    windows: 1,
    created: 1_785_107_000,
    activity: 1_785_107_001,
    incarnation: incarnation(suffix.slice(0, 1).toUpperCase()),
    lifecycleMarked: true,
    reservationCorrelation,
  };
}

function commandFrame(name, hostEpoch, windowId, scopeId, sessionId, suffix = "") {
  const frame = structuredClone(corpus.goldenByName.get(name).frame);
  frame.hostId = HOST_ID;
  frame.expectedHostEpoch = hostEpoch;
  frame.scopeId = scopeId;
  frame.payload.dedupeWindowId = windowId;
  if (suffix !== "") {
    frame.requestId = `${frame.requestId}-${suffix}`;
    frame.commandId = `${frame.commandId}-${suffix}`;
  }
  if (sessionId === null) delete frame.sessionId;
  else frame.sessionId = sessionId;
  return frame;
}

function auth() {
  return {
    principalId: "principal-one",
    clientInstanceId: "android-one",
    hostId: HOST_ID,
  };
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function noEffectTerminalControlBackend() {
  const unexpected = async () => {
    throw new Error("unexpected terminal-control effect");
  };
  return {
    resolveManagedSession: unexpected,
    inspectExactTarget: unexpected,
    assertCurrent: unexpected,
    writeRaw: unexpected,
    sendAgentMessage: unexpected,
    resize: unexpected,
    scroll: unexpected,
    killManaged: unexpected,
    prepareOutput: unexpected,
    resetOutput: unexpected,
    tailOutput: unexpected,
  };
}

test("canonical Host runtime bundle keeps one target generation and fences every old spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-v2-canonical-host-bundle-"));
  const socketPath = join(
    tmpdir(),
    `twv2-b-${process.pid}-${root.slice(-6)}.sock`,
  );
  const compoundSocketPath = exactCompound.relayV2RemoteExactCompoundSocketPathV1(
    socketPath,
  );
  const daemonAbort = new AbortController();
  const daemonAuthority = new terminalControl.TerminalControlAuthority({
    statePath: join(root, "terminal-control-state-v1.json"),
    backend: noEffectTerminalControlBackend(),
  });
  let exactTargetCaptures = 0;
  const captureExactTarget = daemonAuthority.captureRelayV2ExactProcessTarget
    .bind(daemonAuthority);
  daemonAuthority.captureRelayV2ExactProcessTarget = (target) => {
    exactTargetCaptures += 1;
    return captureExactTarget(target);
  };
  const daemon = terminalControl.runTerminalControlServer({
    socketPath,
    authority: daemonAuthority,
    signal: daemonAbort.signal,
    relayV2RemoteExactCompoundV1: true,
  });

  const remoteSessions = [
    rpcSession("tw-term-remote-one", "alpha"),
    rpcSession("tw-term-remote-two", "beta"),
  ];
  const createdSessionName = "tw-term-created-local";
  const processCalls = [];
  const compoundCalls = [];
  const observationModes = [];
  let terminalCreates = 0;
  let blockNextCapabilities = false;
  let blockedProcess = null;
  let configLoaderHook = null;
  const observationDeps = {
    loadConfig: () => ({ projects: {}, hosts: [], worktreeBase: "/worktrees" }),
    existsSync: (path) => path === "/repo/demo" || path === "/repo",
    realpathSync: (path) => path,
    statSync: () => ({ isDirectory: () => true }),
    gitQuery: () => "",
  };
  const runner = {
    spawn(request) {
      processCalls.push({
        executable: request.executable,
        argv: [...request.argv],
        shell: request.shell,
      });
      if (request.argv.includes("create-target-observation-v1")) {
        const raw = JSON.parse(request.argv.at(-1));
        if (raw.mode === "admit") {
          observationModes.push("admit");
          const response = observationModule.executeCreateTargetAdmissionV1(raw, {
            ...observationDeps,
            runTerminal(input) {
              terminalCreates += 1;
              return {
                protocolVersion: 2,
                operation: "create-terminal",
                state: "succeeded",
                session: {
                  ...rpcSession(
                    createdSessionName,
                    "created",
                    structuredClone(input.reservationCorrelation),
                  ),
                  cwd: input.arguments.cwd,
                  label: input.arguments.label,
                },
              };
            },
          });
          return jsonProcess(response);
        }
        observationModes.push("observe");
        return jsonProcess(
          observationModule.buildCreateTargetObservationV1(raw, observationDeps),
        );
      }
      if (request.argv.at(-1) === "capabilities") {
        const response = {
          protocolVersion: 2,
          app: "tmux-worktree",
          capabilities: [...RPC_V2_CAPABILITIES],
        };
        if (blockNextCapabilities) {
          blockNextCapabilities = false;
          blockedProcess = controlledJsonProcess(response);
          return blockedProcess.handle;
        }
        return jsonProcess(response);
      }
      if (request.argv.at(-1) === "list") {
        return jsonProcess({
          protocolVersion: 2,
          sessions: request.executable === "/usr/bin/ssh" ? remoteSessions : [],
        });
      }
      if (request.argv.at(-1).includes("'rpc-v2' 'kill-session'")) {
        return jsonProcess({
          protocolVersion: 2,
          operation: "kill-session",
          state: "succeeded",
          name: remoteSessions[0].name,
          kind: remoteSessions[0].kind,
          incarnation: remoteSessions[0].incarnation,
          terminated: true,
          sessionId: "$7",
        });
      }
      throw new Error(`unexpected canonical child invocation: ${request.argv.join(" ")}`);
    },
    spawnCompound(request) {
      compoundCalls.push({
        executable: request.executable,
        argv: [...request.argv],
        shell: request.shell,
      });
      const socket = createConnection(compoundSocketPath);
      let failed = false;
      socket.on("error", () => { failed = true; });
      const exited = new Promise((resolve) => {
        socket.once("close", () => {
          resolve({ exitCode: failed ? 1 : 0, signal: null });
        });
      });
      return {
        stdin: {
          write(frame) {
            return new Promise((resolve, reject) => {
              socket.write(frame, (error) => error ? reject(error) : resolve());
            });
          },
          end() {
            socket.end();
          },
        },
        stdout: socket,
        stderr: emptyBytes(),
        exited,
        kill() {
          socket.destroy();
        },
      };
    },
  };

  let configSnapshot = {
    hosts: [{
      id: "configured-devbox",
      label: "Configured devbox",
      host: "old.example.com",
      user: "builder",
      port: 2222,
      identityFile: "/configured/ssh/old_ed25519",
      twPath: "/opt/tw/bin/tw",
    }],
  };
  let owner;
  let activation;
  let store;
  try {
    await waitForPath(socketPath);
    await waitForPath(compoundSocketPath);
    owner = await bundleModule.createRelayV2CanonicalHostRuntimeBundleOwnerV1({
      localCliTarget: {
        executable: "/opt/tw-node/bin/node",
        entrypoint: "/opt/tw-dashboard/tw-cli/cli.cjs",
      },
      terminalControlDaemonSocketPath: socketPath,
      knownHostsFile: "/configured/ssh/known_hosts",
      sshExecutable: "/usr/bin/ssh",
      configLoader: () => {
        configLoaderHook?.();
        return structuredClone(configSnapshot);
      },
      runner,
    });
    assert.equal(exactTargetCaptures, 1);
    assert.equal(processCalls.length, 0, "bundle construction must not spawn TW");

    const opened = bundleModule.consumeRelayV2CanonicalHostRuntimeBundleV1(owner.bundle);
    assert.equal(Object.getPrototypeOf(opened), null);
    assert.equal(Object.isFrozen(opened), true);
    assert.deepEqual(Reflect.ownKeys(opened).sort(), [
      "createTargetExecutionPair",
      "discovery",
      "localProcessTarget",
      "remoteCompoundChannels",
    ]);
    assert.equal(Object.getPrototypeOf(opened.discovery), null);
    assert.deepEqual(Reflect.ownKeys(opened.discovery), ["scan"]);
    assert.deepEqual(Reflect.ownKeys(opened.createTargetExecutionPair), []);
    assert.deepEqual(Reflect.ownKeys(opened.remoteCompoundChannels), ["open"]);
    for (const hidden of [
      "runner", "queryPort", "structuredProcess", "configLoader", "write", "stdin",
    ]) {
      assert.equal(Reflect.get(opened, hidden), undefined, hidden);
      assert.equal(Reflect.get(opened.discovery, hidden), undefined, `discovery.${hidden}`);
    }

    const firstScan = await opened.discovery.scan();
    assert.equal(firstScan.coverage, "complete");
    const firstCut = firstScan[resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT];
    assert.ok(firstCut);
    assert.equal(firstCut.scopeTargets.length, 2);
    assert.deepEqual(
      firstCut.scopeTargets.map((item) => item.processTarget.kind).sort(),
      ["local", "ssh"],
      "local and SSH targets must come from one discovery generation",
    );
    assert.equal(firstCut.isCurrent(), true);
    const oldRemoteTarget = firstCut.scopeTargets.find(
      (item) => item.processTarget.kind === "ssh",
    ).processTarget;
    assert.deepEqual(
      firstCut.scopeTargets.find((item) => item.processTarget.kind === "local")
        .processTarget,
      opened.localProcessTarget,
    );

    const channel = await opened.remoteCompoundChannels.open(oldRemoteTarget);
    const hello = await channel.request({
      protocolVersion: 1,
      type: "hello",
      processTarget: oldRemoteTarget,
    });
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.ok, true);
    assert.deepEqual(
      { ...hello.result.processTarget },
      { ...oldRemoteTarget },
    );
    await channel.close();
    assert.equal(compoundCalls.length, 1);
    assert.equal(compoundCalls[0].executable, "/usr/bin/ssh");
    assert.equal(compoundCalls[0].argv.includes("old.example.com"), true);
    assert.deepEqual(
      compoundCalls[0].argv.slice(-2),
      ["/opt/tw/bin/tw", "rpc-v2-remote-exact-v1"],
    );

    store = await hostState.RelayV2HostStateStore.open({
      paths: hostState.relayV2HostStatePaths(join(root, "host-state")),
    });
    const materialized = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: HOST_ID,
      discovery: opened.discovery,
      store,
      readinessSink: { apply: () => true },
    });
    const reconciled = await materialized.reconcile();
    const scopesFrame = await materialized.scopesSnapshot(
      "bundle-scopes",
      reconciled.snapshot.hostEpoch,
    );
    const scopes = scopesFrame.payload.items;
    const localScope = scopes.find((scope) => scope.kind === "local");
    const remoteScope = scopes.find((scope) => scope.kind === "ssh");
    assert.ok(localScope);
    assert.ok(remoteScope);
    const sessionsFrame = await materialized.sessionsSnapshot(
      "bundle-sessions",
      reconciled.snapshot.hostEpoch,
      [remoteScope.scopeId],
    );
    const materializedRemoteSessions = sessionsFrame.payload.scopes[0].items;
    assert.equal(materializedRemoteSessions.length, 2);
    const remoteSessionToKill = materializedRemoteSessions.find(
      (session) => session.displayName === "alpha",
    );
    const remoteSessionToFence = materializedRemoteSessions.find(
      (session) => session.displayName === "beta",
    );
    assert.ok(remoteSessionToKill);
    assert.ok(remoteSessionToFence);

    const h1Factory = admissionModule.captureRelayV2CanonicalCreateTargetH1FactoryV1(
      opened.createTargetExecutionPair,
    );
    const candidate = await h1Factory({
      store,
      hostId: HOST_ID,
      resourceResolver: materialized.canonicalTargetResolver,
      exactTerminalTarget: {
        async resolveExactTarget() {
          throw new Error("unexpected exact terminal resolution");
        },
        fenceExactTargetForAdmission() {
          throw new Error("unexpected exact terminal fence");
        },
      },
      commandTerminal: {
        async executeAgentMessage() {
          throw new Error("unexpected terminal mutation");
        },
      },
      terminalOwner: {
        kind: "relay-v2",
        instanceId: "canonical-host-runtime-bundle-test",
      },
      resourceMutationOwner: materialized.commandResourceMutationOwner,
    });
    assert.notEqual(candidate, null);
    activation = commandPlane.createRelayV2HostH1ReadinessActivation({
      hostId: HOST_ID,
      hostEpoch: reconciled.snapshot.hostEpoch,
      hostInstanceId: reconciled.snapshot.hostInstanceId,
      candidate,
      readinessSink: {
        apply() { return true; },
        close() {},
      },
    });
    assert.notEqual(activation, null);
    const window = await activation.issueDedupeWindow();

    const killResult = await activation.execute(
      auth(),
      commandFrame(
        "command-execute-kill-session",
        reconciled.snapshot.hostEpoch,
        window.windowId,
        remoteScope.scopeId,
        remoteSessionToKill.sessionId,
      ),
    );
    assert.equal(
      killResult.payload?.state,
      "succeeded",
      JSON.stringify(killResult),
    );
    const killCalls = processCalls.filter(
      (call) => call.argv.at(-1).includes("'rpc-v2' 'kill-session'"),
    );
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].executable, "/usr/bin/ssh");
    assert.equal(killCalls[0].argv.includes("old.example.com"), true);
    assert.equal(killCalls[0].shell, false);

    await materialized.reconcile();
    const createResult = await activation.execute(
      auth(),
      commandFrame(
        "command-execute-create-terminal",
        reconciled.snapshot.hostEpoch,
        window.windowId,
        localScope.scopeId,
        null,
      ),
    );
    assert.equal(
      createResult.payload?.state,
      "succeeded",
      JSON.stringify(createResult),
    );
    assert.deepEqual(observationModes, ["observe", "admit"]);
    assert.equal(terminalCreates, 1);

    // Republish the materialized resolver after the successful create, then
    // hold one discovery child so the queued transition cannot install while
    // the public synchronous fence is being attacked.
    await materialized.reconcile();
    blockNextCapabilities = true;
    const blockedScan = opened.discovery.scan();
    await waitFor(
      () => blockedProcess !== null,
      "the controlled discovery child did not start",
    );
    configSnapshot = {
      hosts: [{
        ...configSnapshot.hosts[0],
        host: "new.example.com",
        identityFile: "/configured/ssh/new_ed25519",
      }],
    };
    let reentrantCompoundAttempt = null;
    let reentrantTransition = null;
    configLoaderHook = () => {
      configLoaderHook = null;
      const beforeReentrantOpen = compoundCalls.length;
      reentrantCompoundAttempt = opened.remoteCompoundChannels.open(oldRemoteTarget);
      void reentrantCompoundAttempt.catch(() => undefined);
      assert.equal(
        compoundCalls.length,
        beforeReentrantOpen,
        "a reentrant config loader must observe the retired generation",
      );
      configSnapshot = {
        hosts: [{
          ...configSnapshot.hosts[0],
          host: "latest.example.com",
          identityFile: "/configured/ssh/latest_ed25519",
        }],
      };
      reentrantTransition = owner.reconfigure();
      void reentrantTransition.catch(() => undefined);
    };
    const reconfigure = owner.reconfigure();
    void reconfigure.catch(() => undefined);
    const processesAfterSynchronousFence = processCalls.length;
    const compoundsAfterSynchronousFence = compoundCalls.length;
    const oldCompoundAttempt = opened.remoteCompoundChannels.open(oldRemoteTarget);
    const oldCreateAttempt = activation.execute(
      auth(),
      commandFrame(
        "command-execute-create-terminal",
        reconciled.snapshot.hostEpoch,
        window.windowId,
        localScope.scopeId,
        null,
        "synchronous-fence",
      ),
    );
    const oldKillAttempt = activation.execute(
      auth(),
      commandFrame(
        "command-execute-kill-session",
        reconciled.snapshot.hostEpoch,
        window.windowId,
        remoteScope.scopeId,
        remoteSessionToFence.sessionId,
        "synchronous-fence",
      ),
    );
    const fencedAttempts = await Promise.allSettled([
      oldCompoundAttempt,
      oldCreateAttempt,
      oldKillAttempt,
    ]);
    assert.equal(fencedAttempts[0].status, "rejected");
    assert.equal(
      compoundCalls.length,
      compoundsAfterSynchronousFence,
      "reconfigure() must retire compound authority before returning",
    );
    assert.equal(
      processCalls.length,
      processesAfterSynchronousFence,
      "create and kill must fail before spawn immediately after reconfigure() returns",
    );
    await waitFor(
      () => reentrantCompoundAttempt !== null,
      "the reentrant config loader did not run",
    );
    await assert.rejects(
      reentrantCompoundAttempt,
      (error) => error?.code === "TARGET_UNAVAILABLE",
    );
    assert.equal(compoundCalls.length, compoundsAfterSynchronousFence);

    blockedProcess.release();
    await blockedScan;
    await assert.rejects(
      reconfigure,
      (error) => error?.code === "TARGET_UNAVAILABLE",
      "the superseded transition must never install",
    );
    await reentrantTransition;

    const currentScan = await opened.discovery.scan();
    const currentCut = currentScan[resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT];
    const currentRemoteTarget = currentCut.scopeTargets.find(
      (item) => item.processTarget.kind === "ssh",
    ).processTarget;
    assert.notEqual(currentRemoteTarget.targetId, oldRemoteTarget.targetId);
    assert.equal(firstCut.isCurrent(), false);
    assert.equal(
      processCalls.some((call) => call.argv.includes("new.example.com")),
      false,
      "the superseded request must never publish its descriptor",
    );
    assert.equal(
      processCalls.some((call) => call.argv.includes("latest.example.com")),
      true,
      "only the latest queued request may install",
    );

    await owner.closeAndDrain();
    const compoundsBeforeClosedOpen = compoundCalls.length;
    const processesBeforeClosedScan = processCalls.length;
    await assert.rejects(
      opened.remoteCompoundChannels.open(currentRemoteTarget),
      (error) => error?.code === "TARGET_UNAVAILABLE",
    );
    assert.equal(compoundCalls.length, compoundsBeforeClosedOpen);
    const closedScan = await opened.discovery.scan();
    assert.equal(closedScan.coverage, "partial");
    assert.equal(
      processCalls.length,
      processesBeforeClosedScan,
      "closed discovery must not spawn a child",
    );
    assert.equal(
      JSON.stringify([...processCalls, ...compoundCalls]).includes("tmux"),
      false,
    );
  } finally {
    blockedProcess?.release();
    await activation?.close().catch(() => undefined);
    await owner?.closeAndDrain().catch(() => undefined);
    store?.close();
    daemonAbort.abort();
    await daemon.catch(() => undefined);
    rmSync(socketPath, { force: true });
    rmSync(`${socketPath}.server.lock`, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
