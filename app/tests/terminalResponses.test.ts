import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalProtocolReply } from "../src/terminal/terminalResponses.ts";

test("terminal protocol replies are separated from real managed input", () => {
  for (const reply of [
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[24;80R",
    "\x1b[0n",
    "\x1b[8;24;80t",
    "\x1b[?2026;1$y",
    "\x1b]11;rgb:0d0d/0e0e/1010\x1b\\",
    "\x1bP1+r544e=787465726d2d323536636f6c6f72\x1b\\",
    "\x1b[?1;2c\x1b[24;80R",
  ]) {
    assert.equal(isTerminalProtocolReply(reply), true, JSON.stringify(reply));
  }

  for (const input of [
    "hello",
    "\x1b[A",
    "\x1b[15~",
    "\x1b[6n",
    "\x1b[18t",
    "\x1b[1;2x",
    "\x1b[<0;10;5M",
    "\x1b[200~pasted\x1b[201~",
    "\x1b]2;title\x07",
  ]) {
    assert.equal(isTerminalProtocolReply(input), false, JSON.stringify(input));
  }
});
