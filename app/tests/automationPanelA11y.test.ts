import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { AutomationPanel } from "../src/AutomationPanel";
import type { Automation } from "../src/automationTypes";

const automation: Automation = {
  id: "daily-review",
  name: "Daily review",
  instruction: "Review the workspace",
  aiCmd: "claude",
  project: "dashboard",
  path: "",
  schedule: "0 9 * * 1-5",
  allowOverlap: false,
  active: true,
};

test("automation selection and deletion are sibling native buttons", () => {
  const markup = renderToStaticMarkup(
    createElement(AutomationPanel, {
      automations: [automation],
      selectedId: automation.id,
      runs: [],
      onSelect: () => {},
      onNew: () => {},
      onCreate: () => true,
      onToggle: () => {},
      onRun: () => {},
      onDelete: () => {},
      onSave: () => true,
    }),
  );

  const listItem = markup.indexOf('role="listitem"');
  const selectButton = markup.indexOf("<button", listItem);
  const selectButtonClose = markup.indexOf("</button>", selectButton);
  const deleteLabel = markup.indexOf('aria-label="delete Daily review"', selectButtonClose);
  const deleteButton = markup.lastIndexOf("<button", deleteLabel);

  assert.ok(listItem >= 0);
  assert.ok(selectButton > listItem);
  assert.ok(selectButtonClose > selectButton);
  assert.ok(
    deleteLabel > selectButtonClose && deleteButton > selectButtonClose,
    "Delete is a sibling button, so its Enter/Space event cannot bubble into the selection control",
  );
  assert.doesNotMatch(markup, /role="button"/);
});
