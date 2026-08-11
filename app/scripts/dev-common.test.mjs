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

function closeUnix(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("isolated Dashboard launchers use one short private socket namespace", async () => {
  const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "twd-source-"));
  const sensitiveServiceMarker = "must-not-reach-isolated-dashboard";
  const expectedHosts = [
    {
      id: "devbox",
      host: "devbox.example",
      futureHostField: { keep: true },
    },
  ];
  const expectedProjects = {
    dashboard: {
      path: "/repo/dashboard",
      futureProjectField: "keep",
    },
  };
  const expectedUnknownExtension = {
    contract: "future-dashboard-extension",
    nested: { keep: true },
  };
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
  const sourceConfigPath = path.join(sourceHome, ".tmux-worktree.json");
  fs.writeFileSync(
    sourceConfigPath,
    `${JSON.stringify({
      hosts: expectedHosts,
      projects: expectedProjects,
      worktreeBase: "/private/tmp/worktrees",
      feishuBridge: { marker: sensitiveServiceMarker },
      futureDashboardExtension: expectedUnknownExtension,
    })}\n`,
    { mode: 0o600 },
  );
  const selfHostedConfigPath = path.join(
    sourceHome,
    ".tmux-worktree",
    "relay-v2-self-hosted",
    "dashboard-config-v1.json",
  );
  fs.mkdirSync(path.dirname(selfHostedConfigPath), { recursive: true });
  fs.writeFileSync(selfHostedConfigPath, '{"marker":"account-owned"}\n', {
    mode: 0o600,
  });
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
    assert.match(path.basename(isolated.tempRoot), /^w-.{6}$/);
    assert.equal(isolated.tempHome, path.join(isolated.tempRoot, "h"));
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
    const isolatedConfigPath = path.join(
      isolated.tempHome,
      ".tmux-worktree.json",
    );
    const isolatedConfigText = fs.readFileSync(isolatedConfigPath, "utf8");
    assert.equal(isolatedConfigText.includes(sensitiveServiceMarker), false);
    const isolatedConfig = JSON.parse(isolatedConfigText);
    assert.equal(Object.hasOwn(isolatedConfig, "feishuBridge"), false);
    assert.deepEqual(isolatedConfig.hosts, expectedHosts);
    assert.deepEqual(isolatedConfig.projects, expectedProjects);
    assert.equal(isolatedConfig.worktreeBase, "/private/tmp/worktrees");
    assert.deepEqual(
      isolatedConfig.futureDashboardExtension,
      expectedUnknownExtension,
    );
    assert.equal(fs.lstatSync(isolatedConfigPath).mode & 0o777, 0o600);

    const sourceConfigAfter = JSON.parse(
      fs.readFileSync(sourceConfigPath, "utf8"),
    );
    assert.equal(Object.hasOwn(sourceConfigAfter, "feishuBridge"), true);
    assert.equal(fs.existsSync(selfHostedConfigPath), true);
    assert.equal(
      fs.existsSync(
        path.join(
          isolated.tempHome,
          ".tmux-worktree",
          "relay-v2-self-hosted",
          "dashboard-config-v1.json",
        ),
      ),
      false,
    );
    for (const privateDirectory of [
      isolated.tempRoot,
      isolated.tempHome,
      path.join(isolated.tempHome, ".tmux-worktree"),
    ]) {
      const metadata = fs.lstatSync(privateDirectory);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.mode & 0o777, 0o700);
      if (
        typeof process.getuid === "function"
        && typeof process.getgid === "function"
      ) {
        assert.equal(metadata.uid, process.getuid());
        assert.equal(metadata.gid, process.getgid());
      }
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
    assert.equal(
      isolated.sshControlPaths.template,
      path.join(isolated.tempHome, ".tmux-worktree", "ssh", "%C"),
    );
    assert.equal(
      isolated.sshControlPaths.temporaryBind,
      `${
        isolated.sshControlPaths.template.replace("%C", "c".repeat(40))
      }.${"r".repeat(16)}`,
    );
    assert.ok(
      Buffer.byteLength(isolated.sshControlPaths.temporaryBind, "utf8") <= 103,
      "ordinary SSH temporary ControlPath bind exceeds 103 UTF-8 bytes",
    );

    fs.mkdirSync(path.dirname(isolated.socketPaths.tmux), { recursive: true });
    fs.mkdirSync(path.dirname(isolated.socketPaths.terminalControl), {
      recursive: true,
    });
    fs.mkdirSync(path.dirname(isolated.sshControlPaths.temporaryBind), {
      recursive: true,
      mode: 0o700,
    });
    const listeners = [];
    const bindPaths = [
      ...Object.values(isolated.socketPaths),
      isolated.sshControlPaths.temporaryBind,
    ];
    const listenAttempts = bindPaths.map(async (socketPath) => {
      const listener = await listenUnix(socketPath);
      listeners.push(listener);
    });
    try {
      await Promise.all(listenAttempts);
    } finally {
      await Promise.allSettled(listenAttempts);
      await Promise.allSettled(listeners.map(closeUnix));
    }

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

test("isolated Dashboard config copy fails closed and cleans its temp root", () => {
  for (const invalidConfig of ["{", "[]"]) {
    const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "twd-invalid-source-"));
    const sourceConfigPath = path.join(sourceHome, ".tmux-worktree.json");
    fs.writeFileSync(sourceConfigPath, invalidConfig, { mode: 0o600 });

    const originalHome = process.env.HOME;
    const originalMkdtempSync = fs.mkdtempSync;
    let isolatedTempRoot;
    try {
      fs.mkdtempSync = (...args) => {
        isolatedTempRoot = Reflect.apply(originalMkdtempSync, fs, args);
        return isolatedTempRoot;
      };
      process.env.HOME = sourceHome;
      assert.throws(
        () => prepareIsolatedDevApp("tw-dashboard-invalid-config-test"),
        /isolated Dashboard config must be a valid top-level JSON object/,
      );
      assert.equal(typeof isolatedTempRoot, "string");
      assert.equal(fs.existsSync(isolatedTempRoot), false);
      assert.equal(fs.existsSync(sourceConfigPath), true);
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (isolatedTempRoot) {
        fs.rmSync(isolatedTempRoot, { recursive: true, force: true });
      }
      fs.rmSync(sourceHome, { recursive: true, force: true });
    }
  }
});
