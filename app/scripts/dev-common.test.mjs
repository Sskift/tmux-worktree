import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isolatedLauncherScript,
  isolatedRuntimeEnv,
  prepareIsolatedDevApp,
} from "./dev-common.mjs";

function listenUnix(socketPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

test("isolated Dashboard launchers use one short private socket namespace", async () => {
  const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "twd-source-"));
  const hostileTmpDir = path.join(
    sourceHome,
    "var-folders-style-tmpdir-that-is-deliberately-too-long-for-unix-sockets",
  );
  fs.mkdirSync(hostileTmpDir);
  fs.writeFileSync(
    path.join(sourceHome, ".tw-dashboard-layout.json"),
    '{"layout":"copied"}\n',
  );
  fs.writeFileSync(
    path.join(sourceHome, ".tw-dashboard-terminals.json"),
    '{"terminals":[{"aiCmd":"hostile-command"}]}\n',
  );
  const originalHome = process.env.HOME;
  const originalTmpDir = process.env.TMPDIR;
  let isolated;
  let secondIsolated;
  try {
    process.env.HOME = sourceHome;
    process.env.TMPDIR = hostileTmpDir;
    isolated = prepareIsolatedDevApp("tw-dashboard-test");
    secondIsolated = prepareIsolatedDevApp("tw-dashboard-test");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
  }
  try {
    const canonicalSystemTmp = fs.realpathSync.native("/tmp");
    assert.equal(path.dirname(isolated.tempRoot), canonicalSystemTmp);
    if (process.platform === "darwin") {
      assert.equal(canonicalSystemTmp, "/private/tmp");
    }
    assert.equal(fs.realpathSync.native(isolated.tempRoot), isolated.tempRoot);
    assert.notEqual(secondIsolated.tempRoot, isolated.tempRoot);
    assert.notEqual(
      secondIsolated.socketPaths.relayV2ExactCompound,
      isolated.socketPaths.relayV2ExactCompound,
    );
    assert.equal(
      fs.readFileSync(path.join(isolated.tempHome, ".tw-dashboard-layout.json"), "utf8"),
      '{"layout":"copied"}\n',
    );
    assert.equal(
      fs.existsSync(path.join(isolated.tempHome, ".tw-dashboard-terminals.json")),
      false,
    );
    const metadata = fs.lstatSync(isolated.tmuxTmpDir);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.mode & 0o777, 0o700);
    if (typeof process.getuid === "function") {
      assert.equal(metadata.uid, process.getuid());
    }
    assert.equal(
      isolated.socketPaths.terminalControl,
      path.join(
        isolated.tempHome,
        ".tmux-worktree",
        "terminal-control-v1.sock",
      ),
    );
    assert.equal(
      path.dirname(isolated.socketPaths.relayV2ExactCompound),
      path.dirname(isolated.socketPaths.terminalControl),
    );
    assert.match(
      path.basename(isolated.socketPaths.relayV2ExactCompound),
      /^\.relay-v2-exact-[0-9a-f]{16}\.sock$/,
    );
    for (const [label, socketPath] of Object.entries(isolated.socketPaths)) {
      assert.ok(
        Buffer.byteLength(socketPath, "utf8") <= 100,
        `${label} socket path exceeds 100 UTF-8 bytes: ${socketPath}`,
      );
    }

    fs.mkdirSync(path.dirname(isolated.socketPaths.tmux), { recursive: true });
    fs.mkdirSync(path.dirname(isolated.socketPaths.terminalControl), {
      recursive: true,
    });
    const listeners = await Promise.all(
      Object.values(isolated.socketPaths).map(listenUnix),
    );
    await Promise.all(
      listeners.map((server) => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      })),
    );

    const runtimeEnv = isolatedRuntimeEnv(isolated, {
      PATH: process.env.PATH,
      TMUX: "/tmp/real-tmux/default,123,0",
      TMUX_PANE: "%42",
      TW_TERMINAL_CONTROL_SOCKET: "/tmp/real-terminal-control.sock",
      TW_TERMINAL_CONTROL_STATE: "/tmp/real-terminal-control-state.json",
      TW_TERMINAL_CONTROL_OUTPUT_DIR: "/tmp/real-terminal-control-output",
    });
    assert.equal(runtimeEnv.TW_DASHBOARD_HOME, isolated.tempHome);
    assert.equal(runtimeEnv.TMUX_TMPDIR, isolated.tmuxTmpDir);
    assert.equal("TMUX" in runtimeEnv, false);
    assert.equal("TMUX_PANE" in runtimeEnv, false);
    assert.equal("TW_TERMINAL_CONTROL_SOCKET" in runtimeEnv, false);
    assert.equal("TW_TERMINAL_CONTROL_STATE" in runtimeEnv, false);
    assert.equal("TW_TERMINAL_CONTROL_OUTPUT_DIR" in runtimeEnv, false);

    const bundleDir = path.join(isolated.tempRoot, "bundle");
    const launcherPath = path.join(bundleDir, "app");
    const realBinaryPath = path.join(bundleDir, "app-real");
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(
      realBinaryPath,
      "#!/bin/sh\nprintf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \"$TW_DASHBOARD_HOME\" \"$TMUX_TMPDIR\" \"${TMUX-unset}\" \"${TMUX_PANE-unset}\" \"${TW_TERMINAL_CONTROL_SOCKET-unset}\" \"${TW_TERMINAL_CONTROL_STATE-unset}\" \"${TW_TERMINAL_CONTROL_OUTPUT_DIR-unset}\"\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(launcherPath, isolatedLauncherScript(isolated), {
      mode: 0o755,
    });

    const launched = spawnSync(launcherPath, [], {
      encoding: "utf8",
      env: {
        ...process.env,
        TW_DASHBOARD_HOME: "/tmp/wrong-dashboard-home",
        TMUX_TMPDIR: "/tmp/wrong-tmux",
        TMUX: "/tmp/real-tmux/default,123,0",
        TMUX_PANE: "%42",
        TW_TERMINAL_CONTROL_SOCKET: "/tmp/real-terminal-control.sock",
        TW_TERMINAL_CONTROL_STATE: "/tmp/real-terminal-control-state.json",
        TW_TERMINAL_CONTROL_OUTPUT_DIR: "/tmp/real-terminal-control-output",
      },
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(launched.stdout.trimEnd().split("\n"), [
      isolated.tempHome,
      isolated.tmuxTmpDir,
      "unset",
      "unset",
      "unset",
      "unset",
      "unset",
    ]);
  } finally {
    if (isolated) {
      fs.rmSync(isolated.tempRoot, { recursive: true, force: true });
    }
    if (secondIsolated) {
      fs.rmSync(secondIsolated.tempRoot, { recursive: true, force: true });
    }
    fs.rmSync(sourceHome, { recursive: true, force: true });
  }
});
