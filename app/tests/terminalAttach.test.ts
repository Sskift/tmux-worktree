import assert from "node:assert/strict";
import test from "node:test";
import type { HostConfig } from "../src/platform/domainTypes.ts";
import {
  buildSshAttachArgs,
  buildSshShellArgs,
  remoteShellPathExpr,
  sharedSshConnectionArgs,
  shellQuoteArg,
} from "../src/terminal/attach.ts";

const sharedArgs = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-o", "ControlMaster=auto",
  "-o", "ControlPersist=600",
  "-o", "ControlPath=~/.tmux-worktree/ssh/%C",
];

const host: HostConfig = {
  id: "builder",
  label: "Builder",
  host: "build.internal",
  user: "alice",
  port: 2222,
  identityFile: "/Users/alice/.ssh/id build",
  tmuxPath: "~/.local/bin/tmux",
};

test("shell quoting and remote path expansion preserve exact shell semantics", () => {
  assert.equal(shellQuoteArg(""), "''");
  assert.equal(shellQuoteArg("simple value"), "'simple value'");
  assert.equal(shellQuoteArg("repo's"), "'repo'\\''s'");
  assert.equal(remoteShellPathExpr("   "), "'tmux'");
  assert.equal(remoteShellPathExpr("~"), '"$HOME"');
  assert.equal(remoteShellPathExpr("~/.local/bin/tmux"), '"$HOME/.local/bin/tmux"');
  assert.equal(remoteShellPathExpr('~/double"quote'), String.raw`"$HOME/double\"quote"`);
  assert.equal(remoteShellPathExpr(String.raw`~/back\slash`), String.raw`"$HOME/back\\slash"`);
  assert.equal(remoteShellPathExpr("~/cash$path"), String.raw`"$HOME/cash\$path"`);
  assert.equal(remoteShellPathExpr("~/tick`path"), '"$HOME/tick\\`path"');
  assert.equal(remoteShellPathExpr("/opt/tmux path"), "'/opt/tmux path'");
});

test("SSH attach argv preserves options, separator, target, and remote command order", () => {
  assert.deepEqual(sharedSshConnectionArgs(), sharedArgs);
  assert.deepEqual(buildSshAttachArgs(host, "repo's"), [
    "-tt",
    ...sharedArgs,
    "-p", "2222",
    "-i", "/Users/alice/.ssh/id build",
    "-l", "alice",
    "--",
    "build.internal",
    [
      "set -e",
      "export TERM=xterm-256color",
      '"$HOME/.local/bin/tmux" has-session -t \'=repo\'\\\'\'s\'',
      '"$HOME/.local/bin/tmux" set-option -g mouse on >/dev/null 2>&1 || true',
      '"$HOME/.local/bin/tmux" bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true',
      '"$HOME/.local/bin/tmux" bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true',
      'exec "$HOME/.local/bin/tmux" attach-session -t \'=repo\'\\\'\'s\'',
    ].join("; "),
  ]);
  assert.match(
    buildSshAttachArgs(host, "repo's", true).at(-1) ?? "",
    /attach-session -r -f ignore-size -t/,
  );
});

test("SSH shell argv uses the same connection facade and an exact login-shell command", () => {
  assert.deepEqual(buildSshShellArgs(host, "/work/repo's"), [
    "-tt",
    ...sharedArgs,
    "-p", "2222",
    "-i", "/Users/alice/.ssh/id build",
    "-l", "alice",
    "--",
    "build.internal",
    "cd '/work/repo'\\''s' && exec \"${SHELL:-/bin/sh}\"",
  ]);

  assert.deepEqual(
    buildSshShellArgs({ id: "plain", label: "Plain", host: "plain.internal" }, "/"),
    ["-tt", ...sharedArgs, "--", "plain.internal", "cd '/' && exec \"${SHELL:-/bin/sh}\""],
  );
});
