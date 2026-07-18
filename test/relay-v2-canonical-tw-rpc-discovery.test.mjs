import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RPC_V2_CAPABILITIES } from "../dist/rpcV2.js";
import {
  RelayV2HostStateStore,
  relayV2HostStatePaths,
} from "../dist/relay/v2/hostState.js";
import {
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES,
  RelayV2CanonicalTwRpcDiscoveryAdapter,
} from "../dist/relay/v2/canonicalTwRpcDiscovery.js";
import {
  RelayV2CanonicalTwRpcQueryTransportAdapter,
} from "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js";
import {
  RELAY_V2_MATERIALIZED_CAPACITY,
  RelayV2MaterializedStateFoundation,
} from "../dist/relay/v2/resourceState.js";

const INCARNATION_A = `twinc2.${"A".repeat(43)}`;
const INCARNATION_B = `twinc2.${"B".repeat(43)}`;
const encoder = new TextEncoder();

function capabilities(overrides = {}) {
  return {
    protocolVersion: 2,
    app: "tmux-worktree",
    capabilities: [...RPC_V2_CAPABILITIES],
    ...overrides,
  };
}

function terminalSession(overrides = {}) {
  return {
    name: "raw.tmux.terminal",
    kind: "terminal",
    profile: "cli",
    project: null,
    label: "Terminal label",
    repoPath: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    cwd: "/tmp/terminal",
    createdAt: "2026-07-18T01:00:00.000Z",
    attached: false,
    windows: 1,
    created: 1_752_804_000,
    activity: 1_752_804_001,
    incarnation: INCARNATION_A,
    lifecycleMarked: true,
    reservationCorrelation: null,
    ...overrides,
  };
}

function worktreeSession(overrides = {}) {
  return {
    name: "raw.tmux.worktree",
    kind: "worktree",
    profile: "dashboard",
    project: "tmux-worktree",
    label: "Feature worktree",
    repoPath: "/repo/tmux-worktree",
    worktreePath: "/repo/worktrees/feature",
    branch: "feature",
    baseBranch: "main",
    cwd: "/repo/worktrees/feature",
    createdAt: "2026-07-18T02:00:00.000Z",
    attached: true,
    windows: 2,
    created: 1_752_807_600,
    activity: 1_752_807_601,
    incarnation: INCARNATION_B,
    lifecycleMarked: true,
    reservationCorrelation: null,
    ...overrides,
  };
}

function scope(kind, targetId, backendIdentity = `${kind}:${targetId}`) {
  return {
    backendIdentity,
    displayName: `${kind} ${targetId}`,
    kind,
    processTarget: { kind, targetId },
  };
}

function queryPort(handler) {
  const calls = [];
  return {
    calls,
    async query(request) {
      calls.push({
        processTarget: request.processTarget,
        command: request.command,
        maxSessions: request.maxSessions,
        timeoutMs: request.timeoutMs,
      });
      return handler(request);
    },
  };
}

function settleAfterAbort(signal, value, reject = false) {
  return new Promise((resolve, rejectPromise) => {
    const settle = () => {
      if (reject) rejectPromise(new Error("query resource barrier settled after abort"));
      else resolve(value);
    };
    if (signal.aborted) settle();
    else signal.addEventListener("abort", settle, { once: true });
  });
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("canonical TW RPC v2 discovery scans only configured scopes and projects deterministic complete results", async () => {
  const port = queryPort(({ processTarget, command }) => {
    if (command === "capabilities") return capabilities();
    if (processTarget.targetId === "local") return { protocolVersion: 2, sessions: [] };
    return {
      protocolVersion: 2,
      sessions: [terminalSession(), worktreeSession()],
    };
  });
  const discovery = new RelayV2CanonicalTwRpcDiscoveryAdapter({
    scopes: [
      scope("ssh", "host-z", "scope:z"),
      scope("local", "local", "scope:a"),
    ],
    queryPort: port,
  });

  const scan = await discovery.scan();

  assert.equal(scan.coverage, "complete");
  assert.deepEqual(scan.scopes.map((item) => item.backendIdentity), ["scope:a", "scope:z"]);
  assert.deepEqual(scan.scopes.map((item) => item.sessionsCompleteness), ["complete", "complete"]);
  assert.deepEqual(scan.scopes[1].sessions.map((session) => session.kind), ["terminal", "worktree"]);
  assert.deepEqual(scan.scopes[1].sessions.map((session) => session.displayName), [
    "Terminal label",
    "Feature worktree",
  ]);
  assert.equal(JSON.stringify(scan).includes("raw.tmux"), false);
  assert.deepEqual(
    [...new Set(port.calls.map((call) => `${call.processTarget.kind}:${call.processTarget.targetId}`))].sort(),
    ["local:local", "ssh:host-z"],
  );
  for (const target of ["local", "host-z"]) {
    assert.deepEqual(
      port.calls.filter((call) => call.processTarget.targetId === target).map((call) => call.command),
      ["capabilities", "list"],
    );
  }
});

test("only a successful complete-empty scan is represented as complete deletion authority", async () => {
  const noScopePort = queryPort(() => {
    throw new Error("must not query without an explicit scope");
  });
  const noScopeScan = await new RelayV2CanonicalTwRpcDiscoveryAdapter({
    scopes: [],
    queryPort: noScopePort,
  }).scan();
  assert.deepEqual(noScopeScan, { coverage: "complete", scopes: [] });
  assert.equal(noScopePort.calls.length, 0);

  const port = queryPort(({ command }) => (
    command === "capabilities" ? capabilities() : { protocolVersion: 2, sessions: [] }
  ));
  const scan = await new RelayV2CanonicalTwRpcDiscoveryAdapter({
    scopes: [scope("local", "local")],
    queryPort: port,
  }).scan();
  assert.equal(scan.coverage, "complete");
  assert.equal(scan.scopes[0].sessionsCompleteness, "complete");
  assert.deepEqual(scan.scopes[0].sessions, []);
  assert.equal(scan.scopes[0].error, null);
});

test("a canonical scope with more than 256 valid Sessions remains complete", async () => {
  const sessions = Array.from({ length: 257 }, (_, index) => terminalSession({
    name: `raw-${index}`,
    label: `Terminal ${index}`,
    incarnation: `twinc2.${String(index).padStart(43, "0")}`,
  }));
  const port = queryPort(({ command }) => (
    command === "capabilities" ? capabilities() : { protocolVersion: 2, sessions }
  ));
  const scan = await new RelayV2CanonicalTwRpcDiscoveryAdapter({
    scopes: [scope("local", "local")],
    queryPort: port,
  }).scan();

  assert.equal(scan.coverage, "complete");
  assert.equal(scan.scopes[0].sessionsCompleteness, "complete");
  assert.equal(scan.scopes[0].sessions.length, 257);
});

test("multiple scopes share the deterministic H2 full-cut record budget without truncation", async () => {
  const port = queryPort((request) => {
    if (request.command === "capabilities") return capabilities();
    if (request.processTarget.targetId === "a") {
      return { protocolVersion: 2, sessions: [terminalSession()] };
    }
    return {
      protocolVersion: 2,
      sessions: new Array(request.maxSessions + 1),
    };
  });
  const scan = await new RelayV2CanonicalTwRpcDiscoveryAdapter({
    scopes: [scope("ssh", "b", "scope:b"), scope("ssh", "a", "scope:a")],
    queryPort: port,
  }).scan();

  const listCalls = port.calls.filter((call) => call.command === "list");
  assert.deepEqual(listCalls.map((call) => call.processTarget.targetId), ["a", "b"]);
  assert.deepEqual(listCalls.map((call) => call.maxSessions), [
    RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords - 4,
    RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords - 5,
  ]);
  assert.equal(scan.coverage, "partial");
  assert.deepEqual(scan.scopes.map((item) => item.sessionsCompleteness), ["complete", "partial"]);
  assert.equal(scan.scopes[0].sessions.length, 1);
  assert.deepEqual(scan.scopes[1].sessions, []);
  assert.equal(scan.scopes[1].error.code, "INTERNAL");
});

test("duplicate identities, process targets, and oversized input are rejected before I/O", () => {
  let calls = 0;
  const port = {
    async query() {
      calls += 1;
      return capabilities();
    },
  };
  const cases = [
    {
      name: "backend identity",
      scopes: [scope("local", "a", "duplicate"), scope("ssh", "b", "duplicate")],
      pattern: /duplicate .*backend identity/,
    },
    {
      name: "process target",
      scopes: [scope("ssh", "same", "one"), scope("ssh", "same", "two")],
      pattern: /duplicate .*process target/,
    },
    {
      name: "scope bound",
      scopes: Array.from(
        { length: RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES + 1 },
        (_, index) => scope("ssh", `host-${index}`),
      ),
      pattern: /invalid .*scopes/,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => new RelayV2CanonicalTwRpcDiscoveryAdapter({ scopes: item.scopes, queryPort: port }),
      item.pattern,
      item.name,
    );
  }
  assert.equal(calls, 0);
});

test("timeout, transport, capability, and malformed-session failures remain partial and empty", async (t) => {
  const cases = [
    {
      name: "timeout",
      handler: ({ signal }) => settleAfterAbort(signal, capabilities()),
      expectedCode: "SCOPE_UNREACHABLE",
      expectedReachability: "unreachable",
      expectedCommands: ["capabilities"],
    },
    {
      name: "transport",
      handler: () => {
        throw new Error("secret transport detail");
      },
      expectedCode: "SCOPE_UNREACHABLE",
      expectedReachability: "unreachable",
      expectedCommands: ["capabilities"],
    },
    {
      name: "capability mismatch",
      handler: ({ command }) => {
        assert.equal(command, "capabilities");
        return capabilities({ capabilities: RPC_V2_CAPABILITIES.slice(0, -1) });
      },
      expectedCode: "CAPABILITY_UNAVAILABLE",
      expectedReachability: "online",
      expectedCommands: ["capabilities"],
    },
    {
      name: "malformed session rejects validated prefix",
      handler: ({ command }) => command === "capabilities"
        ? capabilities()
        : {
          protocolVersion: 2,
          sessions: [terminalSession(), worktreeSession({ incarnation: "invalid" })],
        },
      expectedCode: "INTERNAL",
      expectedReachability: "online",
      expectedCommands: ["capabilities", "list"],
    },
    {
      name: "duplicate incarnation rejects the whole scope",
      handler: ({ command }) => command === "capabilities"
        ? capabilities()
        : {
          protocolVersion: 2,
          sessions: [
            terminalSession(),
            terminalSession({ name: "raw.duplicate", label: "Duplicate label" }),
          ],
        },
      expectedCode: "INTERNAL",
      expectedReachability: "online",
      expectedCommands: ["capabilities", "list"],
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const port = queryPort(item.handler);
      const scan = await new RelayV2CanonicalTwRpcDiscoveryAdapter({
        scopes: [scope("ssh", "configured-host")],
        queryPort: port,
        queryTimeoutMs: 5,
      }).scan();

      assert.equal(scan.coverage, "partial");
      assert.equal(scan.scopes.length, 1);
      assert.equal(scan.scopes[0].sessionsCompleteness, "partial");
      assert.equal(scan.scopes[0].reachability, item.expectedReachability);
      assert.deepEqual(scan.scopes[0].sessions, []);
      assert.equal(scan.scopes[0].error.code, item.expectedCode);
      assert.equal(scan.scopes[0].error.commandDisposition, "not_applicable");
      assert.deepEqual(port.calls.map((call) => call.command), item.expectedCommands);
    });
  }
});

test("materialized reconciliation preserves a stale cut for unreachable and duplicate-incarnation scans", async () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "tw-rpc-v2-discovery-"));
  try {
    let mode = "complete";
    const port = queryPort((request) => {
      const { command } = request;
      if (command === "capabilities") return capabilities();
      if (mode === "timeout") return settleAfterAbort(request.signal, null, true);
      if (mode === "duplicate") {
        return {
          protocolVersion: 2,
          sessions: [
            terminalSession(),
            terminalSession({ name: "raw.duplicate", label: "Duplicate label" }),
          ],
        };
      }
      return { protocolVersion: 2, sessions: [terminalSession()] };
    });
    const discovery = new RelayV2CanonicalTwRpcDiscoveryAdapter({
      scopes: [scope("ssh", "configured-host")],
      queryPort: port,
      queryTimeoutMs: 5,
    });
    const store = await RelayV2HostStateStore.open({
      paths: relayV2HostStatePaths(temporaryHome),
    });
    const foundation = new RelayV2MaterializedStateFoundation({
      hostId: "host-under-test",
      discovery,
      store,
      readinessSink: { apply: () => true },
    });

    const seeded = await foundation.reconcile();
    const seededCut = (await foundation.sessionsSnapshot(
      "seeded-cut",
      seeded.snapshot.hostEpoch,
      null,
    )).payload;
    const seededSessionId = seededCut.scopes[0].items[0].sessionId;

    mode = "timeout";
    const unreachable = await foundation.reconcile();
    assert.equal(unreachable.readiness.snapshotMaterializationReady, false);
    assert.equal(unreachable.readiness.reason, "aggregate_coverage_partial");
    assert.equal(unreachable.events.some((event) => event.payload?.change?.op === "delete"), false);
    const staleAfterTimeout = (await foundation.sessionsSnapshot(
      "timeout-cut",
      unreachable.snapshot.hostEpoch,
      null,
    )).payload;
    assert.equal(staleAfterTimeout.scopes[0].completeness, "complete");
    assert.equal(staleAfterTimeout.scopes[0].items[0].sessionId, seededSessionId);

    mode = "duplicate";
    const duplicate = await foundation.reconcile();
    assert.equal(duplicate.readiness.reason, "aggregate_coverage_partial");
    assert.equal(duplicate.events.some((event) => event.payload?.change?.op === "delete"), false);
    const staleAfterDuplicate = (await foundation.sessionsSnapshot(
      "duplicate-cut",
      duplicate.snapshot.hostEpoch,
      null,
    )).payload;
    assert.equal(staleAfterDuplicate.scopes[0].completeness, "partial");
    assert.equal(staleAfterDuplicate.scopes[0].items[0].sessionId, seededSessionId);
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("discovery timeout waits for the query transport child barrier before preserving existing state", async () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "tw-rpc-v2-query-barrier-"));
  try {
    let mode = "complete";
    let controlled;
    const runner = {
      calls: [],
      spawn(request) {
        this.calls.push({
          executable: request.executable,
          argv: [...request.argv],
          shell: request.shell,
        });
        const command = request.argv.at(-1);
        if (mode === "blocked") {
          assert.equal(command, "capabilities");
          return controlled.handle;
        }
        const value = command === "capabilities"
          ? capabilities()
          : { protocolVersion: 2, sessions: [terminalSession()] };
        const stdout = encoder.encode(`${JSON.stringify(value)}\n`);
        return {
          stdout: {
            async *[Symbol.asyncIterator]() { yield stdout; },
          },
          stderr: {
            async *[Symbol.asyncIterator]() {},
          },
          exited: Promise.resolve({ exitCode: 0, signal: null }),
          kill: () => assert.fail("completed query must not be killed"),
        };
      },
    };
    const transport = new RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [{
        kind: "local",
        targetId: "explicit-local",
        executable: "/fake/canonical/tw",
      }],
      runner,
    });
    const discovery = new RelayV2CanonicalTwRpcDiscoveryAdapter({
      scopes: [scope("local", "explicit-local", "scope:explicit-local")],
      queryPort: transport,
      queryTimeoutMs: 5,
    });
    let observedScan;
    const trackedDiscovery = {
      scan() {
        observedScan = discovery.scan();
        return observedScan;
      },
    };
    const store = await RelayV2HostStateStore.open({
      paths: relayV2HostStatePaths(temporaryHome),
    });
    const foundation = new RelayV2MaterializedStateFoundation({
      hostId: "host-under-test",
      discovery: trackedDiscovery,
      store,
      readinessSink: { apply: () => true },
    });

    const seeded = await foundation.reconcile();
    const seededScan = observedScan;
    const seededCut = (await foundation.sessionsSnapshot(
      "seeded-barrier-cut",
      seeded.snapshot.hostEpoch,
      null,
    )).payload;
    const seededSessionId = seededCut.scopes[0].items[0].sessionId;

    let releaseBarrier;
    let killCalls = 0;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const lateStdout = encoder.encode(`${JSON.stringify(capabilities())}\n`);
    controlled = {
      handle: {
        stdout: {
          async *[Symbol.asyncIterator]() {
            await barrier;
            yield lateStdout;
          },
        },
        stderr: {
          async *[Symbol.asyncIterator]() { await barrier; },
        },
        exited: barrier.then(() => ({ exitCode: 0, signal: null })),
        kill(signal) {
          assert.equal(signal, "SIGKILL");
          killCalls += 1;
        },
      },
    };
    mode = "blocked";
    const pendingReconcile = foundation.reconcile();
    await waitUntil(() => observedScan !== seededScan, "discovery scan did not start");
    const pendingScan = observedScan;
    let scanSettled = false;
    pendingScan.then(
      () => { scanSettled = true; },
      () => { scanSettled = true; },
    );

    await waitUntil(() => killCalls === 1, "deadline did not kill the query child");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(killCalls, 1, "discovery and transport deadlines must share one kill");
    assert.equal(scanSettled, false, "scan must wait for exit and stdio barriers");

    releaseBarrier();
    const scan = await pendingScan;
    assert.equal(scan.coverage, "partial");
    assert.equal(scan.scopes[0].reachability, "unreachable");
    assert.equal(scan.scopes[0].sessionsCompleteness, "partial");
    assert.deepEqual(scan.scopes[0].sessions, []);
    assert.equal(scan.scopes[0].error.code, "SCOPE_UNREACHABLE");

    const reconciled = await pendingReconcile;
    assert.equal(reconciled.readiness.snapshotMaterializationReady, false);
    assert.equal(reconciled.events.some((event) => event.payload?.change?.op === "delete"), false);
    const preserved = (await foundation.sessionsSnapshot(
      "preserved-barrier-cut",
      reconciled.snapshot.hostEpoch,
      null,
    )).payload;
    assert.equal(preserved.scopes[0].items[0].sessionId, seededSessionId);
    assert.equal(killCalls, 1);
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});
