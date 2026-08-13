<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="88" alt="TW logo" />
</p>

<h1 align="center">TW — Agent Mission Control</h1>

<p align="center">
  <strong>Your agents. Your machines. One control room.</strong><br />
  Run AI coding agents in isolated worktrees, see what needs you, and take control from Mac, Android, or Feishu.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
  <span> · </span>
  <a href="https://github.com/Sskift/tmux-worktree/releases/latest">Download for macOS</a>
  <span> · </span>
  <a href="docs/quickstart.md">Quick start</a>
  <span> · </span>
  <a href="docs/demo.md">Launch the demo</a>
</p>

<p align="center">
  <a href="https://github.com/Sskift/tmux-worktree/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Sskift/tmux-worktree?label=release&color=7c3aed" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-111827" /></a>
  <img alt="macOS and Android" src="https://img.shields.io/badge/platform-macOS%20%7C%20Android-111827" />
  <img alt="Local first" src="https://img.shields.io/badge/local--first-yes-16a34a" />
</p>

<p align="center">
  <a href="docs/demo.md">
    <img src="docs/assets/tw-dashboard-hero.png" alt="TW Mission Control running on a desktop and Android phone" width="100%" />
  </a>
</p>

<p align="center"><strong>▶ Launch the interactive product demo</strong></p>

---

## AI is working. You do not have to watch it work.

Coding agents changed the bottleneck. The hard part is no longer starting one agent; it is directing several agents without losing track of branches, terminals, machines, and unfinished conversations.

TW gives each task a real, isolated workspace and brings every live task into one native control room. Start more work. Patrol fewer terminals. Return only when something needs a decision.

![Mission Control overview](docs/assets/tw-dashboard-overview.jpg)

## One task. One real workspace.

Choose a repository, base branch, agent, and target machine. TW creates a dedicated branch, Git worktree, and managed tmux session. Agents can work in parallel without sharing a checkout or colliding with another task's uncommitted changes.

Claude Code, Codex, Gemini CLI, OpenCode, Aider, and Kimi Code can be discovered on the target host. Plain shell terminals live beside agent workspaces when the task needs a human hand.

## Stop patrolling terminals.

Mission Control turns many terminal windows into an attention queue. See what is running, what changed, and what is ready for review across local and SSH-connected hosts. The Agent Inbox brings the next decision to you instead of making you hunt for it.

![Agent workspace](docs/assets/tw-dashboard-agent-workspace.jpg)

## Review where the work happened.

The terminal, file tree, editor, Git status, diff, and commit graph stay attached to the same worktree. Move from an agent's answer to the exact source and branch without reconstructing context in another app.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/tw-dashboard-code-editor.jpg" alt="Built-in source editor" /></td>
    <td width="50%"><img src="docs/assets/tw-dashboard-git-log.jpg" alt="Git commit graph" /></td>
  </tr>
</table>

## Leave the desk. Keep the thread.

TW can span the Mac in front of you, SSH devboxes elsewhere, an Android client, and Feishu group conversations. Relay v2 exposes the same managed task catalog to paired mobile clients, while Feishu bindings let a team steer a selected local agent session and receive its result back in the conversation.

Terminal input is guarded by target-scoped ownership leases and fencing, so supported writers do not silently type over one another during a desktop, mobile, CLI, or Feishu handoff.

## Make the routine disappear.

Save recurring review, check, and summary prompts as Automations. Run them on demand or schedule them with a cron expression and timezone. Their sessions return to the same Dashboard, ready to inspect like any other task.

Automations are currently scheduled by the running Dashboard process; they are not advertised as an always-on cloud scheduler.

## Built around your tools, not instead of them.

TW is not another coding model and it does not ask you to move code into a hosted IDE. It coordinates the command-line agents, repositories, tmux sessions, Macs, and SSH hosts you already use.

| Surface | What it does |
| --- | --- |
| **TW Dashboard** | Native macOS Mission Control for agent inbox, worktrees, terminals, files, Git, connections, and automations. |
| **`tw` CLI** | Creates and manages isolated worktree sessions, terminals, hosts, automations, and machine-readable lifecycle RPC. |
| **TW Mobile** | Android client for paired Relay v2 hosts, session visibility, agent chat, and terminal access. |
| **Feishu bridge** | Binds an authorized group conversation to one exact local managed session with controlled input ownership. |

## Try the product without touching your repositories

The repository includes a deterministic preview backend with fictional worktrees, a remote Build Mac, Git history, automations, and paired phones. It does not read or modify your real tmux sessions or repositories.

```bash
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install
npm --prefix app install
npm run demo
```

The browser opens at `http://127.0.0.1:1420/?backend=fake`. See [the demo guide](docs/demo.md) for the walkthrough and recording script.

## Install

### macOS Dashboard

Download the latest DMG from [GitHub Releases](https://github.com/Sskift/tmux-worktree/releases/latest), move `tw-dashboard` to Applications, and open it. The current Dashboard requires macOS, `git`, `tmux`, and Node.js 20 or newer.

```bash
brew install git tmux node
open -a tw-dashboard
```

### CLI from source

Install `tw` on each local or remote machine that will create managed sessions:

```bash
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install
npm run build
npm link
tw setup
tw doctor
```

Then create your first isolated agent task:

```bash
tw codex /path/to/your/repository improve-search
# or
tw claude my-configured-project fix-auth --branch develop
```

Open the full [quick-start guide](docs/quickstart.md) for project configuration, SSH hosts, Android, and Feishu.

## What is ready today

| Capability | Status |
| --- | --- |
| macOS Dashboard and `tw` CLI | Ready |
| Local managed worktrees and terminals | Ready |
| SSH-hosted managed worktrees | Ready |
| Files, editor, Git status, diff, and graph | Ready |
| Manual and scheduled Automations | Ready while Dashboard is running |
| Feishu binding for local managed sessions | Ready with `lark-cli` configuration |
| Relay v2 self-hosted path | Explicit self-hosted profile; follow the in-app setup |
| Android client | Source/device-test build; no signed production release in this revision |
| Windows/Linux desktop app | Not currently shipped |

## Documentation

- [Quick start](docs/quickstart.md) — install, configure, and launch the first task.
- [Product tour](docs/product-tour.md) — the complete task journey across Dashboard, mobile, and Feishu.
- [Demo guide](docs/demo.md) — safe fake-data preview and the official film storyboard.
- [Security model](docs/security.md) — local-first data, self-hosting, and terminal input ownership.
- [Architecture](docs/architecture.md) — product surfaces and authority boundaries.
- [Troubleshooting](docs/troubleshooting.md) — common setup and runtime checks.

## The honest boundary

TW is built for an individual developer or a trusted small team operating machines they control. The Dashboard is macOS-only today; TW Mobile is Android-only and not yet distributed as a signed production build; Relay v2's self-hosted mode is not a multi-tenant SaaS control plane. Most CLI agents run through their native terminal interface rather than a universal structured tool-call protocol.

That boundary is deliberate: your agents, your machines, and a control room you can understand.

---

<p align="center">
  <strong>Run more agents. Watch fewer terminals.</strong><br />
  <a href="https://github.com/Sskift/tmux-worktree/releases/latest">Download TW</a>
  ·
  <a href="docs/quickstart.md">Build from source</a>
  ·
  <a href="LICENSE">MIT License</a>
</p>
