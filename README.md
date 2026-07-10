<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="96" alt="tmux-worktree logo" />
</p>

<h1 align="center">tmux-worktree</h1>

<p align="center">
  A macOS Dashboard and CLI for running AI coding agents in isolated git worktrees, managed tmux sessions, SSH remote hosts, and Android relay clients.
</p>

<p align="center">
  <a href="https://github.com/Sskift/tmux-worktree/releases/tag/v1.0.1">
    <img alt="Release" src="https://img.shields.io/github/v/release/Sskift/tmux-worktree?label=release" />
  </a>
  <a href="LICENSE">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-111827" />
  </a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Android-2563eb" />
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-16a34a" />
  <img alt="Stack" src="https://img.shields.io/badge/Tauri%202%20%2B%20tmux-0f172a" />
</p>

<p align="center">
  <a href="#install">Install</a>
  <span> · </span>
  <a href="#quick-start">Quick Start</a>
  <span> · </span>
  <a href="#dashboard">Dashboard</a>
  <span> · </span>
  <a href="#remote-hosts">Remote Hosts</a>
  <span> · </span>
  <a href="#android-relay">Android Relay</a>
  <span> · </span>
  <a href="MANUAL.md">Manual</a>
</p>

---

## Why tmux-worktree

AI agents are most useful when every task has its own branch, terminal, files, logs, and recoverable state. `tmux-worktree` turns that into a repeatable workflow:

| Surface | What it gives you |
| --- | --- |
| `tw` CLI | Creates git worktrees, names branches, starts tmux, records managed session state, and runs an AI command. |
| `tw-dashboard` | Native macOS control plane for worktrees, terminals, files, Git status, diffs, automations, and remote hosts. |
| SSH remote runtime | Lets the local Dashboard create and attach to TW-managed sessions on devboxes over SSH. |
| Android relay | Pairs a phone with the Mac admin connector so mobile can see the same managed sessions. |

```text
Mac Dashboard
  |-- local tw -> git worktree + tmux + AI command
  |-- ssh host -> remote tw -> remote worktree + tmux
  `-- relay host -> broker -> Android client
```

## Highlights

| Capability | Details |
| --- | --- |
| Isolated agent workspaces | Every task can run in its own git worktree and tmux session without disturbing the main checkout. |
| Native terminal control | Dashboard attaches to tmux through a Tauri PTY bridge with resize, history capture, local clipboard paste, and remote tmux copy support. |
| Remote sessions that feel local | Add SSH hosts, create worktrees remotely, attach to remote tmux, and use mouse selection plus `Cmd+C` / `Cmd+V` from the local app. |
| Git and file context | Inspect branch state, changed files, history, diffs, file tree, editor, Markdown preview, and search beside the terminal. |
| Automations | Save repeatable agent instructions, run them on demand, or schedule them with cron-style local Dashboard polling. |
| Mobile visibility | Android connects through the relay broker and sees TW-managed worktrees and terminals from the Mac admin connector. |

## Install

### macOS Dashboard

Download the DMG from the GitHub release:

[Download `tw-dashboard_1.0.1_aarch64.dmg`](https://github.com/Sskift/tmux-worktree/releases/download/v1.0.1/tw-dashboard_1.0.1_aarch64.dmg)

Then install it like a normal macOS app and open it:

```bash
open -a tw-dashboard
```

### CLI

Install `tw` from source on every machine that should create or manage sessions:

```bash
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install
npm run build
npm link
tw setup
```

### Android APK

The Android binary is published as a separate GitHub release asset:

[Download `tw-dashboard-mobile_1.0.3_release-debug-signed.apk`](https://github.com/Sskift/tmux-worktree/releases/download/v1.0.3/tw-dashboard-mobile_1.0.3_release-debug-signed.apk)

The APK is installable and debug-signed. Use it for direct device testing, not app-store distribution.

## Quick Start

Create a config file:

```json
{
  "projects": {
    "myapp": "/Users/me/code/myapp",
    "backend": {
      "path": "/Users/me/code/backend",
      "branch": "develop"
    }
  },
  "worktreeBase": "/Users/me/.tmux-worktree/worktrees",
  "hosts": ["remote-dev"]
}
```

Start a local AI coding session:

```bash
tw claude myapp
tw codex backend fix-auth
tw "claude --model opus" /Users/me/code/myapp
```

New CLI and Dashboard worktree sessions use the same single-pane tmux contract. The AI command runs in that pane and returns to a login shell when it exits. Older multi-pane CLI sessions remain attachable until you close them; `tw` does not rewrite live sessions.

Open the Dashboard:

```bash
open -a tw-dashboard
```

Typical Dashboard flow:

1. Click `+ worktree`.
2. Choose a local project or SSH host.
3. Enter an AI command such as `claude` or `codex`.
4. Attach to the tmux terminal, inspect Git state, edit files, and keep scratch terminals nearby.

## Dashboard

The macOS app is built with Tauri 2, React, xterm.js, and a Rust PTY backend.

| Area | Purpose |
| --- | --- |
| Worktrees | Create, restore, attach, and clean up TW-managed git worktrees. |
| Terminals | Keep standalone tmux terminals next to agent sessions. |
| Git panel | Track active branch, changed files, diffs, and recent commits for the selected session cwd. |
| File tree and editor | Browse files, edit source, preview Markdown and images, and search by filename or content. |
| Automations | Define reusable instructions, run them now, pause them, or schedule them. |
| Layout | Persist window state, sidebar state, column order, editor state, and selected panes. |

Runtime state is stored in user-local JSON files:

| File | Owner | Purpose |
| --- | --- | --- |
| `~/.tmux-worktree.json` | CLI and Dashboard | Projects, SSH hosts, and worktree root. |
| `~/.tmux-worktree/state.json` | CLI and Dashboard | TW-managed sessions and worktrees. |
| `~/.tw-dashboard-layout.json` | Dashboard | Window, columns, file tree, editor, diff, and selection state. |
| `~/.tw-dashboard-terminals.json` | Dashboard | Saved standalone terminals. |
| `~/.tw-dashboard-automations.json` | Dashboard | Automation definitions. |
| `~/.tw-dashboard-automation-runs.json` | Dashboard | Recent automation run history. |

## CLI

Common commands:

```bash
tw setup
tw ls
tw status  # compatibility alias for the same one-shot list
tw serve
tw relay-server
tw relay-host
tw rpc list
tw rpc capabilities
tw automation ls
```

Create managed sessions:

```bash
tw claude myapp
tw claude myapp fix-auth
tw codex ~/code/backend
tw rpc create-worktree --project myapp --ai-command "claude" --name fix-auth
```

`tw status` is non-interactive and exits after printing the current session list. Session switching remains available through `tw attach <session>` and native tmux; the CLI no longer opens an alternate-screen status UI or creates status/extra-shell panes.

Manage automations:

```bash
tw automation create \
  --name nightly-review \
  --project myapp \
  --cmd "codex" \
  --instruction "Review recent changes and propose cleanup tasks" \
  --schedule "0 9 * * 1-5" \
  --timezone Asia/Shanghai

tw automation ls
tw automation rm nightly-review
```

## Remote Hosts

Remote Dashboard support assumes the host is reachable by SSH and has `git`, `tmux`, Node.js 20+, npm, and `tw`.

1. Add a normal SSH alias:

```sshconfig
Host remote-dev
  HostName remote-dev.example.com
  User alice
```

2. Install `tw` on the remote host:

```bash
ssh remote-dev -- 'mkdir -p ~/.local/src'
ssh remote-dev -- 'git clone https://github.com/Sskift/tmux-worktree.git ~/.local/src/tmux-worktree'
ssh remote-dev -- 'cd ~/.local/src/tmux-worktree && npm install && npm run build && npm link --prefix ~/.local'
ssh remote-dev -- 'PATH="$HOME/.local/bin:$PATH" tw version'
```

3. Configure remote projects on that host:

```bash
ssh remote-dev -- 'cat > ~/.tmux-worktree.json <<JSON
{
  "projects": {
    "demo": "/home/alice/code/demo"
  },
  "worktreeBase": "/home/alice/.tmux-worktree/worktrees"
}
JSON'
```

4. Add the host in the Dashboard with `+ host`, then create remote worktrees from `+ worktree`.

Remote sessions are created through `tw rpc create-worktree` when available. Older remote installs can still fall back to direct SSH + git/tmux behavior, but the best experience comes from keeping local and remote `tw` versions aligned.

## Android Relay

The mobile path has three pieces:

| Piece | Runs on | Role |
| --- | --- | --- |
| `tw relay-server` | Always-reachable broker host | WebSocket broker only. |
| `tw relay-host` | Mac admin machine | Aggregates local and configured remote TW-managed sessions. |
| Android APK | Phone | Lists and attaches to sessions exposed through the broker. |

The Dashboard can start or inspect the Mac admin connector. It saves relay settings such as `mobileRelay.relayUrl`, `mobileRelay.hostId`, and `mobileRelay.secret` into `~/.tmux-worktree.json`.

For a persistent broker setup, see [docs/remote-relay-android.md](docs/remote-relay-android.md).

## Configuration Reference

`~/.tmux-worktree.json` accepts compact strings, objects, and common aliases:

```json
{
  "projects": {
    "myapp": "/path/to/myapp",
    "api": {
      "path": "~/code/api",
      "branch": "main"
    }
  },
  "hosts": [
    "remote-dev",
    {
      "name": "gpu-box",
      "host": "gpu-box"
    }
  ],
  "worktreeBase": "/private/tmp/tmux-worktree/projects"
}
```

Supported aliases:

| Setting | Accepted keys |
| --- | --- |
| Project map | `projects`, `repositories`, `repos` |
| Project path | `path`, `dir`, `directory`, `root`, `repoPath`, `repository`, `repositoryPath` |
| Branch | `branch`, `targetBranch`, `target_branch`, `defaultBranch`, `default_branch` |
| Worktree root | `worktreeBase`, `worktreeDir`, `worktreeRoot`, `worktreesDir`, `worktreesRoot` |

Dashboard connected hosts come only from explicit `hosts` config. The `+ host` dialog can discover non-wildcard aliases from `~/.ssh/config`, but it does not auto-connect every SSH alias on the machine.

## Development

Requirements:

- Node.js 20+
- Rust stable
- Xcode Command Line Tools
- tmux
- git

Build the CLI:

```bash
npm install
npm run build
node dist/cli.js status
```

Run the Dashboard:

```bash
cd app
npm install
npm run tauri dev
```

Useful checks:

```bash
npm run build
node --test test/*.test.mjs

cd app
npm run build
npm run test:typecheck
npm test

cd src-tauri
cargo fmt --check
cargo check
cargo test
```

Use the isolated dev app only when state isolation is required:

```bash
cd app
npm run tauri:dev:isolated
```

## Release

Build the CLI plus bundled Dashboard installer assets:

```bash
./app/scripts/release.sh --dry-run
./app/scripts/release.sh
```

The release script:

1. Builds the Tauri Dashboard DMG.
2. Builds the root CLI into `dist/cli.js`.
3. Bundles `dist/cli.js` into the Dashboard app resources for remote serve fallback.
4. Copies the DMG to `app/installer/dmg/tw-dashboard-arm64.dmg`.
5. Leaves upload and channel-specific publishing outside the repository.

Generated asset inputs:

| Path | Purpose |
| --- | --- |
| `dist` | Built CLI. |
| `app/installer/installer.mjs` | `tw-dashboard-install` entrypoint. |
| `app/installer/dmg/` | Bundled macOS installer image. |

## Documentation

- [Manual](MANUAL.md): setup, local sessions, SSH remote hosts, mobile relay, and troubleshooting.
- [Architecture](ARCHITECTURE.md): code map, runtime state, release boundaries, and maintenance rules.
- [Android relay guide](docs/remote-relay-android.md): persistent broker and phone pairing details.

## License

MIT
