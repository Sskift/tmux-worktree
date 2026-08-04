import assert from "node:assert/strict";
import test from "node:test";
import type { PlainTerminal, Session } from "../src/platform/domainTypes.ts";
import type { SessionActivityInfo } from "../src/dashboard/model/sessionActivity.ts";
import {
  samePlainTerminals,
  sameSessionActivity,
  sameSessions,
  sameStringArray,
  sameStringRecord,
} from "../src/dashboard/model/catalogEquality.ts";

const session: Session = {
  name: "builder:repo-fix",
  attached: false,
  window_count: 2,
  created: 10,
  activity: 20,
  output_signature: "output-a",
  agent_running: true,
  hostId: "builder",
  rawName: "repo-fix",
  project: "repo",
  managed: true,
};

const terminal: PlainTerminal = {
  id: "terminal-1",
  label: "Shell",
  cwd: "/repo",
  tmuxName: "builder:tw-term-one",
  hostId: "builder",
  rawName: "tw-term-one",
  aiCmd: "codex",
  discovered: true,
  managed: true,
};

test("session equality compares every catalog field including snake_case wire fields", () => {
  assert.equal(sameSessions([session], [{ ...session }]), true);

  for (const changed of [
    { name: "other" },
    { attached: true },
    { window_count: 3 },
    { created: 11 },
    { activity: 21 },
    { output_signature: "output-b" },
    { agent_running: false },
    { hostId: "relay" },
    { rawName: "other" },
    { project: "other" },
    { managed: false },
  ] satisfies Array<Partial<Session>>) {
    assert.equal(sameSessions([session], [{ ...session, ...changed }]), false, JSON.stringify(changed));
  }

  const defaults: Session = {
    name: "local",
    attached: false,
    window_count: 1,
    created: 1,
    activity: 1,
  };
  assert.equal(
    sameSessions(
      [defaults],
      [{
        ...defaults,
        output_signature: null,
        agent_running: null,
        hostId: null,
        rawName: "",
        project: "",
        managed: false,
      }],
    ),
    true,
  );

  const otherSession: Session = {
    ...session,
    name: "relay:repo-review",
    rawName: "repo-review",
    hostId: "relay",
  };
  assert.equal(sameSessions([session, otherSession], [otherSession, session]), false);
});

test("plain terminal equality compares identity, location, command, and discovery flags", () => {
  assert.equal(samePlainTerminals([terminal], [{ ...terminal }]), true);

  for (const changed of [
    { id: "terminal-2" },
    { label: "Other" },
    { cwd: "/other" },
    { tmuxName: "builder:other" },
    { hostId: "relay" },
    { rawName: "other" },
    { aiCmd: "claude" },
    { discovered: false },
    { managed: false },
  ] satisfies Array<Partial<PlainTerminal>>) {
    assert.equal(
      samePlainTerminals([terminal], [{ ...terminal, ...changed }]),
      false,
      JSON.stringify(changed),
    );
  }

  const otherTerminal: PlainTerminal = {
    ...terminal,
    id: "terminal-2",
    tmuxName: "relay:tw-term-two",
    rawName: "tw-term-two",
    hostId: "relay",
  };
  assert.equal(
    samePlainTerminals([terminal, otherTerminal], [otherTerminal, terminal]),
    false,
  );
});

test("catalog collection and activity equality preserve order and exact values", () => {
  assert.equal(sameStringArray(["a", "b"], ["a", "b"]), true);
  assert.equal(sameStringArray(["a", "b"], ["b", "a"]), false);
  assert.equal(sameStringRecord({ a: "1", b: "2" }, { b: "2", a: "1" }), true);
  assert.equal(sameStringRecord({ a: "1" }, { a: "2" }), false);

  const activity: SessionActivityInfo = {
    state: "stopped",
    label: "10s",
    changed: false,
    ageSeconds: 10,
    lastChangedAt: 100,
    outputSignature: "same",
  };
  assert.equal(sameSessionActivity({ session: activity }, { session: { ...activity } }), true);
  for (const changed of [
    { state: "running" },
    { label: "running" },
    { changed: true },
    { ageSeconds: 11 },
    { lastChangedAt: 101 },
  ] satisfies Array<Partial<SessionActivityInfo>>) {
    assert.equal(
      sameSessionActivity(
        { session: activity },
        { session: { ...activity, ...changed } },
      ),
      false,
      JSON.stringify(changed),
    );
  }
  assert.equal(
    sameSessionActivity(
      { session: activity },
      { session: { ...activity, outputSignature: "different" } },
    ),
    false,
  );
  assert.equal(sameSessionActivity({ session: activity }, {}), false);
  assert.equal(
    sameSessionActivity(
      { session: activity },
      { session: { ...activity }, extra: { ...activity } },
    ),
    false,
  );
  assert.equal(
    sameSessionActivity(
      { session: activity, extra: { ...activity } },
      { session: { ...activity } },
    ),
    false,
  );
});
