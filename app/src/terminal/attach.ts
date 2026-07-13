import type { HostConfig } from "../platform";

export function shellQuoteArg(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function remoteShellPathExpr(value: string): string {
  const trimmed = value.trim() || "tmux";
  if (trimmed === "~") return '"$HOME"';
  if (trimmed.startsWith("~/")) {
    const escapedPath = trimmed
      .slice(2)
      .replace(/["\\$]/g, "\\$&")
      .replace(/`/g, "\\`");
    return `"$HOME/${escapedPath}"`;
  }
  return shellQuoteArg(trimmed);
}

export function sharedSshConnectionArgs(): string[] {
  return [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=600",
    "-o", "ControlPath=~/.tmux-worktree/ssh/%C",
  ];
}

/** Build SSH attach args for a remote session. */
export function buildSshAttachArgs(host: HostConfig, rawName: string, readOnly = false): string[] {
  const args: string[] = ["-tt", ...sharedSshConnectionArgs()];
  if (host.port) {
    args.push("-p", String(host.port));
  }
  if (host.identityFile) {
    args.push("-i", host.identityFile);
  }
  if (host.user) {
    args.push("-l", host.user);
  }
  const exact = `=${rawName}`;
  const exactArg = shellQuoteArg(exact);
  const tmux = remoteShellPathExpr(host.tmuxPath || "tmux");
  args.push(
    "--",
    host.host,
    [
      "set -e",
      "export TERM=xterm-256color",
      `${tmux} has-session -t ${exactArg}`,
      `${tmux} set-option -g mouse on >/dev/null 2>&1 || true`,
      `${tmux} bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true`,
      `${tmux} bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true`,
      `exec ${tmux} attach-session${readOnly ? " -r -f ignore-size" : ""} -t ${exactArg}`,
    ].join("; "),
  );
  return args;
}

export function buildSshShellArgs(host: HostConfig, cwd: string): string[] {
  const args: string[] = ["-tt", ...sharedSshConnectionArgs()];
  if (host.port) {
    args.push("-p", String(host.port));
  }
  if (host.identityFile) {
    args.push("-i", host.identityFile);
  }
  if (host.user) {
    args.push("-l", host.user);
  }
  args.push(
    "--",
    host.host,
    `cd ${shellQuoteArg(cwd)} && exec "\${SHELL:-/bin/sh}"`,
  );
  return args;
}
