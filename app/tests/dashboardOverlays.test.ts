import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("Settings and Command Palette are reachable without unmounting TerminalDeck", () => {
  assert.match(app, /<CommandPalette\s+open=\{commandPaletteOpen\}/);
  assert.match(app, /<SettingsDialog\s+open=\{settingsOpen\}/);
  assert.match(app, /event\.metaKey/);
  assert.match(app, /event\.key !== ","/);
  assert.match(app, /settingsOpen \|\|\s*commandPaletteOpen/);
  assert.match(app, /blocked=\{anyModalOpen\}/);
});

test("the Settings shortcut never stacks over creation or directory-picker modals", () => {
  const shortcutStart = app.indexOf("const handleSettingsShortcut");
  const shortcutEnd = app.indexOf("window.addEventListener", shortcutStart);
  const shortcut = app.slice(shortcutStart, shortcutEnd);

  assert.match(shortcut, /showNewWorktree \|\|\s*showNewTerminal \|\|/);
  assert.match(shortcut, /openSettings\(settingsOpen \? settingsSection : "general"\)/);
  assert.match(app, /setCommandPaletteOpen\(false\);\s*setSettingsSection\(section\);/);
  assert.match(app, /\{showNewTerminal && \(\s*<NewTerminalModal/s);
  assert.match(
    readFileSync(new URL("../src/NewTerminalModal.tsx", import.meta.url), "utf8"),
    /<RemoteDirectoryPicker/,
  );
});

test("Host and Relay configuration live in Connections Settings", () => {
  const sidebar = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(app, /connections:\s*\(\s*<ConnectionsSettings/);
  assert.match(app, /sshHostCandidates=\{sshHostCandidates\}/);
  assert.match(app, /relaySettingsBindingsFromController\(mobileRelay\)/);
  assert.match(app, /onOpenSettings=\{\(\) => openSettings\("general"\)\}/);
  assert.match(sidebar, /className="tw-dashboard-sidebar__connection-title">Settings</);
  assert.match(sidebar, /onClick=\{\(\) => onOpenSettings\(\)\}/);
  assert.doesNotMatch(app, /<AddHostModal/);
  assert.doesNotMatch(app, /className="remote-popover"/);
  assert.doesNotMatch(app, />\+ host</);
});
