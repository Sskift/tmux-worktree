import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  readRendererImplementationTree,
  rendererImplementationSourceContaining,
} from "./helpers/rendererImplementationSource.ts";

const renderer = readRendererImplementationTree();

test("Settings and Command Palette are reachable without unmounting TerminalDeck", () => {
  const composition = rendererImplementationSourceContaining(
    "<CommandPalette",
    "<SettingsDialog",
    "<TerminalDeck",
  ).source;
  assert.match(composition, /<CommandPalette\s+open=\{commandPaletteOpen\}/);
  assert.match(composition, /<SettingsDialog\s+open=\{settingsOpen\}/);
  assert.match(composition, /event\.metaKey/);
  assert.match(composition, /event\.key !== ","/);
  assert.match(composition, /settingsOpen \|\|\s*commandPaletteOpen/);
  assert.match(composition, /blocked=\{anyModalOpen\}/);
});

test("the Settings shortcut never stacks over creation or directory-picker modals", () => {
  const { source } = rendererImplementationSourceContaining(
    "const handleSettingsShortcut",
    "window.addEventListener",
  );
  const shortcutStart = source.indexOf("const handleSettingsShortcut");
  const shortcutEnd = source.indexOf("window.addEventListener", shortcutStart);
  const shortcut = source.slice(shortcutStart, shortcutEnd);

  assert.match(shortcut, /showNewWorktree \|\|\s*showNewTerminal \|\|/);
  assert.match(shortcut, /openSettings\(settingsOpen \? settingsSection : "general"\)/);
  assert.match(source, /setCommandPaletteOpen\(false\);\s*setSettingsSection\(section\);/);
  assert.match(source, /\{showNewTerminal && \(\s*<NewTerminalModal/s);
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
  const composition = rendererImplementationSourceContaining(
    "connections:",
    "<ConnectionsSettings",
    "relaySettingsBindingsFromController(mobileRelay)",
  ).source;
  assert.match(composition, /connections:\s*\(\s*<ConnectionsSettings/);
  assert.match(composition, /sshHostCandidates=\{sshHostCandidates\}/);
  assert.match(composition, /relaySettingsBindingsFromController\(mobileRelay\)/);
  assert.match(composition, /onOpenSettings=\{\(\) => openSettings\("general"\)\}/);
  assert.match(sidebar, /className="tw-dashboard-sidebar__connection-title">Settings</);
  assert.match(sidebar, /onClick=\{\(\) => onOpenSettings\(\)\}/);
  assert.doesNotMatch(renderer, /<AddHostModal/);
  assert.doesNotMatch(renderer, /className="remote-popover"/);
  assert.doesNotMatch(renderer, />\+ host</);
});
