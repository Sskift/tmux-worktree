import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DashboardCatalogSnapshot, PlainTerminal, Session } from "../src/platform";
import { mergeDashboardCatalogSnapshot } from "../src/dashboard/model/catalogSnapshot";

const localSession: Session = {
  name: "local",
  rawName: "local",
  attached: false,
  window_count: 1,
  created: 1,
  activity: 1,
};

const remoteSession: Session = {
  ...localSession,
  name: "build:foo",
  rawName: "foo",
  hostId: "build",
};

const remoteTerminal: PlainTerminal = {
  id: "ssh:build:tw-term-one",
  label: "one",
  cwd: "/work",
  tmuxName: "build:tw-term-one",
  rawName: "tw-term-one",
  hostId: "build",
};

function snapshot(overrides: Partial<DashboardCatalogSnapshot> = {}): DashboardCatalogSnapshot {
  return {
    sessions: [localSession],
    terminals: [],
    failedSessionHostIds: [],
    failedTerminalHostIds: [],
    ...overrides,
  };
}

describe("mergeDashboardCatalogSnapshot", () => {
  it("preserves last-known remote entries only for hosts whose refresh failed", () => {
    const merged = mergeDashboardCatalogSnapshot(
      [remoteSession],
      [remoteTerminal],
      snapshot({
        failedSessionHostIds: ["build"],
        failedTerminalHostIds: ["build"],
      }),
    );

    assert.deepEqual(merged.sessions.map((session) => session.name), ["local", "build:foo"]);
    assert.deepEqual(merged.terminals, [remoteTerminal]);
    assert.match(merged.partialError ?? "", /build/);
  });

  it("accepts an authoritative empty remote result after the host recovers", () => {
    const merged = mergeDashboardCatalogSnapshot(
      [remoteSession],
      [remoteTerminal],
      snapshot(),
    );

    assert.deepEqual(merged.sessions, [localSession]);
    assert.deepEqual(merged.terminals, []);
    assert.equal(merged.partialError, null);
  });

  it("does not duplicate entries returned alongside a partial failure", () => {
    const merged = mergeDashboardCatalogSnapshot(
      [remoteSession],
      [remoteTerminal],
      snapshot({
        sessions: [localSession, remoteSession],
        terminals: [remoteTerminal],
        failedSessionHostIds: ["build"],
        failedTerminalHostIds: ["build"],
      }),
    );

    assert.equal(merged.sessions.filter((session) => session.name === remoteSession.name).length, 1);
    assert.equal(merged.terminals.length, 1);
  });
});
