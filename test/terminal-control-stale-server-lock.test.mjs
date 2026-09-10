import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const terminalControl = await import(
  pathToFileURL(join(process.cwd(), "dist/terminalControl/index.js")).href
);
const terminalControlCli = join(process.cwd(), "dist", "cli.cjs");

// Start a long-lived same-uid process whose pid we can point a stale owner
// record at, simulating pid reuse after a daemon was SIGKILLed.
function spawnLiveHolder() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return child;
}

function exitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("exit", () => resolve(child.pid));
    child.once("error", reject);
  });
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

// Write a fresh/aged owner record for a server lock derived from socketPath.
// pid === undefined simulates a legacy record written by an older release.
function writeServerLock(socketPath, { pid, ageMs = 0 }) {
  const lockPath = `${socketPath}.server.lock`;
  mkdirSync(lockPath, { mode: 0o700 });
  const record = pid === undefined
    ? { owner: "legacy-holder", createdAt: Date.now() - ageMs }
    : { owner: `holder-${pid}`, pid, createdAt: Date.now() - ageMs };
  writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  if (ageMs > 0) {
    // In production the lock directory's mtime also dates from the holder's
    // lifetime (it only changes when entries change); backdate it alongside
    // the owner record so the legacy mtime gate sees realistically old state.
    const aged = Date.now() - ageMs;
    utimesSync(lockPath, aged / 1_000, aged / 1_000);
  }
  return lockPath;
}

async function acquireIfReclaimed(lockPath, waitMs = 6_500) {
  let outcome;
  try {
    const lock = await Promise.race([
      terminalControl.acquireTerminalControlStoreLock(lockPath),
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadline-exceeded")), waitMs)),
    ]);
    outcome = { reclaimed: true, lock };
  } catch (error) {
    outcome = { reclaimed: false, message: String((error && error.message) || error) };
  }
  return outcome;
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

test("fresh server lock with a confirmed-dead pid and no socket is reclaimed immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-fresh-dead-"));
  const socketPath = join(root, "daemon.sock");
  const deadPid = await exitedPid();
  const lockPath = writeServerLock(socketPath, { pid: deadPid, ageMs: 0 });
  try {
    const started = Date.now();
    const outcome = await acquireIfReclaimed(lockPath);
    const elapsed = Date.now() - started;
    assert.equal(outcome.reclaimed, true, "fresh lock of a crashed daemon must be reclaimed now, not after 60s");
    assert.ok(elapsed < 2_000, `reclaim took ${elapsed}ms; expected well under the 60s age gate`);
    terminalControl.releaseTerminalControlStoreLock(outcome.lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh server lock held by the live current process is never reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-fresh-self-"));
  const socketPath = join(root, "daemon.sock");
  const lockPath = writeServerLock(socketPath, { pid: process.pid, ageMs: 0 });
  try {
    const outcome = await acquireIfReclaimed(lockPath);
    assert.equal(outcome.reclaimed, false, "fresh lock of a live pid must not be stolen");
    assert.match(outcome.message, /timed out waiting for terminal-control state lock/);
    assert.equal(existsSync(join(lockPath, "owner.json")), true, "owner record left intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh server lock with a live unrelated pid is kept, then reclaimed once past the 60s gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-fresh-reused-"));
  const socketPath = join(root, "daemon.sock");
  const holder = spawnLiveHolder();
  const freshLockPath = writeServerLock(socketPath, { pid: holder.pid, ageMs: 0 });
  const agedRoot = mkdtempSync(join(tmpdir(), "tc-server-lock-aged-reused-"));
  const agedSocketPath = join(agedRoot, "daemon.sock");
  const agedLockPath = writeServerLock(agedSocketPath, { pid: holder.pid, ageMs: 120_000 });
  try {
    const fresh = await acquireIfReclaimed(freshLockPath);
    assert.equal(fresh.reclaimed, false, "a reused live pid blocks immediate reclaim");
    const aged = await acquireIfReclaimed(agedLockPath);
    assert.equal(aged.reclaimed, true, "past the age gate a dead socket allows reclaim despite a live pid");
    terminalControl.releaseTerminalControlStoreLock(aged.lock);
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    rmSync(agedRoot, { recursive: true, force: true });
  }
});

test("legacy pid-less server lock keeps the 60s createdAt age gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-legacy-"));
  const socketPath = join(root, "daemon.sock");
  const freshLockPath = writeServerLock(socketPath, { pid: undefined, ageMs: 0 });
  const agedRoot = mkdtempSync(join(tmpdir(), "tc-server-lock-legacy-aged-"));
  const agedSocketPath = join(agedRoot, "daemon.sock");
  const agedLockPath = writeServerLock(agedSocketPath, { pid: undefined, ageMs: 120_000 });
  try {
    const fresh = await acquireIfReclaimed(freshLockPath);
    assert.equal(fresh.reclaimed, false, "pid-less lock younger than 60s must self-heal only via the age gate");
    const aged = await acquireIfReclaimed(agedLockPath);
    assert.equal(aged.reclaimed, true, "pid-less lock older than 60s with a dead socket must be reclaimed");
    terminalControl.releaseTerminalControlStoreLock(aged.lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(agedRoot, { recursive: true, force: true });
  }
});

function daemonPidsFor(socketPath) {
  // pgrep -f can match the probing shell itself; resolve pids with ps and keep
  // only real terminal-control serve children bound to socketPath.
  const listed = spawnSync("pgrep", ["-f", socketPath], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  return listed.stdout.split(/\s+/).map((value) => Number(value.trim())).filter((pid) => {
    if (!Number.isInteger(pid) || pid === process.pid) return false;
    const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    return args.includes("terminal-control") && args.includes("serve") && args.includes(socketPath);
  });
}

async function stopDaemon(socketPath) {
  const lockPath = `${socketPath}.server.lock`;
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) return;
  let pid;
  try {
    pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid;
  } catch {
    return;
  }
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 2_000;
  while (existsSync(lockPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("auto-start recovers within 2s after a fresh daemon is SIGKILLed and ten clients start one daemon", { timeout: 40_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-server-lock-restart-"));
  const socketPath = join(root, "restart.sock");
  const statePath = join(root, "restart-state.json");
  const cliTarget = {
    executable: process.execPath,
    entrypoint: terminalControlCli,
    idleExitMs: 600_000,
  };
  try {
    // First request starts the original daemon.
    await terminalControl.requestTerminalControl(
      { type: "ping" },
      { socketPath, autoStart: true, autoStartCliTarget: cliTarget, autoStartStatePath: statePath, timeoutMs: 15_000 },
    );
    const firstOwnerPid = JSON.parse(readFileSync(`${socketPath}.server.lock/owner.json`, "utf8")).pid;
    // Let the daemon live ~5s so its owner record is far younger than the 60s
    // age gate, then SIGKILL it (crash / pkill / upgrade simulation).
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    process.kill(firstOwnerPid, "SIGKILL");
    // The lock dir lingers after SIGKILL; the request must reclaim it
    // immediately rather than spinning until the 60s gate.
    const started = Date.now();
    const clients = Array.from({ length: 10 }, () => terminalControl.requestTerminalControl(
      { type: "ping" },
      { socketPath, autoStart: true, autoStartCliTarget: cliTarget, autoStartStatePath: statePath, timeoutMs: 15_000 },
    ));
    const results = await Promise.allSettled(clients);
    const elapsed = Date.now() - started;
    const failures = results.filter((result) => result.status === "rejected");
    assert.equal(failures.length, 0, failures[0] && String(failures[0].reason));
    for (const result of results) {
      assert.equal(result.value.authority, "local-terminal-control");
    }
    assert.ok(elapsed < 2_000, `recovery after SIGKILL took ${elapsed}ms; expected <2s, not ~60s`);
    // Exactly one daemon may end up serving the socket. Rival spawned
    // processes block on the server lock and give up at the ~5s lock-wait
    // deadline without ever binding the socket; wait for them to self-terminate
    // before counting.
    const settleDeadline = Date.now() + 9_000;
    let pids = [];
    while (Date.now() < settleDeadline) {
      pids = daemonPidsFor(socketPath);
      if (pids.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(pids.length, 1, `expected one daemon for ${socketPath}, found ${pids.length}: ${pids.join(",")}`);
  } finally {
    await stopDaemon(socketPath);
    rmSync(root, { recursive: true, force: true });
  }
});
