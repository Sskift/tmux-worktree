import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalControlBanner } from "../src/terminal/TerminalControlBanner";

test("terminal recovery visibly reports progress and the canonical failure reason", () => {
  const status = {
    controlled: true,
    readOnly: true,
    state: "RECOVERY_REQUIRED" as const,
    ownerKind: "relay-v1" as const,
    canTakeOver: false,
    canRecover: true,
    message: "PERMISSION_DENIED: recovery was prepared for a stale controller epoch",
  };

  const failed = renderToStaticMarkup(createElement(TerminalControlBanner, {
    status,
    recoveryPending: false,
    actionError: null,
    onTakeover() {},
    onRecover() {},
  }));
  assert.match(failed, /terminal input continuity needs local recovery/);
  assert.match(failed, /stale controller epoch/);
  assert.match(failed, />Recover local input</);

  const pending = renderToStaticMarkup(createElement(TerminalControlBanner, {
    status,
    recoveryPending: true,
    actionError: null,
    onTakeover() {},
    onRecover() {},
  }));
  assert.match(pending, /disabled=""/);
  assert.match(pending, />Recovering…</);
});
