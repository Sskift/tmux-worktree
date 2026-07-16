import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const identity = await import("../dist/relay/v2/canonicalBackendIdentity.js");
const discovery = await import("../dist/relay/v2/canonicalTwRpcDiscovery.js");
const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/relay-v2-canonical-backend-identity-v1.json", import.meta.url),
  "utf8",
));

function terminalSession(vector, overrides = {}) {
  return {
    name: "raw-tmux-backend-1",
    kind: "terminal",
    profile: "dashboard",
    project: null,
    label: "Persisted display-2",
    repoPath: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    cwd: "/repo/demo",
    createdAt: "2026-07-12T00:00:01.000Z",
    attached: false,
    windows: 1,
    created: 1_783_700_010,
    activity: 1_783_700_020,
    incarnation: vector.incarnation,
    lifecycleMarked: true,
    reservationCorrelation: null,
    ...overrides,
  };
}

test("canonical backend identity fixture is shared by direct and discovery entry points", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.domain, "tmux-worktree.relay-v2.backend-instance.v1");
  const keys = [];
  for (const vector of fixture.vectors) {
    const input = {
      processTarget: vector.processTarget,
      incarnation: vector.incarnation,
    };
    assert.equal(
      identity.issueRelayV2CanonicalBackendInstanceKey(input),
      vector.expected,
      vector.name,
    );
    const projected = discovery.projectRelayV2CanonicalTwRpcDiscoveredSession({
      processTarget: vector.processTarget,
      session: terminalSession(vector),
    });
    assert.equal(projected.backendIdentity, vector.expected, vector.name);
    assert.equal(projected.displayName, "Persisted display-2");
    assert.equal(JSON.stringify(projected).includes("raw-tmux-backend-1"), false);
    keys.push(vector.expected);
  }
  assert.equal(new Set(keys).size, fixture.vectors.length);
});

test("canonical backend identity and discovery inputs are closed and fail closed", () => {
  const vector = fixture.vectors[0];
  for (const malformed of [
    { processTarget: vector.processTarget, incarnation: vector.incarnation, extra: true },
    {
      processTarget: { ...vector.processTarget, scopeId: "public-scope-must-not-participate" },
      incarnation: vector.incarnation,
    },
    { processTarget: vector.processTarget, incarnation: `twinc2.${"!".repeat(43)}` },
  ]) {
    assert.throws(
      () => identity.issueRelayV2CanonicalBackendInstanceKey(malformed),
      /canonical backend/,
    );
  }
  assert.throws(
    () => discovery.projectRelayV2CanonicalTwRpcDiscoveredSession({
      processTarget: vector.processTarget,
      session: terminalSession(vector, { label: null }),
    }),
    /persisted display label/,
  );
  assert.throws(
    () => discovery.projectRelayV2CanonicalTwRpcDiscoveredSession({
      processTarget: vector.processTarget,
      session: terminalSession(vector, { repoPath: "/repo/demo" }),
    }),
    /worktree fields/,
  );
});
