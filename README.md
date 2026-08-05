<p align="center">
  <img src="app/src-tauri/icons/icon.png" width="96" alt="tmux-worktree logo" />
</p>

<h1 align="center">tmux-worktree</h1>

<p align="center">
  A macOS Dashboard and CLI for running AI coding agents in isolated git worktrees, managed tmux sessions, SSH remote hosts, and Android relay clients.
</p>

<p align="center">
  <a href="https://github.com/Sskift/tmux-worktree/releases/latest">
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
| `tw` CLI | Headless control plane for managed worktrees/terminals, SSH Hosts, automations, relay, and machine-readable RPC. |
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

Download the DMG from the latest GitHub release:

[Download the latest `tw-dashboard` DMG](https://github.com/Sskift/tmux-worktree/releases/latest)

Then install it like a normal macOS app and open it:

```bash
open -a tw-dashboard
```

The current DMG bundles the exact Dashboard CLI JavaScript but not a separate Node runtime. Install Node.js 20+ on the Mac so local managed create, restore, and kill operations can use that bundled same-version RPC implementation. A globally installed `tw` is accepted only when both its version and lifecycle capabilities match the Dashboard.

When a repository or its main Git checkout lives in Desktop, Documents, or Downloads, macOS asks for access the first time the Dashboard opens its files or Git metadata. Allow that folder so worktree Git status and diffs can resolve the linked main repository.

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

The current Compose Android client is built and released separately from the macOS Dashboard. This repository revision has not completed a signed Android production release; do not use an older GitHub debug APK to evaluate the current source.

Build the device-test APK from the current checkout:

```bash
npm run verify:android
```

This builds `mobile/android/app/build/outputs/apk/debug/app-debug.apk` after the Android JVM and Lint gates. The Debug APK is for direct device testing. `:app:assembleRelease` currently produces an unsigned verification artifact, not an app-store or production-distributable build. See the [Android relay guide](docs/remote-relay-android.md) for installation and pairing.

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

New CLI and Dashboard worktree sessions use the same managed, single-pane tmux contract. A configured project name or a direct git repository path always creates a worktree and records it in `~/.tmux-worktree/state.json`; non-git paths are rejected. The AI command runs in the single pane and returns to a login shell when it exits. Older multi-pane CLI sessions remain attachable until you close them; `tw` does not rewrite live sessions.

`tw` intentionally does not duplicate Dashboard presentation features. Files, the editor, Git graph, themes, layout, Pinned, and selection state remain Dashboard responsibilities. The binary owns the host/runtime mutations that humans and agents need to automate reliably.

Open the Dashboard:

```bash
open -a tw-dashboard
```

Typical Dashboard flow:

1. Click `New worktree`.
2. Choose a local project or SSH host.
3. Choose one of the supported agents detected as available on that machine.
4. Attach to the tmux terminal, inspect Git state, edit files, and keep scratch terminals nearby.

## Dashboard

The macOS app is built with Tauri 2, React, xterm.js, and a Rust PTY backend.

| Area | Purpose |
| --- | --- |
| Worktrees | Create, restore, attach, clean up, and drag to reorder TW-managed git worktrees. |
| Terminals | Keep and drag to reorder standalone tmux login-shell terminals next to agent sessions. |
| Git panel | Track active branch, changed files, diffs, and recent commits for the selected session cwd. |
| File tree and editor | Browse files, edit source, preview Markdown and images, and search by filename or content. |
| Automations | Define reusable instructions, run them now, pause them, or schedule them. |
| Layout | Persist window state, sidebar state and ordering, column order, editor state, and selected panes. |

Runtime state is stored in user-local JSON files:

| File | Owner | Purpose |
| --- | --- | --- |
| `~/.tmux-worktree.json` | CLI and Dashboard | Projects, SSH hosts, and worktree root. |
| `~/.tmux-worktree/state.json` | CLI and Dashboard | TW-managed sessions and worktrees. |
| `~/.tw-dashboard-layout.json` | Dashboard | Window, columns, sidebar ordering, file tree, editor, diff, and selection state. |
| `~/.tw-dashboard-terminals.json` | Dashboard | Saved standalone terminals. |
| `~/.tw-dashboard-automations.json` | Dashboard | Automation definitions. |
| `~/.tw-dashboard-automation-runs.json` | Dashboard | Recent automation run history. |

## CLI

Common commands:

```bash
tw setup
tw ls
tw serve
tw relay-server
tw relay-host
tw rpc list
tw rpc capabilities
tw host ls --json
tw host probe --json
tw automation ls
```

Create managed sessions:

```bash
tw claude myapp
tw claude myapp fix-auth
tw codex ~/code/backend
tw rpc create-worktree --project myapp --ai-command "claude" --name fix-auth
tw rpc create-terminal --cwd ~/code/backend
tw rpc create-terminal --cwd ~/code/backend --ai-command "codex"
tw rpc restore-worktree --path ~/.tmux-worktree/worktrees/myapp/myapp-fix-abc12 --name myapp-fix
tw rpc kill-session --name tw-term-abc12
```

The Dashboard's `New terminal` flow always creates the TW-managed single-pane terminal
directly in a login shell. The lower-level CLI/RPC command still accepts an explicit
`--ai-command` for automated callers that need one.

`tw ls` is non-interactive and exits after printing the current session list; `tw status` remains a compatibility alias. Session switching remains available through `tw attach <session>` and native tmux; the CLI no longer opens an alternate-screen status UI or creates status/extra-shell panes.

Manage and operate configured SSH Hosts without opening the Dashboard:

```bash
tw host add --id remote-dev --host remote-dev.example.com --user alice --json
tw host probe remote-dev --json
tw host connect remote-dev --json
tw host rpc remote-dev create-worktree --path /home/alice/code/demo --project demo --name fix-auth --ai-command codex
tw host attach remote-dev demo-fix-auth
tw host disconnect remote-dev --json
```

`tw host` uses an isolated SSH ControlMaster socket with bounded keepalives. `probe` reports SSH reachability, tmux availability, and TW RPC capabilities separately; a missing tmux binary is no longer reported as an SSH outage.

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

4. Open `Settings → Connections → Add host`, then create remote worktrees from `New worktree`.

Remote worktrees and standalone terminals are created only through `tw rpc create-worktree` and `tw rpc create-terminal`. Discovery merges managed RPC state with strict compatibility checks so older live sessions remain visible; creation never falls back to a second SSH + git/tmux implementation. Upgrade remote `tw` when the required capability is unavailable or incompatible.

## Android Relay

The mobile path has three pieces:

| Piece | Runs on | Role |
| --- | --- | --- |
| `tw relay-server` | Always-reachable broker host | WebSocket broker only. |
| `tw relay-host` | Mac admin machine | Aggregates local and configured remote TW-managed sessions. |
| Android APK | Phone | Lists and attaches to sessions exposed through the broker. |

The Dashboard persists the selected Relay center as `mobileRelay.brokerHostId`. **Set up Relay** performs the normal flow in one action: it deploys the same-version bundled `tw` broker, reuses a saved fixed WSS endpoint or starts a temporary Quick Tunnel, saves the generated URL and Relay v1 token, and starts the Mac connector. When a Linux amd64/arm64 Relay center has no `cloudflared`, Dashboard downloads its pinned official Cloudflare release, verifies the published SHA-256 digest, and installs it under `~/.tmux-worktree/bin` before replacing any existing tunnel. Quick Tunnel DNS can propagate after the URL is published, so the connector remains in its explicit retry/backoff state instead of tearing the remote setup down; if macOS still returns a stale negative `getaddrinfo` result after public A/AAAA records exist, the connector uses those records only for that Quick Tunnel connection while preserving the original WSS hostname and TLS verification. A reconfiguration rotates the shared token. Android pairing is offered only after the connector reaches the trusted root `wss://` URL. The editable fields and individual Save/Start controls remain available for fixed production WSS and recovery.

Relay v1 is one trusted administration domain backed by one shared token; it is not a multi-tenant credential model. Hosting unrelated users on one shared Relay service requires the future Relay v2 role-scoped enrollment implementation described in the [parallel implementation plan](docs/relay-v2-implementation-plan.md).

Settings also contains a separate, explicit **Relay v2 · self-hosted** deployment surface for a Linux x86_64 devbox (Node.js 22.16+, ext-family filesystem). It lets you deploy a single-node Relay v2 broker + Mac host connector for personal use.

- **What it does**: deploys the bundled `tw-cli`, TLS files, and a 0700 state directory to the devbox; starts the Relay Center and the local v2 Host connector; persists a desired-running bit so Dashboard restarts can restore the connector.
- **How to use it**: enter the devbox SSH target, root HTTPS Relay URL, private bind address/port, and paths to local 0600 TLS key, leaf cert, and CA cert. Use **Deploy / update bundle**, then **Start v2 Relay Center** and **Start local v2 Host**.
- **Security posture**: this is the `non-production-single-node-co-located-sqlite-v1` profile (`--v2-single-node-self-hosted`). Credential state, issuer keyring, and a monotonic continuity row live in one co-located SQLite database (`synchronous=FULL`, exclusive locking, machine-id + device/inode bound). It is **not** multi-tenant and **not** rollback-independent production durability (E0). It never reads or promotes the Relay v1 shared token.

This surface does not make Relay v2 production-ready and does not change the default Relay v1 path. Full status, descope records, and the frozen contract: [`docs/relay-v2-status.md`](docs/relay-v2-status.md), [`docs/relay-v2-contract.md`](docs/relay-v2-contract.md).

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
  "worktreeBase": "~/.tmux-worktree/worktrees"
}
```

Supported aliases:

| Setting | Accepted keys |
| --- | --- |
| Project map | `projects`, `repositories`, `repos` |
| Project path | `path`, `dir`, `directory`, `root`, `repoPath`, `repository`, `repositoryPath` |
| Branch | `branch`, `targetBranch`, `target_branch`, `defaultBranch`, `default_branch` |
| Worktree root | `worktreeBase`, `worktreeDir`, `worktreeRoot`, `worktreesDir`, `worktreesRoot` |

Dashboard connected hosts come only from explicit `hosts` config. `Settings → Connections → Add host` can discover non-wildcard aliases from `~/.ssh/config`, but it does not auto-connect every SSH alias on the machine.

## Development

Requirements:

- Node.js 20+
- Rust stable
- Xcode Command Line Tools
- tmux
- git
- Android Studio or an Android SDK with Java 17 for Android checks

Build the CLI:

```bash
npm install
npm run build
node dist/cli.cjs status
```

The Node hidden child exposes this exact Darwin arm64 self-hosted integration seam:

```text
__relay-v2-dashboard-management-stdio --self-hosted \
  --credential-https-ca-input /absolute/path/credential-ca.pem \
  --carrier-wss-ca-input /absolute/path/carrier-ca.pem \
  [--provision-profile-input /absolute/path/profile.json] \
  [--bootstrap-secret-input /absolute/path/bootstrap] \
  [--bootstrap-secret-mode replace-pending]
```

Each input path must be absolute, and each input file must be current-user-owned, regular, single-link, and exact mode `0600`; paths are not secret and contents are read through fd-bound sources. There is deliberately no `--trusted-home`: the lane resolves the current Mac account database home through `node:os userInfo().homedir` and `realpath`, then uses it for the production profile, the canonical default terminal-control socket/state, and real local TW managed-state/session discovery. Its explicit config-loader policy always supplies `{hosts: []}`. It neither filters individual remote fields nor activates any SSH alias from `~/.tmux-worktree.json`, so this non-production lane currently exposes only the Mac local scope; the Linux devbox remains the Center. Trusted production continues to load the strict account Host config, while `--local-development` continues to use its isolated home, socket, and state. If inherited `HOME` exists, its `realpath` must equal that canonical account home or activation fails closed. If supplied, `--provision-profile-input` uses the existing production profile store to create or validate its private directories and atomically write `~/.tmux-worktree/relay-v2-host/profile-v1.json`; without it, that profile must already exist.

`--bootstrap-secret-mode replace-pending` is an exact private operator repair / active-cell recovery selector, not a general bootstrap or capability flag. It is legal only with `--bootstrap-secret-input` on this self-hosted lane and requires the bridge-issued one-shot handoff bound to the exact native cell; production, local development, and direct privileged-intake calls without that handoff fail before reading the candidate or entering the Vault. One initial Vault read is authoritative. For an existing version-zero bootstrap-pending envelope whose durable `oldSecretReference` matches this profile's bootstrap reference, the path preserves its attempt/correlation, performs zero CAS for the same source or exactly one token-replacement CAS for a different source, and then continues bootstrap. For a valid already-active same-lineage version>0 envelope, it performs zero CAS, consumes and destroys the stale candidate, skips bootstrap, and resumes the credential already held by the cell; the candidate never becomes active credential authority. Bootstrap-only, foreign/inconsistent, corrupt, uncertain, or concurrent-conflict state fails closed without re-reading or retrying CAS, deleting the cell, clearing Broker SQLite, extending the five-minute TTL, falling back to Relay v1, or creating readiness/capability/qualification evidence. A native crash that leaves a claim still requires `CELL_RECOVERY_REQUIRED` and is outside this seam.

Self-hosted also consumes the canonical `terminal-control-v1.sock` and the `.relay-v2-exact-*` sibling served by that same daemon. It never creates a second socket/state authority for the same Mac sessions. During the first migration, explicitly upgrade and restart the Dashboard terminal-control owner so the newly bundled daemon serves both the base socket and its exact sibling. If an older incumbent is still live on the base socket but has no exact sibling, Host preflight fails closed; the hidden child does not start, replace, or stop that incumbent.

The native producer accepts no caller path and creates no directory. Before spawning the child, the Dashboard deployment owner must safely create or validate current-user-owned, non-symlink, exact-`0700` `~/.tmux-worktree` and `~/.tmux-worktree/relay-v2-host-credential-atomic-file-cell-v1`. The real account home may remain owner-controlled `0750`. The self-hosted one-shot activation binds the exact native cell to the intake-owned credential authority, so its `host.hello` always advertises the six frozen `RELAY_V2_REQUIRED_CAPABILITIES`. The canonical Host root does not construct an Agent store, Codex process, or extension attachment; self-hosted and production Host offers remain limited to their base-capability policy. The Agent extension stays isolated behind its own contract and foundations. Its persistence claim is limited to a successful CAS and clean close followed by a fresh-process reopen. It does not support snapshot rollback, directory copy/clone/migration, crash recovery, or power-loss durability. The parameterless production child retains an empty capability offer and remains fail-closed/UNAVAILABLE because production `qualifiedRecords=[]`; self-hosted parse or activation failures exit 1 without production or Relay v1 fallback. Dashboard spawn/restart/UI adoption of this argv is intentionally outside the Node seam.

Run the Dashboard:

```bash
cd app
npm install
npm run tauri dev
```

Run aggregate repository verification entry points from the repository root when a change crosses layers or is being prepared for release:

```bash
npm run verify          # CLI, Dashboard, Rust, and documentation
npm run verify:android  # Android JVM tests, Debug/Release lint, and APK builds
npm run verify:all      # core plus Android checks
npm run verify:device   # all checks plus connected Android device tests
```

These aggregate commands are not the default for every change and do not by themselves measure test quality. Follow the risk-driven selection and evidence rules in [AGENTS.md](AGENTS.md#验证选择与证据质量). The device gate requires a running emulator or connected device; the other Android gates do not. When layer-wide validation is warranted:

```bash
npm run test:cli  # builds the CLI once, then runs the root tests serially

cd app
npm run build
npm run test:typecheck
npm test

cd src-tauri
cargo fmt --check
cargo check
cargo test
```

For a targeted root test file, run `npm run build` first and then invoke
`node --test --test-concurrency=1 test/<name>.test.mjs` as described in `AGENTS.md`.

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
2. Builds the standalone root CLI into `dist/cli.cjs` while retaining `dist/*.js` only as repository-local ESM module builds.
3. Bundles the complete canonical `dist/` sibling tree plus the root `package.json` into the Dashboard app under `tw-cli/` for lifecycle RPC, Mobile Relay runtimes, the hidden Relay v2 management child, and self-hosted deployment; the Darwin arm64 Tauri packaging owner must use the dedicated root Host shipping build rather than the ordinary root build before copying these resources.
4. Copies the DMG to `app/installer/dmg/tw-dashboard-arm64.dmg`.
5. Leaves upload and channel-specific publishing outside the repository.

Before publishing, assign one new version consistently across the root npm package, Dashboard npm package, Tauri config, Rust package, and Android package. Do not rebuild an existing Git tag with different code.

Generated asset inputs:

| Path | Purpose |
| --- | --- |
| `dist` | Built CLI. |
| `app/installer/installer.mjs` | `tw-dashboard-install` entrypoint. |
| `app/installer/dmg/` | Bundled macOS installer image. |

## Documentation

- [Agent guide](AGENTS.md): reading order, code ownership, architectural constraints, and change-to-test matrix for contributors and coding agents.
- [Manual](MANUAL.md): setup, local sessions, SSH remote hosts, remote AI commands, and troubleshooting.
- [Architecture](ARCHITECTURE.md): code map, runtime state, release boundaries, and maintenance rules.
- [Android architecture](docs/android-v2-architecture.md): Compose UI V2, state management, Relay v1 limits, and Android acceptance gates.
- [Android relay guide](docs/remote-relay-android.md): persistent broker, Mac connector, phone pairing, and APK development.
- [Feishu Meeting Agent integration plan](docs/feishu-meeting-agent-integration-plan.md): proposed, not-yet-implemented design for visible bot meeting participation without duplicating credentials or terminal ownership.
- [Relay v2 contract](docs/relay-v2-contract.md): frozen wire protocol contract (v2.0.1). Defines the six base capabilities, closed schemas, error table, and acceptance gates. §1–§8 wire semantics are normative; §10 acceptance evidence is tiered by deployment profile.
- [Relay v2 status](docs/relay-v2-status.md): current implementation state, descope records (native credential crates, E0 external continuity, Agent extension Node modules), and deployment-profile evidence tiering.
- [Relay v2 external continuity authority v1](contracts/relay/v2/external-continuity-authority-v1/README.md): frozen future contract for a rollback-independent linearizable read/CAS backend. No production backend exists; E0 is descoped for the single-node self-hosted lane.
- [Relay Agent extension v1](docs/relay-agent-transcript-lifecycle-extension-v1.md): frozen optional-extension contract for Agent transcript/lifecycle/notifications. Node implementation modules removed 2026-08; `codec.ts` and broker capability gating remain. Not part of base v2 delivery.
- [Relay v2 implementation plan](docs/relay-v2-implementation-plan.md): parallel work packages and interoperability gates. G4 (Agent extension) is off the mainline gate sequence.

## Relay v2 implementation status

Relay v2 is **not production-ready**. Default `relay-server` and `relay-host` CLI paths run Relay v1 only.

- **Implemented (default-off, isolated)**: Node v2 codec, broker/host carrier, H0–H3 authorities, credential authority (enrollment/refresh/reauth/bootstrap), Android v2 base runtime (codec, Room state, Outbox, terminal resume, command UI).
- **Self-hosted single-node lane** (`--v2-single-node-self-hosted`): can reach "self-hosted GO" after §10.1–§10.18 pass. Durability is co-located SQLite; no E0/external-continuity evidence required.
- **Multi-tenant production**: NO-GO. E0 (external continuity authority), native credential state-store, real TLS/device/signing/release evidence, and end-to-end G2/G3 interoperability are missing.
- **Agent extension**: deferred. Contract + codec + capability gating retained; Node implementation removed; G4 off mainline.

Full status and descope records: [`docs/relay-v2-status.md`](docs/relay-v2-status.md).

## License

MIT
