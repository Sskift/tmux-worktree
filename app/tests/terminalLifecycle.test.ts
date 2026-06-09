import assert from "node:assert/strict";
import test from "node:test";
import { shouldReconnectTmuxAttach } from "../src/terminalLifecycle.ts";

test("shouldReconnectTmuxAttach reconnects when attached tmux session still exists", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: true,
    }),
    true,
  );
});

test("shouldReconnectTmuxAttach leaves terminal exited when the tmux session is gone", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: false,
    }),
    false,
  );
});

test("shouldReconnectTmuxAttach does not reconnect plain non-tmux ptys", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: false,
      sessionStillExists: true,
    }),
    false,
  );
});
