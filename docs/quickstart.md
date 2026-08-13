# Quick start

This guide gets TW from a fresh checkout to one isolated agent task. For a zero-risk product preview with fictional data, use [the demo guide](demo.md) instead.

## What you need

For the macOS Dashboard and local sessions:

- macOS
- Git
- tmux
- Node.js 20 or newer
- at least one CLI coding agent, such as `codex` or `claude`

```bash
brew install git tmux node
git --version
tmux -V
node --version
```

For an SSH target, install the same runtime dependencies and `tw` on that host.

## Install the Dashboard

Download the latest DMG from [GitHub Releases](https://github.com/Sskift/tmux-worktree/releases/latest), move `tw-dashboard` into Applications, and open it:

```bash
open -a tw-dashboard
```

The app bundles the matching Dashboard-side CLI code but still expects a local Node.js runtime. If a repository is stored under Desktop, Documents, or Downloads, macOS may ask for folder access when TW first reads its Git metadata.

## Install `tw` from source

```bash
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install
npm run build
npm link
tw setup
tw doctor
```

`tw doctor` should report Git, tmux, Node.js, and configuration status. Run it again after changing a machine's runtime.

## Start directly from a repository path

The shortest path does not require a config file:

```bash
tw codex /Users/me/code/myapp improve-search
```

TW creates a branch and worktree beneath `~/.tmux-worktree/worktrees`, starts one managed tmux session, and runs `codex` in that worktree. Replace `codex` with the installed agent command you prefer.

Use a different base branch when needed:

```bash
tw claude /Users/me/code/myapp fix-auth --branch develop
```

List and reattach later:

```bash
tw ls
tw attach <session-name>
```

## Add named projects

Create `~/.tmux-worktree.json`:

```json
{
  "projects": {
    "myapp": "/Users/me/code/myapp",
    "backend": {
      "path": "/Users/me/code/backend",
      "branch": "develop"
    }
  },
  "worktreeBase": "/Users/me/.tmux-worktree/worktrees"
}
```

Now the project name is enough:

```bash
tw codex myapp improve-search
tw claude backend fix-auth
```

The Dashboard reads the same project catalog. Click **New worktree**, select the project, base branch, and detected agent, then create the task.

## Add an SSH host

The remote machine needs Git, tmux, Node.js 20+, and a compatible `tw` installation. Start with a normal SSH configuration and confirm that non-interactive login works.

```bash
tw host add \
  --id build-mac \
  --host builder.example.com \
  --user alice \
  --json

tw host probe build-mac --json
```

Or open **Settings → Connections → Hosts → Add host**. A successful probe separates SSH reachability, tmux availability, and TW lifecycle compatibility so a missing remote dependency is not mistaken for a network outage.

Remote project paths are resolved on the remote host. Install `tw` there and give it a `~/.tmux-worktree.json` containing that host's repository paths.

## Create an Automation

Open **Automations → Manage**, or use the CLI:

```bash
tw automation create \
  --name weekday-review \
  --project myapp \
  --cmd codex \
  --instruction "Review the current branch and summarize the highest-risk changes" \
  --schedule "0 9 * * 1-5" \
  --timezone Asia/Shanghai
```

The current scheduler runs inside the Dashboard process. Keep the Dashboard running for scheduled triggers. Manual runs are always available from the Automation panel.

## Pair Android through Relay v2

TW Mobile is currently a device-test build from this repository, not a signed production release.

1. Build the APK:

   ```bash
   npm run verify:android
   ```

2. Install `mobile/android/app/build/outputs/apk/debug/app-debug.apk` on the test device.
3. In the Dashboard, open **Settings → Connections → Relay**.
4. Configure the explicit self-hosted Relay profile shown by the app, start the Host connector, and create a one-time pairing link or QR.
5. Enroll the phone and confirm that the device appears under **Connected mobile devices**.

Use HTTPS/WSS with trusted certificates for any network beyond a local development environment. The current self-hosted profile is intended for machines you control, not unrelated tenants.

## Connect Feishu

The Feishu bridge uses `lark-cli` profiles for bot credentials and authorization. Secrets stay in `lark-cli`; TW stores only the selected non-sensitive profile name and binding state.

1. Configure and validate a `lark-cli` bot profile.
2. Open **Settings → Integrations** in the Dashboard.
3. Select the profile and start the bridge.
4. Bind one authorized group conversation to one exact local managed session.
5. Mention the bot in that group to steer the session; use the Dashboard's controlled takeover flow before returning local input ownership.

Feishu binding currently targets local managed sessions. Do not describe a remote session name as equivalent to an exact local terminal-control target.

## The first five commands to remember

```bash
tw doctor
tw codex <project-or-path> <task-name>
tw ls
tw agents ls --json
tw worktree prune --dry-run
```

Before deleting a task and its worktree, inspect uncommitted changes. `tw rm <session> --worktree` refuses dirty worktrees unless force is explicitly requested.

Next: take the [product tour](product-tour.md), understand the [security model](security.md), or open [troubleshooting](troubleshooting.md).
