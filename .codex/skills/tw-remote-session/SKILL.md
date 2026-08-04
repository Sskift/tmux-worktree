---
name: tw-remote-session
description: Create Dashboard-managed tmux-worktree sessions on remote, usually headless, SSH hosts. Use when configuring or instructing an agent to create a TW worktree/session that the local macOS Dashboard can discover and attach to correctly, especially when the remote host has no GUI.
---

# TW Remote Session

## Overview

Create TW-managed worktree sessions on a remote host without launching Dashboard there. `tw rpc create-worktree` records a `dashboard` profile session in remote `~/.tmux-worktree/state.json`, so the local Dashboard can discover it through SSH and `tw rpc list`. CLI and Dashboard profiles now share the same single-pane tmux layout; the profile records provenance only.

## Rules

- Do not launch Dashboard on the remote host.
- Do not create plain tmux sessions with `tmux new-session`.
- Do not manually run `git worktree add` for Dashboard-visible sessions.
- Prefer `tw rpc create-worktree` for headless or automated creation because it returns a machine-readable result and does not immediately attach a local terminal client.
- Bare `tw <ai-command> <project|path>` uses the same managed single-pane session contract, but is intended for an interactive shell and records `profile: "cli"`.
- Use paths that exist on the remote host, not local macOS paths.
- Put the command that should start Claude, Codex, or another agent in `--ai-command`.

## Preflight

If already running on the remote host:

```bash
command -v tw
tw version
tw rpc capabilities
tmux -V
git -C /remote/path/to/repo rev-parse --show-toplevel
```

If controlling the remote host from a local machine, prefix the same checks with `ssh <host> --`.

If the Host is already registered in `~/.tmux-worktree.json`, prefer the structured local control plane:

```bash
tw host probe <host-id> --json
tw host rpc <host-id> capabilities
```

If `tw` is missing or `tw rpc capabilities` does not include `create-worktree`, install or update the remote binary, then recheck:

```bash
mkdir -p ~/.local/src
git clone https://github.com/Sskift/tmux-worktree.git ~/.local/src/tmux-worktree
cd ~/.local/src/tmux-worktree
npm install
npm run build
npm link --prefix ~/.local
PATH="$HOME/.local/bin:$PATH" tw version
```

## Create

Run this on the remote host:

```bash
tw rpc create-worktree \
  --path /remote/path/to/repo \
  --project project-key \
  --name short-task-name \
  --branch main \
  --ai-command 'claude "task instruction"'
```

Or from a local coordinator, use a quoted heredoc so `--ai-command` survives SSH shell parsing:

```bash
ssh <host> 'bash -s' <<'REMOTE_TW'
tw rpc create-worktree \
  --path /remote/path/to/repo \
  --project project-key \
  --name short-task-name \
  --branch main \
  --ai-command 'codex "task instruction"'
REMOTE_TW
```

For a configured Host, the equivalent Agent-friendly command avoids manual SSH quoting:

```bash
tw host rpc <host-id> create-worktree \
  --path /remote/path/to/repo \
  --project project-key \
  --name short-task-name \
  --branch main \
  --ai-command 'codex "task instruction"'
```

Argument guidance:

- `--path`: remote repository path.
- `--project`: stable project key shown in Dashboard.
- `--name`: short task/session suffix. Keep it shell-safe and under about 20 characters after project prefix.
- `--branch`: base branch to create the worktree from. Omit only when remote TW should infer the default branch.
- `--ai-command`: exact command to start the remote agent inside the Dashboard-owned tmux pane.
- If `--worktree-base` is omitted, the target host uses `~/.tmux-worktree/worktrees`; a leading `~` is expanded on that host.

## Verify

After creation:

```bash
tw rpc list
tmux has-session -t <session-from-create-output>
```

Confirm that `tw rpc list` includes the created session with `kind: "worktree"` and `profile: "dashboard"`.

## Report Back

Return a concise result:

- Host name.
- TW version.
- Created session name.
- Worktree path.
- Branch name.
- AI command used.
- Any warning that may prevent the local Dashboard from discovering the session.

If creation fails, include the failing command, stderr, and whether `tw rpc capabilities`, `tmux -V`, and `git rev-parse` passed.
