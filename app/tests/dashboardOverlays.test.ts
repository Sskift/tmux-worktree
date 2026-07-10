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

test("Host and Relay configuration live in Connections Settings", () => {
  assert.match(app, /connections:\s*\(\s*<ConnectionsSettings/);
  assert.match(app, /sshHostCandidates=\{sshHostCandidates\}/);
  assert.match(app, /relaySettingsBindingsFromController\(mobileRelay\)/);
  assert.match(app, /onClick=\{\(\) => openSettings\("connections"\)\}/);
  assert.doesNotMatch(app, /<AddHostModal/);
  assert.doesNotMatch(app, /className="remote-popover"/);
  assert.doesNotMatch(app, />\+ host</);
});
