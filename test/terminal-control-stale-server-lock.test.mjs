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
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const terminalControl = await import(
  pathToFileURL(join(process.cwd(), "dist/terminalControl/index.js")).href
);

// Start a long-lived same-uid process whose pid we can point a stale owner
// record at, simulating pid reuse after a daemon was SIGKILLed.
function spawnLiveHolder() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return child;
}

function writeStaleServerLock(socketPath, pid) {
  const lockPath = `${socketPath}.server.lock`;
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ owner: `dead-daemon-${pid}-old`, pid, createdAt: Date.now() - 120_000 })}\n`,
    { mode: 0o600 },
  );
  return lockPath;
}

test("stale server lock is reclaimed when the daemon socket is dead even if its pid was reused", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-dead-"));
  const socketPath = join(root, "daemon.sock");
  const holder = spawnLiveHolder();
  const lockPath = writeStaleServerLock(socketPath, holder.pid);
  try {
    // No process is listening on socketPath (socket file absent => ECONNREFUSED
    // /ENOENT). The owner pid is a live unrelated process; only the socket
    // probe can prove the lock holder is gone.
    const lock = await terminalControl.acquireTerminalControlStoreLock(lockPath);
    assert.ok(lock.owner, "dead-daemon server lock must be reclaimed despite reused pid");
    terminalControl.releaseTerminalControlStoreLock(lock);
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale-looking server lock is never reclaimed while a daemon is answering the socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-live-"));
  // A raw Unix socket listener stands in for a live daemon holding a separate
  // server lock than the stale one we hand to the acquirer.
  const liveSocketPath = join(root, "live.sock");
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(liveSocketPath, resolve));
  const holder = spawnLiveHolder();
  const staleLockPath = writeStaleServerLock(liveSocketPath, holder.pid);
  try {
    let outcome;
    try {
      // The store lock wait budget is ~5s; a live/answering socket (or any
      // uncertainty) must keep the lock non-stale, so acquisition times out.
      await Promise.race([
        terminalControl.acquireTerminalControlStoreLock(staleLockPath),
        new Promise((_, reject) => setTimeout(() => reject(new Error("deadline-exceeded")), 7_000)),
      ]);
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, message: String((error && error.message) || error), code: error?.code };
    }
    assert.equal(outcome.ok, false, "live-daemon server lock must not be stolen");
    assert.match(outcome.message, /timed out waiting for terminal-control state lock/);
    assert.equal(existsSync(join(staleLockPath, "owner.json")), true, "stale owner record left intact");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
