# tmux-worktree Manual

This manual covers macOS Dashboard and CLI setup, local sessions, SSH remote hosts, remote AI commands, and troubleshooting. Android pairing and broker operation are documented separately in [the Android relay guide](docs/remote-relay-android.md).

## Install On macOS

Download the Dashboard DMG from GitHub Releases:

- https://github.com/Sskift/tmux-worktree/releases/latest

Install it like a normal macOS app, then open it:

```bash
open -a tw-dashboard
```

The Dashboard bundle includes its matching CLI JavaScript and currently uses a locally installed Node.js 20+ to execute it. If Node is unavailable, the Dashboard will use a globally installed `tw` only when its version and full lifecycle RPC capability set match; it never silently falls back to a second creator.

If a repository or its linked main checkout is under Desktop, Documents, or Downloads, allow the macOS folder-access prompt on first use. Git worktrees keep their actual Git metadata in the main checkout, so denying that folder prevents Git status and diffs from loading.

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

Create a local worktree from the CLI using either a configured project name or a git repository path:

```bash
tw claude demo
tw codex /Users/me/workspace/demo fix-auth
```

Both forms always create a managed git worktree and write `~/.tmux-worktree/state.json`; a path that is not a git repository is rejected instead of becoming an untracked plain tmux session. New worktree sessions use the same single tmux pane as Dashboard-created sessions. The managed-state `profile` still records whether the request came from the CLI or Dashboard for compatibility, but it does not change the pane layout. Existing live sessions created by older releases keep their original panes and remain attachable.

Create one from the Dashboard with `New worktree`: choose `Local`, choose a configured project or browse a path, then choose one of the supported agents that the Dashboard detected as available on this Mac. The field is a fixed picker; Dashboard worktree creation does not accept an arbitrary command there.

Drag a Worktrees group header to reorder Host/Project groups. Drag an individual worktree within its own group to reorder that group; a row cannot be moved into a different Host/Project identity. Focused drag handles also accept Up/Down, and the order survives relaunch.

When a selected local project preset points to a path that no longer exists, the Dashboard removes only that exact name/path entry from `~/.tmux-worktree.json`; unrelated fields and a concurrently replaced entry are preserved.

## SSH Remote Hosts

Remote Dashboard support assumes the host is reachable by SSH and has `tmux`, `git`, Node.js 20+, npm, and `tw`.

1. Add an SSH alias in `~/.ssh/config`.

```sshconfig
Host remote-dev
  HostName remote-dev.example.com
  User alice
```

2. In the Dashboard, open `Settings → Connections → Add host`, choose the SSH alias from the list, test it, then add it. The Dashboard saves selected SSH config candidates into `~/.tmux-worktree.json`.

The same Host catalog is controllable by an agent or shell without opening the app:

```bash
tw host add --id remote-dev --host remote-dev.example.com --user alice --json
tw host probe remote-dev --json
tw host connect remote-dev --json
tw host connection-status remote-dev --json
```

Host mutations preserve the other keys in `~/.tmux-worktree.json`. Remote `worktreeBase`, `tmuxPath`, and `twPath` retain their leading `~` and are expanded on the remote host, not on the Mac.

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

`tw host attach <id> <session>` first proves that the selected remote `tw` has a working terminal-control authority, then invokes its controlled attach. Old or unavailable controllers fail closed without a direct-tmux fallback. Add `--take-over` for a graceful Feishu-to-local handoff. `--privileged-bypass` is the explicit, warned break-glass path and is never selected automatically.

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

For Dashboard-created worktrees, the agent picker probes the selected Host and lists only supported commands that are actually available there. Install the remote binary first, then select it from that picker.

## Create Remote Worktrees From Dashboard

1. Click `New worktree`.
2. Choose the remote host.
3. Choose a configured remote project, use `browse`, or type a remote repository path.
4. Choose an agent detected as available on that Host.
5. Create the worktree.

For a selected SSH host, the project picker reads `projects`/`repositories`/`repos` from that host's own `~/.tmux-worktree.json`, expanding `~` against the remote physical home. The picker reports loading and an explicit empty-config state instead of hiding the project row.

The Dashboard asks the remote `tw` to run `tw rpc create-worktree`. The remote `tw` creates the git worktree under remote `worktreeBase`, starts a tmux session, and records it in remote `~/.tmux-worktree/state.json`. Agents can invoke the same operation from the Mac with `tw host rpc remote-dev create-worktree ...`.

Closing a worktree from the sidebar stops its managed tmux session but intentionally keeps the worktree and branch. To restore or delete that directory, open `New worktree`, select the same remote Host, and use the `restore existing` row. Remote deletion is restricted to real Git worktrees directly under that Host's configured `worktreeBase`; the confirmation discards uncommitted files and, on Linux hosts with `/proc`, stops leftover processes whose current working directory is inside the selected worktree. The Git branch is preserved.

Remote managed terminals use a read-only SSH tmux attachment and send keyboard input through the remote terminal-control authority. Mouse/focus protocol reports are not pasted into the pane, and wheel actions use the authority's fenced scroll operation instead of raw mouse reports. The scroll backend uses tmux copy-mode for normal panes; when an alternate-screen application has explicitly enabled SGR mouse input, it synthesizes only bounded wheel events inside that same fenced operation so full-screen transcripts such as Claude Code remain scrollable. If an input result becomes uncertain, the terminal shows `Recover local input`; recovery requires confirmation because the previous input may already have taken effect, advances the ownership fence on the selected Host, and never replays that input.

## Create Remote Terminals From Dashboard

Use `+ terminal`, choose the remote host, and choose or type the remote path. Dashboard does not ask for an AI command here: it opens every new terminal in a login shell. Dashboard and Relay both call `tw rpc create-terminal` on the target host, so the session is recorded in managed state and visible under Terminals. Dashboard-only label and runtime identity metadata remains in `~/.tw-dashboard-terminals.json`; the visible terminal order, including discovered terminals, is stored with the Dashboard layout in `~/.tw-dashboard-layout.json`. Drag any Terminal row, or focus its handle and press Up/Down, to change an order that survives relaunch.

## Configure The Feishu Bot

Feishu Bridge uses a `lark-cli` application profile as a bot. Open `Settings → Integrations` to add a bot, delete the selected bot, or choose which bot is active; selecting an entry takes effect immediately and a newly added bot is selected automatically when no binding blocks the change. Dashboard derives the local-only `lark-cli` profile key from the App ID, but presents the application name returned by Feishu/Lark (falling back to App ID) instead of exposing that internal key. The App Secret is sent directly to `lark-cli config init --app-secret-stdin`; Dashboard never writes that secret to its configuration or command arguments.

`Link group` loads every page of group chats visible to the selected application bot and offers them in a picker; Chat ID and group name remain editable as an explicit fallback. The link dialog also shows an editable, non-sensitive session summary for the lifecycle card and a **Reply placement** choice. **Topic reply** is the default and keeps each answer in the source message topic; **Direct reply** still replies to the source message but places the card in the group's main message flow. This choice only changes reply placement: Card JSON 2.0 rendering and reactions stay the same, and a failure never falls back to the other placement. No administrator Open ID is required. A normally writable `FREE` Dashboard terminal does not need a preparatory keystroke: Link Group acquires the lazy interactive lease and submits the Feishu handoff under the same PTY lock. A real Feishu owner or `RECOVERY_REQUIRED` state still fails closed. Once the exact binding and lease are durable, the bot sends a top-level Card JSON 2.0 status card with the managed session type, tmux session name, exact lifecycle ID, and public summary. After linking, any human member of that group can @ the bot to send one message into the bound session. Bot/self and non-user events are ignored, ordinary messages without the exact bot mention are not injected, and only the current turn's explicitly marked public reply is sent back as a non-streaming Card JSON 2.0 card using the binding's selected placement. Reply and status cards use `tw agent on <session>` as their title; the bound tmux session name is normalized to one line and shortened when necessary, while the full prompt and terminal output never enter the title. A turn times out only after ten consecutive minutes with no new fenced terminal output: every new byte from the same target, epoch, generation, and fence slides that inactivity deadline, so a long-running Agent is not cut off by a fixed ten-minute wall clock. Dashboard's `agent running` hint does not authorize delivery; the final card is still sent immediately only after the exact closed turn marker is present in the correlated rendered snapshot. The bot adds a `Typing` reaction after terminal input is accepted, removes it when processing settles, and replaces it with `CrossMark` only for a certain failure. Reaction write failures are a visual degradation only and never change terminal ownership or the reply result; the bot profile needs `im:message.reactions:write_only` for those indicators. An empty picker means the selected application bot reported no group memberships, rather than silently hiding the lookup. `Settings → Integrations` shows the selected bot's current `session → group` bindings and their active, paused, pausing, or stale state, lets you change Reply placement when no turn is active, and provides a confirmed **Unlink** action even when the original terminal is no longer present. Existing bindings created before this setting default to Topic reply.

Manual unlink releases a live Feishu lease, or first proves that Feishu no longer owns the exact target, before durably removing the binding and queuing a top-level reason card. A stale binding with no recoverable lease remains visible when authority is still Feishu-owned or `RECOVERY_REQUIRED`; recover it locally first, then unlink. The Bridge also reconciles every persisted binding, including paused and stale bindings, against its exact `controlTargetId` at startup and during maintenance. A certainly deleted target is removed and announced as deleted; a same-name replacement is removed only after the old exact target is proven ended, and is never selected automatically. Controller unavailability, `RECOVERY_REQUIRED`, and a new ID caused only by unknown controller continuity remain fail closed without a false group announcement. Lifecycle cards use an independent ordered, best-effort lane with deterministic idempotency, so slow delivery cannot block lease renewal and a send failure cannot roll back binding state.

Dashboard probes `bridge.info` before using newer binding fields. It replaces an empty legacy daemon with the bundled same-version Bridge. If a legacy daemon still has bindings, Dashboard keeps normal inspection/removal available but rejects new links and never sends the optional session summary to the older closed parser. A confirmed stale/pausing removal can gracefully migrate that daemon first only when it is the daemon's sole binding and no active turn would be disrupted; ambiguous remove acknowledgement is checked by snapshot and never blindly retried. As a one-time rolling-upgrade exception, removing an active/paused binding through the already-running legacy daemon cannot emit the newer lifecycle card: Dashboard preserves that daemon's canonical removal path instead of interrupting live authority, and a later current-capability operation upgrades it once empty.

Dashboard saves only the non-sensitive profile name as `feishuBridge.larkProfile` in `~/.tmux-worktree.json`. App secrets and access tokens remain owned by `lark-cli`; the bridge always invokes that profile with bot identity. `TW_FEISHU_LARK_PROFILE` is an explicit environment override and disables profile changes in Settings.

Changing profiles safely restarts an empty bridge. The Dashboard refuses the change while any Feishu group is linked, so a binding cannot silently move to another bot. Unlink all groups before selecting a different profile.

Merely opening or backgrounding a managed terminal does not lock it. Dashboard, Android/Relay, controlled CLI attachments, and `tw serve` share one interactive ownership class: their first real input joins the same lease/fence, their operations are serialized by the target controller, and closing or backgrounding one attachment never makes another interactive attachment read-only. A clean release from the last registered interactive attachment returns the target to `FREE`; after an abnormal exit, an unrenewed interactive lease is fenced and safely returned to `FREE` once the target and output capture are re-established. Feishu is the only exclusive owner. When the banner says Feishu owns input, use **Take over locally** (or pause/force-pause the binding) to drain or cancel the Feishu turn and return the session to all App/APK clients. `Recover local input` is reserved for genuinely uncertain operations or controller/backend continuity; it is not a shortcut around an active Feishu lease.

The bounded files under `terminal-control-output-v1` are not the terminal screen or tmux history. They are a private correlation capture used only to detect the current Feishu turn's closed nonce marker; Dashboard, `tw serve`, and Relay continue to display their normal PTY/tmux output independently. A generation rolls across two 4 MiB segments and retains roughly the latest 4–8 MiB using an absolute cursor. Reading an already-evicted cursor returns `STALE_OUTPUT_CURSOR` for that observation without putting the terminal into recovery or hiding its visible output, and files from fenced old generations are reclaimed. If a fast command outruns a Feishu poll, the Bridge rechecks the same lease, fence, epoch, and generation before rebuilding its read-only marker parser from the guaranteed retained window; it never resends the command. Once raw output proves the marker is closed, the card body is extracted only from a bounded tmux-rendered snapshot captured under that same Feishu lease, pane, fence, epoch, and generation. This applies cursor movement and erase-line semantics before extraction, so a fullscreen Agent's composer and footer are not flattened into the public reply. A snapshot without the complete nonce, or a transient read-only capture/transport failure, is retried and never falls back to raw terminal text; authority, target, generation, protocol, and correlation failures still fail closed immediately. Binding activation and each authorized inbound turn first require the controller's advertised `output.rendered-snapshot` capability; an older or rolled-back controller is rejected before Feishu ownership transfer, event dedup, or terminal input, so upgrading and retrying the same event remains safe. After an upgrade, a legacy output-capture recovery can clear itself under the existing idle non-Feishu repair rule only when the controller proves the exact target is still current, ownership is `FREE`, and no operation or handoff is in flight. Identity, Feishu turn, handoff, or write-disposition uncertainty still requires the normal fail-closed recovery flow.

On Android Relay v1, `Input unavailable` means the current APK stream latched a strictly classified authority rejection locally; it does not mean the APK owns a server-side lock. The relay-host renews its shared interactive lease and re-acquires it before a new operation if a cached lease has expired, so ordinary lease expiry is not a durable mobile lock. Use **Retry input** to open a fresh terminal stream immediately, or let normal stream/transport recovery create one. A fresh stream clears the old client latch but never replays the rejected or queued keystroke; if Feishu still owns input, the next new user keystroke is rejected and the new stream becomes read-only again. APK resize is attachment-local and does not resize the shared tmux window shown by Dashboard.

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

The skill tells the agent to use `tw rpc create-worktree`, not plain `tmux new-session` or a manual `git worktree add`, because RPC is headless, emits a machine-readable result, and records the session in TW managed state. Bare `tw <ai-command> <project>` now creates the same single-pane session contract, but it also attaches the invoking terminal for interactive CLI use.

## Troubleshooting

- `bash: claude: command not found`: install Claude on the remote host and verify `PATH="$HOME/.local/bin:$PATH" claude --version`.
- `bash: codex: command not found`: install Codex on the remote host and verify `PATH="$HOME/.local/bin:$PATH" codex --version`.
- Host is reachable but the Dashboard says `tw` is missing: install remote `tw` from the GitHub source checkout, then re-test the host.
- Remote path picker is empty for `/home/<user>`: the host may use a symlinked home. Current Dashboard follows symlinked directories; update the app and remote `tw`.
- Dashboard cannot see a remote tmux session: confirm it was created by `tw` and appears in `tw rpc list`.
- Existing failed panes do not inherit newly installed commands. Recreate the session, or run `export PATH="$HOME/.local/bin:$PATH"` inside that pane before starting the command.
- A Dashboard tmux window remains too small or shows a dotted unused region: update the Dashboard, then reopen that terminal. The selected xterm now waits for the workspace layout to settle, and a FREE managed target uses a short acquire→resize→release terminal-control transaction so the real tmux window matches the viewport without remaining locked. The same path runs against the target host for remote managed terminals.
