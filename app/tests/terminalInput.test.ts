import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlledTerminalOutputFilter,
  isControlledTerminalTransportReport,
} from "../src/terminalInput.ts";

test("controlled terminal transport reports are never treated as pane input", () => {
  assert.equal(isControlledTerminalTransportReport("\x1b[<0;12;7M"), true);
  assert.equal(isControlledTerminalTransportReport("\x1b[32;12;7M"), true);
  assert.equal(isControlledTerminalTransportReport("\x1b[M" + " !!"), true);
  assert.equal(isControlledTerminalTransportReport("\x1b[I\x1b[O"), true);

  assert.equal(isControlledTerminalTransportReport("\x1b[3~"), false);
  assert.equal(isControlledTerminalTransportReport("\x1b[A"), false);
  assert.equal(isControlledTerminalTransportReport("\x7f"), false);
  assert.equal(isControlledTerminalTransportReport("text"), false);
});

test("controlled output strips mouse and focus enables across chunk boundaries", () => {
  const filter = new ControlledTerminalOutputFilter();

  assert.equal(filter.push("before\x1b[?1000;"), "before");
  assert.equal(filter.push("1006hafter\x1b[?25;1004h"), "after\x1b[?25h");
  assert.equal(filter.push("\x1b[?1000l\x1b[?2004h"), "\x1b[?1000l\x1b[?2004h");
  assert.equal(filter.flush(), "");
});
