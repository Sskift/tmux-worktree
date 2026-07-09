# tmux-worktree Manual

This manual covers local macOS Dashboard setup and SSH remote host usage.

## Install On macOS

Download the Dashboard DMG from GitHub Releases:

- https://github.com/Sskift/tmux-worktree/releases/latest

Install it like a normal macOS app, then open it:

```bash
open -a tw-dashboard
```

Install the CLI from source on any machine that should create `tw`-managed sessions:

```bash
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install
npm run build
npm link
tw setup
```

## Local Projects

The local CLI and Dashboard both read `~/.tmux-worktree.json`:

```json
{
  "projects": {
    "demo": "/Users/me/workspace/demo"
  },
  "worktreeBase": "/Users/me/.tmux-worktree/worktrees"
}
```

Create a local worktree from the CLI:

```bash
tw claude demo
tw codex /Users/me/workspace/demo fix-auth
```

Create one from the Dashboard with `+ worktree`: choose `Local`, choose a configured project or browse a path, then enter an AI command such as `claude` or `codex`.

## SSH Remote Hosts

Remote Dashboard support assumes the host is reachable by SSH and has `tmux`, `git`, Node.js 20+, npm, and `tw`.

1. Add an SSH alias in `~/.ssh/config`.

```sshconfig
Host remote-dev
  HostName remote-dev.example.com
  User alice
```

2. In the Dashboard, click `+ host`, choose the SSH alias from the list, test it, then add it. The Dashboard saves selected SSH config candidates into `~/.tmux-worktree.json`.

3. Install or update `tw` on the remote host. A user-local install is enough:

```bash
ssh remote-dev -- 'mkdir -p ~/.local/src'
ssh remote-dev -- 'git clone https://github.com/Sskift/tmux-worktree.git ~/.local/src/tmux-worktree'
ssh remote-dev -- 'cd ~/.local/src/tmux-worktree && npm install && npm run build && npm link --prefix ~/.local'
ssh remote-dev -- 'PATH="$HOME/.local/bin:$PATH" tw version'
```

Dashboard SSH commands prepend common user bin paths such as `~/.local/bin`, so a user-local remote install works when `/usr/local/bin` is not writable.

4. Configure remote projects on the remote host:

```bash
ssh remote-dev -- 'cat > ~/.tmux-worktree.json <<JSON
{
  "projects": {
    "demo": "/home/alice/workspace/demo"
  },
  "worktreeBase": "/home/alice/.tmux-worktree/worktrees"
}
JSON'
```

5. Verify remote RPC:

```bash
ssh remote-dev -- 'PATH="$HOME/.local/bin:$PATH" tw rpc capabilities'
ssh remote-dev -- 'PATH="$HOME/.local/bin:$PATH" tw rpc list'
```

## Remote AI Commands

The AI command runs on the remote host inside the `tw`-owned tmux session. Install the command on the remote host and verify `--version`.

Claude Code example:

```bash
ssh remote-dev -- 'npm i -g --prefix ~/.local @anthropic-ai/claude-code@latest'
ssh remote-dev -- 'PATH="$HOME/.local/bin:$PATH" claude --version'
```

If you already have Claude config on the Mac and want the same account/settings on the remote, sync only the config files you need:

```bash
scp ~/.claude.json remote-dev:~/.claude.json
scp ~/.claude/.claude.json remote-dev:~/.claude/.claude.json
scp ~/.claude/settings.json remote-dev:~/.claude/settings.json
ssh remote-dev -- 'chmod 600 ~/.claude.json ~/.claude/.claude.json; chmod 644 ~/.claude/settings.json'
```

Codex CLI example:

```bash
ssh remote-dev -- 'npm i -g --prefix ~/.local @openai/codex@latest'
ssh remote-dev -- 'PATH="$HOME/.local/bin:$PATH" codex --version'
```

For Dashboard-created sessions, entering `claude`, `codex`, or another command in the AI command field is enough after the remote binary is installed.

## Create Remote Worktrees From Dashboard

1. Click `+ worktree`.
2. Choose the remote host.
3. Choose a configured remote project, use `browse`, or type a remote repository path.
4. Enter the AI command, for example `claude` or `codex`.
5. Create the worktree.

The Dashboard asks the remote `tw` to run `tw rpc create-worktree`. The remote `tw` creates the git worktree under remote `worktreeBase`, starts a tmux session, and records it in remote `~/.tmux-worktree/state.json`. The Dashboard only shows sessions recorded by `tw`.

## Create Remote Terminals From Dashboard

Use `+ terminal`, choose the remote host, choose or type the remote path, and enter the AI command. The session is `tw`-managed and visible under Terminals.

## Remote Agent Skill

The repo includes `.codex/skills/tw-remote-session` for headless remote agents. Install it on the remote agent machine:

```bash
mkdir -p ~/.codex/skills
cp -R .codex/skills/tw-remote-session ~/.codex/skills/
```

Then prompt the remote agent:

```text
Use $tw-remote-session to create a Dashboard-managed worktree on host remote-dev for /home/alice/workspace/demo. Use AI command "claude".
```

The skill tells the agent to use `tw rpc create-worktree`, not plain `tmux new-session`, not manual `git worktree add`, and not bare `tw <ai-command> <project>` unless the user explicitly wants the CLI multi-pane profile.

## Troubleshooting

- `bash: claude: command not found`: install Claude on the remote host and verify `PATH="$HOME/.local/bin:$PATH" claude --version`.
- `bash: codex: command not found`: install Codex on the remote host and verify `PATH="$HOME/.local/bin:$PATH" codex --version`.
- Host is reachable but the Dashboard says `tw` is missing: install remote `tw` from the GitHub source checkout, then re-test the host.
- Remote path picker is empty for `/home/<user>`: the host may use a symlinked home. Current Dashboard follows symlinked directories; update the app and remote `tw`.
- Dashboard cannot see a remote tmux session: confirm it was created by `tw` and appears in `tw rpc list`.
- Existing failed panes do not inherit newly installed commands. Recreate the session, or run `export PATH="$HOME/.local/bin:$PATH"` inside that pane before starting the command.
