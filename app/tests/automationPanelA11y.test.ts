import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { AutomationPanel } from "../src/AutomationPanel";
import type { Automation, AutomationRun } from "../src/automationTypes";

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
      onCreate: () => {},
      onToggle: () => {},
      onRun: () => {},
      onDelete: () => {},
      onSave: () => {},
    }),
  );

  const listItem = markup.indexOf('role="listitem"');
  const selectButton = markup.indexOf('class="automation-list__select"', listItem);
  const selectButtonClose = markup.indexOf("</button>", selectButton);
  const deleteButton = markup.indexOf('class="session__kill"', selectButtonClose);

  assert.ok(listItem >= 0);
  assert.ok(selectButton > listItem);
  assert.ok(selectButtonClose > selectButton);
  assert.ok(
    deleteButton > selectButtonClose,
    "Delete is a sibling button, so its Enter/Space event cannot bubble into the selection control",
  );
  assert.doesNotMatch(markup, /role="button"/);
});

test("automation run history owns its styles instead of depending on legacy Git log classes", () => {
  const run: AutomationRun = {
    id: "daily-review-2026-07-11",
    automationId: automation.id,
    status: "running",
    startedAt: "2026-07-11T09:00:00.000Z",
    finishedAt: null,
    target: "dashboard",
    sessionName: "tw-dashboard-daily-review",
    message: null,
  };
  const markup = renderToStaticMarkup(
    createElement(AutomationPanel, {
      automations: [automation],
      selectedId: automation.id,
      runs: [run],
      onSelect: () => {},
      onNew: () => {},
      onCreate: () => {},
      onToggle: () => {},
      onRun: () => {},
      onDelete: () => {},
      onSave: () => {},
    }),
  );

  assert.match(markup, /class="automation-run"/);
  assert.match(markup, /class="automation-run__status automation-run__status--running"/);
  assert.match(markup, /class="automation-run__summary"/);
  assert.doesNotMatch(markup, /class="[^"]*git__/);

  const styles = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(styles, /\.automation-run\s*\{/);
  assert.match(styles, /\.automation-run__status--running\s*\{/);
  assert.match(styles, /\.automation-run__summary\s*\{/);
});
