import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const newWorktreeModal = readFileSync(
  new URL("../src/NewWorktreeModal.tsx", import.meta.url),
  "utf8",
);
const newTerminalModal = readFileSync(
  new URL("../src/NewTerminalModal.tsx", import.meta.url),
  "utf8",
);
const remoteDirectoryPicker = readFileSync(
  new URL("../src/RemoteDirectoryPicker.tsx", import.meta.url),
  "utf8",
);

test("creation modals expose labeled dialogs with trapped focus and Escape close", () => {
  for (const source of [newWorktreeModal, newTerminalModal]) {
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /aria-labelledby=\{titleId\}/);
    assert.match(source, /tabIndex=\{-1\}/);
    assert.match(source, /event\.key === "Escape"/);
    assert.match(source, /keepFocusInside\(event\.nativeEvent, dialogRef\.current\)/);
    assert.match(source, /requestAnimationFrame\(\(\) => initialFocusRef\.current\?\.focus\(\)\)/);
    assert.match(source, /focusTarget\?\.isConnected/);
  }
});

test("nested remote picker makes its parent dialog inert without unmounting the form", () => {
  for (const source of [newWorktreeModal, newTerminalModal]) {
    assert.match(source, /aria-hidden=\{showRemotePicker \? true : undefined\}/);
    assert.match(source, /inert=\{showRemotePicker\}/);
    assert.match(source, /<\/form>\s*\{showRemotePicker && isRemote && \(/s);
  }
});

test("remote directory picker traps focus and restores the browse trigger", () => {
  assert.match(remoteDirectoryPicker, /role="dialog"/);
  assert.match(remoteDirectoryPicker, /aria-modal="true"/);
  assert.match(remoteDirectoryPicker, /aria-labelledby=\{titleId\}/);
  assert.match(remoteDirectoryPicker, /ref=\{initialFocusRef\}/);
  assert.match(remoteDirectoryPicker, /returnFocusRef\?\.current \?\?/);
  assert.match(remoteDirectoryPicker, /event\.key === "Escape"/);
  assert.match(
    remoteDirectoryPicker,
    /keepFocusInside\(event\.nativeEvent, dialogRef\.current\)/,
  );
  assert.match(remoteDirectoryPicker, /focusTarget\?\.isConnected/);
});
