import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const terminalControl = await import(
  pathToFileURL(join(process.cwd(), "dist/terminalControl/index.js")).href
);

// A long-lived same-uid process stands in for the pid a SIGKILLed daemon's
// owner record used to hold — after pid wrap/reuse an unrelated process keeps
// a pid-only liveness check convinced the lock owner is alive.
function spawnLiveHolder() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// Run with HOME pointed at an isolated root so terminalControlStatePath() and
// terminalControlSocketPath() both resolve inside it; the default state lock
// is `${statePath}.lock` and the daemon socket its canonical sibling.
async function withIsolatedHome(root, fn) {
  const home = join(root, "home");
  mkdirSync(join(home, ".tmux-worktree"), { recursive: true, mode: 0o700 });
  const previousHome = process.env.HOME;
  const previousState = process.env.TW_TERMINAL_CONTROL_STATE;
  const previousSocket = process.env.TW_TERMINAL_CONTROL_SOCKET;
  process.env.HOME = home;
  delete process.env.TW_TERMINAL_CONTROL_STATE;
  delete process.env.TW_TERMINAL_CONTROL_SOCKET;
  try {
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousState === undefined) delete process.env.TW_TERMINAL_CONTROL_STATE;
    else process.env.TW_TERMINAL_CONTROL_STATE = previousState;
    if (previousSocket === undefined) delete process.env.TW_TERMINAL_CONTROL_SOCKET;
    else process.env.TW_TERMINAL_CONTROL_SOCKET = previousSocket;
  }
}

test("stale default state lock is reclaimed via dead daemon socket despite reused pid", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-state-lock-dead-"));
  const holder = spawnLiveHolder();
  try {
    await withIsolatedHome(root, async () => {
      const statePath = terminalControl.terminalControlStatePath();
      const lockPath = `${statePath}.lock`;
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ owner: `dead-daemon-${holder.pid}-old`, pid: holder.pid, createdAt: Date.now() - 120_000 })}\n`,
        { mode: 0o600 },
      );
      // Nothing is listening on the canonical daemon socket: the probe proves
      // the holder is gone even though the recorded pid is a live process.
      const lock = await terminalControl.acquireTerminalControlStoreLock(lockPath);
      assert.ok(lock.owner, "dead-daemon state lock must be reclaimed despite reused pid");
      terminalControl.releaseTerminalControlStoreLock(lock);
    });
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale-looking state lock is never reclaimed while a daemon answers the canonical socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-state-lock-live-"));
  const holder = spawnLiveHolder();
  const server = createServer(() => {});
  let liveSocketPath;
  try {
    await withIsolatedHome(root, async () => {
      const socketPath = terminalControl.terminalControlSocketPath();
      liveSocketPath = socketPath;
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const statePath = terminalControl.terminalControlStatePath();
      const lockPath = `${statePath}.lock`;
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ owner: `live-daemon-${holder.pid}`, pid: holder.pid, createdAt: Date.now() - 120_000 })}\n`,
        { mode: 0o600 },
      );
      let outcome;
      try {
        await Promise.race([
          terminalControl.acquireTerminalControlStoreLock(lockPath),
          new Promise((_, reject) => setTimeout(() => reject(new Error("deadline-exceeded")), 7_000)),
        ]);
        outcome = { ok: true };
      } catch (error) {
        outcome = { ok: false, message: String((error && error.message) || error) };
      }
      assert.equal(outcome.ok, false, "live-daemon state lock must not be stolen");
      assert.match(outcome.message, /timed out waiting for terminal-control state lock/);
      assert.equal(existsSync(join(lockPath, "owner.json")), true, "stale owner record left intact");
    });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    // The canonical socket can live under the tmpdir fallback (long home
    // path), outside root; remove its directory so it never leaks between runs.
    if (liveSocketPath) rmSync(dirname(liveSocketPath), { recursive: true, force: true });
  }
});
