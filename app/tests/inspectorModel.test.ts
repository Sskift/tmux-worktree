import assert from "node:assert/strict";
import test from "node:test";
import {
  INSPECTOR_TABS,
  moveInspectorTab,
} from "../src/dashboard/inspectorModel.ts";

test("inspector keyboard navigation follows the planned tabs and wraps", () => {
  assert.deepEqual(INSPECTOR_TABS, ["files", "git", "diff", "feishu"]);
  assert.equal(moveInspectorTab("files", -1), "feishu");
  assert.equal(moveInspectorTab("files", 1), "git");
  assert.equal(moveInspectorTab("feishu", 1), "files");
});
