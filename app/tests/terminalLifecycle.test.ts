import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_RECONNECT_MAX_ATTEMPTS,
  remoteReconnectDelayMs,
  shouldReconnectTmuxAttach,
} from "../src/terminalLifecycle.ts";

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

test("shouldReconnectTmuxAttach reattaches remote ssh when the tmux session still exists", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: true,
      isRemote: true,
    }),
    true,
  );
});

test("shouldReconnectTmuxAttach bounds repeated remote attach failures even when tmux exists", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: true,
      isRemote: true,
      remoteReconnectAttempt: REMOTE_RECONNECT_MAX_ATTEMPTS - 1,
    }),
    true,
  );
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: true,
      isRemote: true,
      remoteReconnectAttempt: REMOTE_RECONNECT_MAX_ATTEMPTS,
    }),
    false,
  );
});

test("shouldReconnectTmuxAttach stops remote ssh after a confirmed missing session", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: false,
      isRemote: true,
    }),
    false,
  );
});

test("shouldReconnectTmuxAttach retries a remote SSH probe failure within a bounded budget", () => {
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: false,
      sessionProbeFailed: true,
      isRemote: true,
      remoteReconnectAttempt: REMOTE_RECONNECT_MAX_ATTEMPTS - 1,
    }),
    true,
  );
  assert.equal(
    shouldReconnectTmuxAttach({
      cancelled: false,
      hasTmuxSession: true,
      sessionStillExists: false,
      sessionProbeFailed: true,
      isRemote: true,
      remoteReconnectAttempt: REMOTE_RECONNECT_MAX_ATTEMPTS,
    }),
    false,
  );
});

test("remoteReconnectDelayMs applies capped exponential backoff", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(remoteReconnectDelayMs),
    [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
  );
});
