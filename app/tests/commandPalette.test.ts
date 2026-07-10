import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPaletteController,
  filterCommandPaletteItems,
  groupCommandPaletteItems,
  type CommandPaletteItem,
} from "../src/dashboard/useCommandPalette.ts";

const noop = () => undefined;

const items: CommandPaletteItem[] = [
  {
    id: "settings-connections",
    group: "settings",
    label: "Open connection settings",
    detail: "Manage SSH hosts and Relay",
    keywords: ["preferences", "remote"],
    execute: noop,
  },
  {
    id: "automation-cleanup",
    group: "automation",
    label: "Cleanup orphan worktrees",
    keywords: ["prune", "maintenance"],
    execute: noop,
  },
  {
    id: "navigate-terminal",
    group: "navigate",
    label: "Open terminal ‘ppt’",
    detail: "Jump to the presentation worktree",
    execute: noop,
  },
  {
    id: "action-bind",
    group: "actions",
    label: "Bind current worktree to Feishu chat",
    detail: "Attach Hermes to the current terminal",
    keywords: ["lark", "message relay"],
    execute: noop,
  },
  {
    id: "recent-dashboard",
    group: "recent",
    label: "Reopen dashboard redesign",
    execute: noop,
  },
];

test("filter searches label, detail, and keywords with token and case normalization", () => {
  assert.deepEqual(
    filterCommandPaletteItems(items, "FEISHU hermes").map((item) => item.id),
    ["action-bind"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, "presentation terminal").map((item) => item.id),
    ["navigate-terminal"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, "REMOTE ssh").map((item) => item.id),
    ["settings-connections"],
  );
  assert.deepEqual(filterCommandPaletteItems(items, "no-such-command"), []);
});

test("grouping follows product order while preserving item order inside each group", () => {
  const grouped = groupCommandPaletteItems(items);
  assert.deepEqual(
    grouped.map((group) => group.id),
    ["actions", "navigate", "automation", "recent", "settings"],
  );
  assert.deepEqual(grouped[0]?.items.map((item) => item.id), ["action-bind"]);
});

test("controller resets selection to the first match when the query changes", () => {
  const initial = commandPaletteController.create(items);
  assert.deepEqual(initial, { query: "", activeId: "action-bind" });

  const filtered = commandPaletteController.setQuery(initial, items, "worktree");
  assert.deepEqual(filtered, { query: "worktree", activeId: "action-bind" });

  const empty = commandPaletteController.setQuery(filtered, items, "missing");
  assert.deepEqual(empty, { query: "missing", activeId: null });
});

test("controller keyboard navigation wraps in both directions", () => {
  const visible = filterCommandPaletteItems(items, "");
  const start = commandPaletteController.create(items);
  const previous = commandPaletteController.move(start, visible, -1);
  assert.equal(previous.activeId, "settings-connections");

  const wrappedForward = commandPaletteController.move(previous, visible, 1);
  assert.equal(wrappedForward.activeId, "action-bind");

  const next = commandPaletteController.move(wrappedForward, visible, 1);
  assert.equal(next.activeId, "navigate-terminal");
});

test("controller selection and reconciliation never point at a hidden command", () => {
  const visible = filterCommandPaletteItems(items, "");
  const start = commandPaletteController.create(items);
  const selected = commandPaletteController.select(start, visible, "action-bind");
  assert.equal(selected.activeId, "action-bind");

  const ignored = commandPaletteController.select(selected, visible, "not-visible");
  assert.equal(ignored, selected);

  const filtered = filterCommandPaletteItems(items, "settings");
  const reconciled = commandPaletteController.reconcile(selected, filtered);
  assert.equal(reconciled.activeId, "settings-connections");

  const noResults = commandPaletteController.reconcile(reconciled, []);
  assert.equal(noResults.activeId, null);
});

test("disabled commands remain discoverable so the UI can explain why", () => {
  const disabled: CommandPaletteItem = {
    id: "bind-disabled",
    group: "actions",
    label: "Bind current worktree",
    disabledReason: "Select a worktree first",
    execute: noop,
  };
  const visible = filterCommandPaletteItems([disabled], "bind");
  const state = commandPaletteController.create([disabled], "bind");

  assert.deepEqual(visible, [disabled]);
  assert.equal(state.activeId, disabled.id);
});
