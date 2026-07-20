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

The Dashboard's `New terminal` AI command is optional. Leaving it empty creates the same
TW-managed single-pane terminal directly in a login shell.

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

The Dashboard persists the selected Relay center as `mobileRelay.brokerHostId`. **Set up Relay** performs the normal flow in one action: it deploys the same-version bundled `tw` broker, reuses a saved fixed WSS endpoint or starts a temporary Quick Tunnel, saves the generated URL and Relay v1 token, and starts the Mac connector. When a Linux amd64/arm64 Relay center has no `cloudflared`, Dashboard downloads its pinned official Cloudflare release, verifies the published SHA-256 digest, and installs it under `~/.tmux-worktree/bin` before replacing any existing tunnel. Quick Tunnel DNS can propagate after the URL is published, so the connector remains in its explicit retry/backoff state until the trusted `wss://` endpoint resolves instead of tearing the remote setup down. A reconfiguration rotates the shared token. Android pairing is offered only after the connector reaches the trusted root `wss://` URL. The editable fields and individual Save/Start controls remain available for fixed production WSS and recovery.

Relay v1 is one trusted administration domain backed by one shared token; it is not a multi-tenant credential model. Hosting unrelated users on one shared Relay service requires the future Relay v2 role-scoped enrollment implementation described in the [parallel implementation plan](docs/relay-v2-implementation-plan.md).

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

The broker-credential N-API artifact has a separate, explicitly unwired local-target verification flow. It is not part of the ordinary build, npm lifecycle, Dashboard bundle, or production Relay runtime:

```bash
npm run build
npm run build:relay-v2-broker-credential-native -- --target darwin-arm64
npm run verify:relay-v2-broker-credential-native-pack -- --target darwin-arm64
```

The opt-in stage command builds the target's locked Rust release artifact, verifies its Mach-O/ELF target identity, and publishes the one fixed loader-relative `.node` at a hard-link commit point after all byte and empty-layout checks. It never rolls back the final name after that commit and only identity-checks cleanup of its private random staging directory. The pack verifier runs `npm pack --ignore-scripts` in its own temporary directory, accepts only bounded pure-ustar regular/directory entries, streams an exact file allowlist into inspector-created directories, checks the fixed tar/unpacked layout, imports the unpacked fixed loader, and runs the focused closed native-binding test against unpacked JavaScript and native artifacts. This Node-only foundation detects and preserves observed identity replacements, but does not claim protection against a malicious same-uid final-directory rename race because Node exposes no `openat/linkat/unlinkat` path.

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
3. Bundles `dist/cli.cjs` into the Dashboard app as `tw-cli/cli.cjs` for canonical local lifecycle RPC and the Mobile Relay `tw serve` / `tw relay-host` runtimes.
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
- [Relay v2 contract](docs/relay-v2-contract.md): frozen protocol contract with shared Node/Android codec conformance fixtures. Node includes unwired H0–H3, an injected stateless adapter from H3 to the existing terminal-control protocol, a bounded host route/runtime core, and a default-off host composition/readiness foundation that connects only their typed ports. The composition accepts H1 only through the opaque one-shot candidate issued inside the command plane's final recovered HostState audit cut; exact hostId/hostEpoch/hostInstanceId matching synchronously publishes H1 and gives only a private gated command facade to runtime, while public H1 readiness exposes only `close()`. H2 is opened asynchronously from a different opaque one-shot candidate issued only by the canonical snapshot-spool entry after `open()` recovered an unexpired current-owner cut whose manifest exactly matches a fresh materialized candidate. The candidate binds the current host process, owner fence/spool generation, exact recovered snapshot/materialized identity, same-spool owner and an issuer/receiver pair whose receiver remains private to canonical host composition; composition does not return until the internal receipt verification, activation lease attachment and H2 readiness publication all succeed. Public H2 readiness exposes only frozen `close()`. Cut release, owner takeover, spool/fatal close and later observed expiry synchronously withdraw active H2; expiry has no composition timer. H1/H3 close or fatal failure synchronously withdraws readiness and applies the existing 4406 route fence; composition disposal waits for admitted H1 calls and H3 manager shutdown. The composition now also owns one fixed-generation readiness producer statically bound to the production strict codec; base and carrier composition expose that producer only as a frozen `close()` lifecycle. This producer and composition are still not wired by `src/relayHost.ts` or capability advertisement, the carrier continues to advertise an empty capability set, and the isolated seam does not establish production readiness. The adapter does not auto-start a daemon, retry terminal input/resize, retain a parallel lease/operation fact, or provide direct tmux fallback. A separate [broker credential native state-store contract](contracts/relay/v2/broker-credential-state-store-v1/README.md) is at revision 2 while its N-API interface, storage/binary format and fixtures remain v1; it freezes exact secure-open, traditional process-owned `F_SETLK`, shared registry/fork/final-close semantics and deny-by-default durability qualification without changing the artifact, ABI or bytes. Independent unwired Rust foundations provide the bounded binary selector and owned transaction/publication/close core, the shared platform-common lifecycle owner, Darwin/Linux platform open seams, and a target-selected raw N-API binding. The binding eagerly captures the process lifecycle token and exposes only the frozen capability/open ABI over platform-common `ProcessBound*` and the selected platform seam; it does not own readiness, credential schema, continuity, fallback, or capability advertisement. The qualification allowlist is empty, so no platform-adapter-qualified real open or actual opened JavaScript transaction is reachable. An explicit, unwired local-target build/stage/npm-pack verification foundation now shares the loader's four fixed artifact descriptors, checks the Cargo artifact's Mach-O/ELF target identity, uses a final hard-link as the sole no-rollback commit point, verifies the temporary `npm pack --ignore-scripts` bounded pure-ustar/unpacked layout, imports the unpacked fixed loader, and runs the existing closed native-binding test against unpacked JavaScript and native artifacts. Its Node path checks do not claim malicious same-uid final-directory replacement resistance. Current evidence is Darwin arm64 only; there is no Darwin x64 or Linux run, four-target matrix, bit reproducibility, Dashboard bundle, signing/notarization, minimum-OS/glibc/SDK qualification, artifact provenance, qualified real open, production injection/composition/wiring, continuity readiness, or ready capability. The Dashboard still carries only `cli.cjs`; the loader/CJS resource layout is not a Dashboard shipping contract. An unwired optional loader performs explicit target/N-API/fixed-artifact selection, and an unwired credential authority source foundation owns the opaque credential state and external-continuity gate. The credential authority APIs for enrollment create/redeem, client/host refresh, host reauthentication, and host bootstrap, plus the strict B1 `POST /v2/hosts/bootstrap` ingress adapter, are callable only in isolated modules and focused tests. Node also has an unwired broker credential live-authorization/fence foundation: durable revoke and kid removal publish exact authorization revision/fence receipts; BrokerCore rechecks expiry, role/host binding, stale attach/auth-control and each route/frame dispatch; first authority withdrawal synchronously latches all broker admission/active-data gates through the same narrow port. Once-only close signals expose only a typed symbolic reason, safe authorization snapshot and connection incarnation; an independent unwired transport-close coordinator consumes them through exact kind/ID/incarnation matching and implements the 4401/4403/1013 policy plus a separate 5000 ms force-destroy deadline. Production composition adoption, listener/socket wiring, and real ready-loss evidence remain absent. Node also has an independent unwired E1 external-continuity HTTPS adapter foundation for the outer transport/decode boundary. B1 and E1 are not connected to a production listener/composition, the E0 production backend and production ready-loss wiring remain unimplemented. Response replay-key rotation exists only as an unwired private credential-envelope v3 foundation with a bounded active/decrypt-only keyring, exact record key IDs, lossless v1/v2 single-key state/ciphertext/TTL migration, idempotent rotation IDs, and fatal unknown-key/AEAD/malformed handling; it has no production management entry point, changes no public wire, and creates no readiness, enrollment, credential, or capability production path. Binding, staging, or pack verification is not readiness and never authorizes v1/BAU fallback. The rejected BAU path/JSON design is not part of the delivered source and is not a fallback. Android production now has a strictly limited path for already-present, cold-start-admitted explicit v2 profiles: one actor, bounded RFC6455 WSS, the isolated Room state-sync repository, durable command-query/recovered dispatch, and bounded fresh `QUEUED` dispatch. Only the exact actor `OnlineReady` cut starts fresh production; recovered capabilities flush first in durable commit order, then the Outbox core and Room transaction select creation-ordered batches of at most 32, commit `QUEUED` to `SENDING`, and only afterward issue Execute capabilities through the actor-owned `sendIfCurrent` transport gate. A crash after commit or a partial send leaves `SENDING`, so restart queries and never blindly resends. The same state database contains Outbox and terminal checkpoint rows but no credentials. Android still has no v2 Outbox UI/enqueue path, production HTTPS enrollment/refresh/self-revoke, terminal or Agent runtime, reconnect/backoff, capability advertisement, or real-device/public-Relay-TLS interoperability evidence. This limited Android path does not make Relay v2 ready or available end to end; relay-server and relay-host production remain v1, and no fallback is added.

  Node also includes an unwired B4 credential HTTPS ingress foundation for the frozen enrollment redeem, client/host refresh, and self-revoke endpoints. It reuses the B1 strict HTTP boundary and calls only credential-authority ports; no production listener, E0 composition, readiness, capability advertisement, or v1 fallback is connected.

  The H2 composition seam uses the canonical `stateSnapshotSpool.js` entry as its only recovery-candidate registry and closed runtime-composition owner, so separately bundled WeakMap copies cannot validate a candidate. A candidate exposes no receiver, sink, receipt, release operation or runtime/spool port. Its issuer half is held only by the spool registry, while the exact receiver closure and readiness sink remain private to canonical host composition; a newly created foreign pair cannot consume an existing candidate. The public closed operation returns only the complete runtime composition after exact verification, activation and readiness publication, and construction failure cancels the claimed candidate and activation before returning. Only complete recovered cuts participate; selection is deterministic by newest `snapshotCreatedAtMs` then smallest `snapshotId`, and no missing exact match triggers a scan, rebuild, retry, timer, rotation or fallback. The legacy standalone `{ cutSource }` spool API remains available but cannot mint composition candidates. Copies, proxies, replays, foreign entries, identity mismatch, or a real spool A combined with H2 B fail closed. A release throw, invalid result, or observed native-Promise rejection poisons the H2 activation owner and is never retried; arbitrary thenables are not assimilated.
- [Relay v2 external continuity authority v1](contracts/relay/v2/external-continuity-authority-v1/README.md): frozen future interop/security contract for a rollback-independent linearizable read/CAS backend, stable provisioning/ACL, bounded exact-endpoint/no-redirect HTTPS with status-200-only closed decoding and no-store request/response caching policy, decoded-tuple request identity, closed internal error mapping, recovery, independent broker/Agent namespaces, and namespace-scoped failure fencing. Node has an independent unwired HTTPS adapter foundation for the exact outer transport/decode boundary; it uses the continuity owner's abort signal and does not add a second operation timer. There is still no production backend, auth/config source, authority injection, listener/composition, extension reset wiring, or production adoption of the isolated close policy and ready-loss socket evidence; those remain required production implementation/evidence, so v2 readiness, enrollment, and capability advertisement remain NO-GO.
- [Relay Agent extension v1](docs/relay-agent-transcript-lifecycle-extension-v1.md): frozen optional-extension fixtures plus unwired Node host authority/public codec/durable store/replay runtime and Android lifecycle/notification foundations. Android now also has a default-off runtime composition seam that reuses one durable repository instance for the existing frame consumer, notification dispatch coordinator, and revision-pinned read projection. It only handles effects explicitly passed by an upper layer, returns `NotOwned` with the complete original effect for non-Agent effects and Agent unavailability to the upper-layer dispatcher, and does not collect from or construct a Relay v2 actor. Only an unavailable effect carrying an exact failed request/admission identity belongs to the RequestSync redrive owner. The Node store requires an explicitly injected shared monotonic/CAS continuity port, publishes exact durable-byte checkpoints through its existing locked local CAS, and rejects paired local rollback against the external anchor. Its future `agent-transcript-lifecycle.v1` anchor namespace/ACL/reset/tombstone history and failure scope are independent from broker credential continuity; continuity failures reuse its existing unavailable/commit-uncertain/corrupt store errors and never globally fence base v2. Unavailable preserves provable timeline/cache lineage for authority repair/reopen; only corrupt continuity permits extension reset/new epoch. The Android seam is not instantiated by the production root, default optional capability advertisement remains empty, and no real platform notification executor, UI/notification startup, production monotonic-authority adapter, relay-host wiring, G4 acceptance, or capability advertisement exists yet.
- [Relay v2 implementation plan](docs/relay-v2-implementation-plan.md): parallel broker, relay-host, Dashboard, Android, Agent-extension work packages and their interoperability gates.

## Relay v2 implementation status

Relay v2 remains unavailable in production. Its isolated Node host composition
foundation now owns one fixed-generation producer statically bound to the
production strict codec and exposes its public codec lifecycle only as frozen
`close()`. It admits command H1 only from the final recovered HostState audit
cut and terminal H3 only after the durable lineage owner issues an exact,
one-shot process candidate for the same manager. H2 composition opens only
from a canonical-spool one-shot candidate for an exact recovered pinned cut and
returns only after the private activation is ready. H1/H2 remain private to runtime;
H1/H2/H3 withdrawal gates new work immediately and fences active routes before
admitted H1 calls drain and the H3 manager shuts down. This is not wired to
`relay-host` or capability advertisement, the carrier still advertises no v2
capabilities, and no protocol fallback is added.

Android's admitted explicit-v2 base composition also owns a limited durable
Outbox path: attempted commands are queried, recovered Execute capabilities are
flushed in commit order, and only then are creation-ordered fresh `QUEUED`
batches committed to `SENDING` and sent through the actor's exact-generation
gate. There is still no v2 Outbox UI/enqueue source, end-to-end server/host v2
runtime, capability advertisement, enrollment, reconnect, terminal, or Agent
delivery, so Relay v2 remains unavailable as a complete production feature.

## License

MIT
