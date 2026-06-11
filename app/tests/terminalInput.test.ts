import assert from "node:assert/strict";
import test from "node:test";
import { terminalEscapeAction } from "../src/terminalInput.ts";

test("Escape outside the active terminal only focuses it", () => {
  assert.equal(
    terminalEscapeAction({
      key: "Escape",
      type: "keydown",
      terminalActive: true,
      terminalFocused: false,
    }),
    "focus-terminal",
  );
});

test("Escape inside tmux copy-mode cancels copy-mode instead of reaching the agent", () => {
  assert.equal(
    terminalEscapeAction({
      key: "Escape",
      type: "keydown",
      terminalActive: true,
      terminalFocused: true,
      tmuxPaneInMode: true,
    }),
    "cancel-copy-mode",
  );
});

test("Escape inside the terminal reaches the agent TUI when tmux is not in copy-mode", () => {
  assert.equal(
    terminalEscapeAction({
      key: "Escape",
      type: "keydown",
      terminalActive: true,
      terminalFocused: true,
      tmuxPaneInMode: false,
    }),
    "send-to-terminal",
  );
});

test("non-active or non-Escape events are ignored", () => {
  assert.equal(
    terminalEscapeAction({
      key: "Enter",
      type: "keydown",
      terminalActive: true,
      terminalFocused: false,
    }),
    "ignore",
  );
  assert.equal(
    terminalEscapeAction({
      key: "Escape",
      type: "keyup",
      terminalActive: true,
      terminalFocused: false,
    }),
    "ignore",
  );
  assert.equal(
    terminalEscapeAction({
      key: "Escape",
      type: "keydown",
      terminalActive: false,
      terminalFocused: false,
    }),
    "ignore",
  );
});

test("Escape outside the terminal is not stolen from focused UI controls", () => {
  assert.equal(
    terminalEscapeAction({
      key: "Escape",
      type: "keydown",
      terminalActive: true,
      terminalFocused: false,
      targetHandlesEscape: true,
    }),
    "ignore",
  );
});
