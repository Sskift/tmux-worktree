import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSPACE_STATUS_LABELS,
  workspaceStatusLabel,
} from "../src/dashboard/model/workspaceSelectors.ts";

test("workspace states always expose readable labels in addition to color", () => {
  assert.deepEqual(WORKSPACE_STATUS_LABELS, {
    running: "Running",
    waiting: "Waiting",
    stopped: "Stopped",
    unknown: "Unknown",
    offline: "SSH offline",
    reconnecting: "Reconnecting",
  });
  assert.equal(workspaceStatusLabel("reconnecting"), "Reconnecting");
});
