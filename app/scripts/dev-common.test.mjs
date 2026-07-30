import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  isolatedLauncherScript,
  isolatedRuntimeEnv,
  prepareIsolatedDevApp,
} from "./dev-common.mjs";

test("isolated Dashboard launchers use one private tmux namespace", () => {
  const isolated = prepareIsolatedDevApp("tw-dashboard-test");
  try {
    const metadata = fs.lstatSync(isolated.tmuxTmpDir);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.mode & 0o777, 0o700);
    if (typeof process.getuid === "function") {
      assert.equal(metadata.uid, process.getuid());
    }

    const runtimeEnv = isolatedRuntimeEnv(isolated, {
      PATH: process.env.PATH,
      TMUX: "/tmp/real-tmux/default,123,0",
      TW_TERMINAL_CONTROL_SOCKET: "/tmp/real-terminal-control.sock",
      TW_TERMINAL_CONTROL_STATE: "/tmp/real-terminal-control-state.json",
    });
    assert.equal(runtimeEnv.TW_DASHBOARD_HOME, isolated.tempHome);
    assert.equal(runtimeEnv.TMUX_TMPDIR, isolated.tmuxTmpDir);
    assert.equal("TMUX" in runtimeEnv, false);
    assert.equal("TW_TERMINAL_CONTROL_SOCKET" in runtimeEnv, false);
    assert.equal("TW_TERMINAL_CONTROL_STATE" in runtimeEnv, false);

    const bundleDir = path.join(isolated.tempRoot, "bundle");
    const launcherPath = path.join(bundleDir, "app");
    const realBinaryPath = path.join(bundleDir, "app-real");
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(
      realBinaryPath,
      "#!/bin/sh\nprintf '%s\\n%s\\n%s\\n%s\\n%s\\n' \"$TW_DASHBOARD_HOME\" \"$TMUX_TMPDIR\" \"${TMUX-unset}\" \"${TW_TERMINAL_CONTROL_SOCKET-unset}\" \"${TW_TERMINAL_CONTROL_STATE-unset}\"\n",
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
        TW_TERMINAL_CONTROL_SOCKET: "/tmp/real-terminal-control.sock",
        TW_TERMINAL_CONTROL_STATE: "/tmp/real-terminal-control-state.json",
      },
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(launched.stdout.trimEnd().split("\n"), [
      isolated.tempHome,
      isolated.tmuxTmpDir,
      "unset",
      "unset",
      "unset",
    ]);
  } finally {
    fs.rmSync(isolated.tempRoot, { recursive: true, force: true });
  }
});
