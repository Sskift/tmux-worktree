import assert from "node:assert/strict";
import test from "node:test";
import {
  describeSessionActivity,
  formatActivityAge,
} from "../src/dashboard/model/sessionActivity.ts";

test("describeSessionActivity marks sessions running when the agent title is active", () => {
  const activity = describeSessionActivity(
    { name: "demo", agentRunning: true, outputSignature: "same" },
    { outputSignature: "same", lastChangedAt: 100 },
    130,
  );

  assert.equal(activity.state, "running");
  assert.equal(activity.label, "running");
  assert.equal(activity.ageSeconds, 0);
  assert.equal(activity.lastChangedAt, 130);
});

test("describeSessionActivity trusts stopped agent title over output changes", () => {
  const activity = describeSessionActivity(
    { name: "demo", agentRunning: false, outputSignature: "after" },
    { outputSignature: "before", lastChangedAt: 100 },
    145,
  );

  assert.equal(activity.state, "stopped");
  assert.equal(activity.label, "45s");
  assert.equal(activity.changed, true);
  assert.equal(activity.lastChangedAt, 100);
});

test("describeSessionActivity falls back to output changes when agent title is unavailable", () => {
  const activity = describeSessionActivity(
    { name: "demo", outputSignature: "after" },
    { outputSignature: "before", lastChangedAt: null },
    130,
  );

  assert.equal(activity.state, "running");
  assert.equal(activity.label, "running");
  assert.equal(activity.changed, true);
  assert.equal(activity.ageSeconds, 0);
  assert.equal(activity.lastChangedAt, 130);
});

test("describeSessionActivity marks unchanged output stopped", () => {
  const activity = describeSessionActivity(
    { name: "demo", outputSignature: "same" },
    { outputSignature: "same", lastChangedAt: 100 },
    145,
  );

  assert.equal(activity.state, "stopped");
  assert.equal(activity.label, "45s");
  assert.equal(activity.changed, false);
  assert.equal(activity.lastChangedAt, 100);
});

test("describeSessionActivity marks first comparison unknown", () => {
  const activity = describeSessionActivity(
    { name: "demo", outputSignature: "first" },
    undefined,
    281,
  );

  assert.equal(activity.state, "unknown");
  assert.equal(activity.label, "--");
  assert.equal(activity.changed, false);
  assert.equal(activity.lastChangedAt, null);
});

test("describeSessionActivity handles missing output signature", () => {
  const activity = describeSessionActivity(
    { name: "demo", outputSignature: null },
    { outputSignature: "before", lastChangedAt: 100 },
    281,
  );

  assert.equal(activity.state, "unknown");
  assert.equal(activity.label, "--");
  assert.equal(activity.ageSeconds, null);
  assert.equal(activity.lastChangedAt, 100);
});

test("formatActivityAge uses compact labels", () => {
  assert.equal(formatActivityAge(0), "0s");
  assert.equal(formatActivityAge(59), "59s");
  assert.equal(formatActivityAge(60), "1m");
  assert.equal(formatActivityAge(3_599), "59m");
  assert.equal(formatActivityAge(3_600), "1h");
});
