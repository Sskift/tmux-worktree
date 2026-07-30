import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isolatedLauncherScript,
  isolatedRuntimeEnv,
  prepareIsolatedDevApp,
} from "./dev-common.mjs";

test("isolated Dashboard launchers use one private tmux namespace", () => {
  const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "twd-source-"));
  fs.writeFileSync(
    path.join(sourceHome, ".tw-dashboard-layout.json"),
    '{"layout":"copied"}\n',
  );
  fs.writeFileSync(
    path.join(sourceHome, ".tw-dashboard-terminals.json"),
    '{"terminals":[{"aiCmd":"hostile-command"}]}\n',
  );
  const originalHome = process.env.HOME;
  let isolated;
  try {
    process.env.HOME = sourceHome;
    isolated = prepareIsolatedDevApp("tw-dashboard-test");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
  try {
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
    const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
    const tmuxSocketPath = path.join(isolated.tmuxTmpDir, `tmux-${uid}`, "default");
    assert.ok(
      Buffer.byteLength(tmuxSocketPath, "utf8") <= 100,
      `tmux socket path exceeds 100 UTF-8 bytes: ${tmuxSocketPath}`,
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
    fs.rmSync(sourceHome, { recursive: true, force: true });
  }
});
