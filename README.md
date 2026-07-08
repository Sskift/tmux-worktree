# tmux-worktree

`tmux-worktree` is a macOS desktop app and CLI for managing AI coding sessions with `tmux` and `git worktree`.

It provides:

- `tw`: a Node.js CLI that creates isolated git worktrees, starts tmux sessions, and runs an AI command.
- `tw-dashboard`: a Tauri desktop app for managing worktrees, tmux sessions, terminals, automations, files, Git status, and SSH remote hosts.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the code map and runtime design. See [MANUAL.md](MANUAL.md) for setup and remote-host usage.

## Install

### Dashboard

Install from the npm package:

```bash
npx -y -p tmux-worktree tw-dashboard-install
open -a tw-dashboard
```

If you already have `tmux-worktree` installed globally, update it first so the installer uses the latest bundled DMG:

```bash
npm i -g tmux-worktree@latest
tw-dashboard-install
open -a tw-dashboard
```

You can also install from a locally built DMG.

### CLI

```bash
npm i -g tmux-worktree
tw setup
```

Update the CLI and Dashboard:

```bash
tw update
```

## Configuration

The CLI and Dashboard share `~/.tmux-worktree.json`:

```json
{
  "projects": {
    "myapp": "/path/to/myapp",
    "backend": "/path/to/backend"
  },
  "hosts": ["remote-dev"],
  "worktreeBase": "/private/tmp/tmux-worktree/projects"
}
```

- `projects`: maps project names to git repository paths.
- `hosts`: SSH hosts visible in the Dashboard. Values can be SSH config aliases or full host objects.
- `worktreeBase`: parent directory for automatically created worktrees.

Project entries also support object and array forms:

```json
{
  "projects": {
    "myapp": { "path": "~/code/myapp", "branch": "develop" }
  },
  "worktreeRoot": "/private/tmp/tmux-worktree/projects"
}
```

Supported project path aliases include `path`, `dir`, `directory`, `root`, `repoPath`, `repository`, and `repositoryPath`.

Supported branch aliases include `branch`, `targetBranch`, `target_branch`, `defaultBranch`, and `default_branch`.

Supported worktree root aliases include `worktreeBase`, `worktreeDir`, `worktreeRoot`, `worktreesDir`, and `worktreesRoot`.

Runtime state files:

- `~/.tmux-worktree/state.json`: sessions and worktrees created by `tw`.
- `~/.tw-dashboard-layout.json`: Dashboard layout and selected item state.
- `~/.tw-dashboard-terminals.json`: saved standalone terminals.
- `~/.tw-dashboard-automations.json`: automation definitions.
- `~/.tw-dashboard-automation-runs.json`: recent automation run history.
- `~/.tw-dashboard-pending-worktree-cleanup.json`: delayed worktree cleanup records.

## CLI Usage

Create an AI coding session:

```bash
tw claude myapp
tw claude myapp fix-auth
tw "claude --model opus" backend
tw codex ~/some/repo
tw
```

Common commands:

- `tw setup`: check local dependencies.
- `tw status`: tmux status panel.
- `tw serve`: local WebSocket terminal service.
- `tw relay-server` / `tw relay-host`: stable Android relay broker and Mac admin connector.
- `tw update`: update the global CLI package and reinstall the latest Dashboard.
- `tw rpc list`: print live `tw`-managed sessions as JSON.
- `tw rpc create-worktree (--path <path> | --project <name>) --ai-command <cmd> [--name <name>] [--branch <name>]`: create a Dashboard-managed worktree session.
- `tw rpc capabilities`: print supported RPC protocol and capabilities.
- `tw automation ls`: list Dashboard automations.
- `tw automation create --instruction <text> [--name <name>] [--cmd <ai-cmd>] [--project <name> | --path <path>] [--schedule <cron>] [--timezone <tz>] [--overlap skip|queue] [--disabled]`: create an automation.
- `tw automation rm <id|name>`: delete an automation.

## Dashboard Usage

Typical flow:

1. Click `+ worktree` to create or restore a worktree session.
2. Select a session in the sidebar; the main terminal attaches to the matching tmux session.
3. Use the Git panel to inspect branch, file changes, and commit history.
4. Open the file tree to browse, edit, and diff project files.
5. Create local automations from the Automations section.
6. Use the mobile relay button to start or inspect the Mac admin connector for Android pairing.

Remote host behavior:

- Connected hosts come only from the explicit `hosts` config.
- The `+ host` dialog shows non-wildcard aliases from `~/.ssh/config`.
- The Dashboard checks SSH/tmux reachability and whether the remote `tw` CLI is available.
- Remote worktree creation prefers `tw rpc create-worktree` on the remote host.
- If compatible RPC is unavailable, the Dashboard falls back to direct SSH + git/tmux commands.
- Remote scratch terminals start on the selected host and current remote cwd without sourcing login profiles.

Mobile Relay runtime:

- The Dashboard bundle includes the CLI JS needed to start `tw serve` and prefers that bundled resource.
- If the bundled resource is unavailable, it falls back to a globally installed `tw` / `tmux-worktree` command.
- `relay-server` runs on an always-reachable machine as a broker only.
- `relay-host` runs on the Mac admin machine, reads the same local Dashboard config, and aggregates local plus configured remote scopes over SSH.
- Android pairs with the Mac admin connector through the broker and sees the same TW-managed WorkTrees/Terminals as the Mac Dashboard.
- Plain tmux sessions are not part of the managed mobile surface.
- Mobile Relay still needs Node.js 20+ for `tw serve` and `tw relay-host`.
- The relay broker can run persistently on a devbox with systemd or a dedicated tmux session; see `docs/remote-relay-android.md`.
- The Dashboard remote menu can start the broker on a configured SSH host and saves `mobileRelay.relayUrl`, `mobileRelay.hostId`, and `mobileRelay.secret` into `~/.tmux-worktree.json`.

Layout behavior:

- The default layout is sidebar, main terminal, and scratch.
- Sidebar stays on the left. Main, scratch, file tree, and editor/diff columns can be reordered.
- Automations stay between worktrees and terminals in the sidebar.
- The Dashboard restores window, column, sidebar, file tree, editor, and diff state after restart.
- The Git panel follows the active pane cwd for the selected tmux session.

## Development

Requirements:

- Node.js 20+
- Rust stable
- Xcode Command Line Tools
- tmux
- git

CLI:

```bash
npm install
npm run build
node dist/cli.js status --once
```

Dashboard:

```bash
cd app
npm install
npm run tauri dev
```

Local validation should usually use `npm run tauri dev`. It reflects the current workspace directly and avoids generating hashed debug apps under `/Applications`.

Use the isolated dev app only when state isolation is required:

```bash
cd app
npm run tauri:dev:isolated
```

`npm run tauri:dev:install` installs a uniquely named debug `.app` under `/Applications`; use it only when Finder/open launch behavior must be tested, and clean it up afterward with the command printed by the script.

Useful checks:

```bash
npm run build
node --test test/*.test.mjs

cd app
npm run build
node --test tests/*.test.ts

cd src-tauri
cargo fmt --check
cargo check
cargo test
```

## Release

Build and publish the CLI plus bundled Dashboard installer:

```bash
./app/scripts/release.sh --dry-run
./app/scripts/release.sh
```

The release script:

1. Builds the Tauri Dashboard DMG.
2. Builds the root CLI into `dist/cli.js`.
3. Bundles `dist/cli.js` into the Dashboard app resources for remote serve fallback.
4. Copies the DMG to `app/installer/dmg/tw-dashboard-arm64.dmg`.
5. Publishes the root npm package.

The npm package includes:

- `dist`
- `app/installer/installer.mjs`
- `app/installer/dmg/`

## License

MIT
