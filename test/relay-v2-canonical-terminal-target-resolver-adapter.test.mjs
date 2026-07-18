import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const canonicalBackendIdentity = await import(
  "../dist/relay/v2/canonicalBackendIdentity.js"
);
const adapterModule = await import(
  "../dist/relay/v2/canonicalTerminalTargetResolverAdapter.js"
);
const hostState = await import("../dist/relay/v2/hostState.js");
const terminalLineage = await import("../dist/relay/v2/terminalDurableLineage.js");

const HOST_EPOCH = "adapter-host-epoch";
const TARGET = {
  hostId: "mac-admin",
  scopeId: "scope-local",
  sessionId: "session-exact",
};
const PROCESS_TARGET = { kind: "local", targetId: "adapter-process" };
const INCARNATION = `twinc2.${"c".repeat(43)}`;
const BACKEND_INSTANCE_KEY =
  canonicalBackendIdentity.issueRelayV2CanonicalBackendInstanceKey({
    processTarget: PROCESS_TARGET,
    incarnation: INCARNATION,
  });
const RESOURCE_TARGET = {
  authorization: "evidence_only",
  hostEpoch: HOST_EPOCH,
  discoveryGeneration: "adapter-discovery-generation",
  scopeId: TARGET.scopeId,
  processTarget: PROCESS_TARGET,
  capabilities: ["terminal.stream.v1"],
  sessionId: TARGET.sessionId,
  backendInstanceKey: BACKEND_INSTANCE_KEY,
  managedTarget: {
    name: "adapter-managed-terminal",
    kind: "terminal",
    incarnation: INCARNATION,
  },
};
const RESOURCE_TOKEN = {
  schemaVersion: 1,
  hostEpoch: HOST_EPOCH,
  resourceMappingDigest: "adapter-resource-digest",
  discoveryGeneration: RESOURCE_TARGET.discoveryGeneration,
};
const EXACT_IDENTITY = {
  schemaVersion: 1,
  controlTargetId: "adapter-control-target",
  controlEpoch: "adapter-control-epoch",
  targetIncarnationProof: "adapter-target-incarnation-proof",
};

function managerError(code) {
  return (error) => {
    assert.equal(error?.name, "RelayV2TerminalManagerError");
    assert.equal(error.code, code);
    return true;
  };
}

function exactEvidence(input) {
  return {
    ...structuredClone(input),
    exactControlToken: "adapter-exact-control-token",
    exactControlIdentity: structuredClone(EXACT_IDENTITY),
  };
}

function harness(overrides = {}) {
  const calls = [];
  const resourceResolver = {
    async captureToken(hostEpoch) {
      calls.push(["h2.capture", hostEpoch]);
      return structuredClone(RESOURCE_TOKEN);
    },
    async resolveSession(token, scopeId, sessionId) {
      calls.push(["h2.resolve", structuredClone(token), scopeId, sessionId]);
      return structuredClone(RESOURCE_TARGET);
    },
    fenceSessionForAdmission(transaction, token, scopeId, sessionId, target) {
      calls.push([
        "h2.fence",
        transaction.hostEpoch,
        structuredClone(token),
        scopeId,
        sessionId,
        structuredClone(target),
      ]);
      return typeof overrides.h2FenceResult === "function"
        ? overrides.h2FenceResult()
        : overrides.h2FenceResult;
    },
  };
  const exactControlTarget = overrides.omitExact
    ? undefined
    : {
        async resolveExactTarget(input) {
          calls.push(["exact.resolve", structuredClone(input)]);
          return overrides.exactEvidence?.(input) ?? exactEvidence(input);
        },
        fenceExactTargetForAdmission(input, evidence) {
          calls.push(["exact.fence", structuredClone(input), structuredClone(evidence)]);
          return typeof overrides.exactFenceResult === "function"
            ? overrides.exactFenceResult()
            : overrides.exactFenceResult;
        },
      };
  return {
    calls,
    adapter: new adapterModule.RelayV2CanonicalTerminalTargetResolverAdapter({
      resourceResolver,
      ...(exactControlTarget ? { exactControlTarget } : {}),
    }),
  };
}

async function resolve(h) {
  return h.adapter.resolve({
    auth: { principalId: "principal", clientInstanceId: "client" },
    hostEpoch: HOST_EPOCH,
    target: structuredClone(TARGET),
    pane: 0,
  });
}

test("exact terminal resolver defaults to NO-GO before any H2 lookup", async () => {
  const h = harness({ omitExact: true });
  await assert.rejects(resolve(h), managerError("CAPABILITY_UNAVAILABLE"));
  assert.deepEqual(h.calls, []);
});

test("exact terminal resolver binds H2 incarnation and pane to versioned control identity", async () => {
  const h = harness();
  const resolution = await resolve(h);
  assert.deepEqual(resolution.binding, {
    schemaVersion: 1,
    ...TARGET,
    pane: 0,
    processTarget: PROCESS_TARGET,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedTarget: RESOURCE_TARGET.managedTarget,
    exactControlIdentity: EXACT_IDENTITY,
  });
  assert.deepEqual(resolution.target, {
    ...TARGET,
    pane: 0,
    canonicalTargetId: BACKEND_INSTANCE_KEY,
    controlTargetId: EXACT_IDENTITY.controlTargetId,
  });

  h.adapter.fenceSessionForAdmission({ hostEpoch: HOST_EPOCH }, resolution);
  assert.deepEqual(h.calls.map(([name]) => name), [
    "h2.capture",
    "h2.resolve",
    "exact.resolve",
    "h2.fence",
    "exact.fence",
  ]);
  assert.deepEqual(h.calls.find(([name]) => name === "h2.fence"), [
    "h2.fence",
    HOST_EPOCH,
    RESOURCE_TOKEN,
    TARGET.scopeId,
    TARGET.sessionId,
    RESOURCE_TARGET,
  ]);
});

test("name-only exact-control evidence is unavailable and never reaches a fence", async () => {
  const h = harness({
    exactEvidence: () => ({
      sessionName: RESOURCE_TARGET.managedTarget.name,
      controlTargetId: EXACT_IDENTITY.controlTargetId,
    }),
  });
  await assert.rejects(resolve(h), managerError("CAPABILITY_UNAVAILABLE"));
  assert.deepEqual(h.calls.map(([name]) => name), [
    "h2.capture",
    "h2.resolve",
    "exact.resolve",
  ]);
});

test("an asynchronous H2 sub-fence aborts before exact-control fencing", async () => {
  const h = harness({
    h2FenceResult: () => Promise.resolve("unsafe H2 completion"),
  });
  const resolution = await resolve(h);
  assert.throws(
    () => h.adapter.fenceSessionForAdmission({ hostEpoch: HOST_EPOCH }, resolution),
    managerError("CAPABILITY_UNAVAILABLE"),
  );
  assert.equal(h.calls.filter(([name]) => name === "h2.fence").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "exact.fence").length, 0);
});

test("a throwing then getter from an adapter sub-fence fails closed synchronously", async () => {
  const h = harness({
    h2FenceResult: () => Object.defineProperty({}, "then", {
      get() {
        throw new Error("unsafe adapter then getter");
      },
    }),
  });
  const resolution = await resolve(h);
  assert.throws(
    () => h.adapter.fenceSessionForAdmission({ hostEpoch: HOST_EPOCH }, resolution),
    managerError("CAPABILITY_UNAVAILABLE"),
  );
  assert.equal(h.calls.filter(([name]) => name === "h2.fence").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "exact.fence").length, 0);
});

test("an asynchronous exact-control sub-fence aborts after synchronous H2 verification", async () => {
  const h = harness({
    exactFenceResult: () => Promise.resolve("unsafe exact completion"),
  });
  const resolution = await resolve(h);
  assert.throws(
    () => h.adapter.fenceSessionForAdmission({ hostEpoch: HOST_EPOCH }, resolution),
    managerError("CAPABILITY_UNAVAILABLE"),
  );
  assert.equal(h.calls.filter(([name]) => name === "h2.fence").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "exact.fence").length, 1);
});

test("each asynchronous adapter sub-fence leaves H0 unprepared", async (t) => {
  for (const subFence of ["h2", "exact"]) {
    await t.test(subFence, async () => {
      const home = mkdtempSync(join(tmpdir(), `tw-terminal-adapter-${subFence}-`));
      try {
        const h = harness({
          ...(subFence === "h2"
            ? { h2FenceResult: () => Promise.resolve("unsafe H2 completion") }
            : { exactFenceResult: () => Promise.resolve("unsafe exact completion") }),
        });
        const resolution = await resolve(h);
        const store = await hostState.RelayV2HostStateStore.open({
          paths: hostState.relayV2HostStatePaths(home),
        });
        const authority = new terminalLineage.RelayV2TerminalDurableLineageAuthority({
          store,
          now: () => 1_000_000,
          admissionFence: h.adapter,
        });
        const claim = {
          key: `terminal-open:adapter-${subFence}`,
          streamKey: `terminal-stream:adapter-${subFence}`,
          fingerprint: (subFence === "h2" ? "1" : "2").repeat(64),
          hostInstanceId: store.hostInstanceId,
          target: structuredClone(TARGET),
          pane: 0,
          resumeTokenHash: null,
          mode: "new",
          previousGeneration: null,
          requestedOffset: null,
          expiresAtMs: 1_600_000,
        };
        const winner = await authority.claimOpen(claim);
        assert.equal(winner.status, "claimed");
        await assert.rejects(authority.prepareOpen({
          key: claim.key,
          fingerprint: claim.fingerprint,
          hostInstanceId: store.hostInstanceId,
          claimToken: winner.claimToken,
          fence: winner.fence,
          preparation: { kind: "current", resolution },
        }), (error) => (
          error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE"
        ));
        const snapshot = await store.read();
        const state = Object.values(snapshot.materialized).find((value) => (
          value?.authority === "relay_v2_terminal_durable_lineage"
        ));
        assert.equal(state.openRecords[0].preparedBinding, null);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
