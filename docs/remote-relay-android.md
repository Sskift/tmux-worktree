# Remote Relay And Android Client

This guide describes the currently implemented Relay v1 deployment and pairing flow. The frozen v2 wire contract and the non-normative [parallel implementation plan](relay-v2-implementation-plan.md) are development inputs, not additional commands or capabilities available to operators today.

## Model

The relay design has three roles:

- `relay-server` runs on an always-reachable broker. It only authenticates peers and forwards WebSocket messages.
- `relay-host` runs on the Mac that already acts as the Dashboard admin. It reads the same local Dashboard config and aggregates local plus configured SSH remote scopes.
- Android connects to the broker as a mobile Dashboard client paired with that Mac admin connector.

The Mac remains the business authority. It owns the Dashboard state, the `tw serve` terminal backend, and the SSH credentials used to inspect or attach to remote tmux sessions. The Relay v1 broker is still a trusted transport because it authenticates with the shared token and forwards terminal traffic in plaintext inside TLS. Running `relay-host` on a remote machine would make the phone see that remote machine's tmux namespace instead of the same admin view as the Mac Dashboard.

```text
Android app
  -> wss://devbox.example.net
  -> relay-server on a broker
  -> outbound relay-host connection from the Mac admin machine
  -> local tw serve for local tmux streams
  -> Mac SSH to configured remotes for remote tmux streams
```

## Behavior

- Android lists only the selected paired host's sessions.
- WorkTrees and Terminals are separate in the mobile UI.
- Session names exposed to Android are scoped as `<scope>:<raw-tmux-session>`, for example `local:app-task` or `remote-a:repo-fix`.
- Plain tmux sessions are intentionally invisible unless they are Dashboard-managed terminals.
- Remote WorkTrees should be created through TW so they are present in `tw rpc list` or recognizable as `<worktreeBase>/<project>/<session>-<5-hex>` with a `.git` entry.
- Android/APK and every Dashboard window belong to the same interactive input class for a given managed session. They share one target lease/fence and the controller serializes their operations; opening, typing in, resizing, or closing one interactive attachment never locks out another. Feishu is the only exclusive owner. While a Feishu binding holds the session Android remains read-only until the Mac Dashboard uses **Take over locally** or pauses the binding.
- `send_agent_message` remains one Relay v1 command and one acknowledgement boundary. `relay-host` maps it to the target's local terminal-control authority; that authority validates the current lease/fence, pastes the normalized body without appending a newline, waits briefly so the target TUI finishes handling the paste, and submits in a separate tmux stage while holding the same single-writer critical section. It sends `agent_message_sent` only after the controller confirms success; an uncertain paste/submit boundary is not replayed automatically.

## Commands

Start a broker:

```bash
TW_RELAY_SECRET=<secret> tw relay-server --host 127.0.0.1 --port 8787
```

Publish that loopback listener through a trusted TLS reverse proxy. Do not expose the Relay v1 broker as public cleartext WebSocket traffic.

## Stable Broker On A Devbox

The broker should run on a machine that both the Mac and Android can reach. A devbox is a good fit because it can stay online while the Mac and phone reconnect.

Relay v1 uses one shared relay token for all three peers:

- `relay-server` on the devbox
- `relay-host` launched by the Mac Dashboard
- Android client

That shared credential defines one trusted administration domain. Relay v1 is not a safe multi-tenant service for unrelated users: one global token cannot provide tenant isolation or role-scoped revocation. A shared Relay center for many independent customers requires the separately versioned Relay v2 credential and enrollment model; Relay v2 is not implemented yet.

Install or update the CLI on the devbox, then start the broker in a long-lived service. If the devbox has user systemd:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/tw-relay-server.service <<'EOF'
[Unit]
Description=tmux-worktree relay broker

[Service]
Environment=TW_RELAY_SECRET=replace-with-a-long-random-token
ExecStart=%h/.npm-global/bin/tw relay-server --host 127.0.0.1 --port 8787
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tw-relay-server
loginctl enable-linger "$USER"
```

Adjust `ExecStart` if `tw` lives somewhere else:

```bash
command -v tw
```

If user systemd is unavailable, use a dedicated tmux session:

```bash
tmux new-session -d -s tw-relay-server \
  'TW_RELAY_SECRET=replace-with-a-long-random-token tw relay-server --host 127.0.0.1 --port 8787'
```

Expose the broker through a stable, trusted TLS URL and use the same root WebSocket URL in Dashboard and Android:

```text
wss://devbox.example.net
```

Production Android builds require `wss://`. Debug builds allow `ws://` only for emulator/loopback hosts such as `10.0.2.2`, `127.0.0.1`, or `localhost`; private-network cleartext URLs are intentionally rejected because they expose the shared Relay v1 token and terminal traffic.

If the devbox only accepts SSH, a loopback forward can be used for isolated connector diagnostics:

```bash
ssh -fN -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8787:127.0.0.1:8787 devbox.example.net
```

The Dashboard does not create or advertise this forward. A connector may use `ws://127.0.0.1:8787` for explicit local diagnostics, but Android pairing is never exported for cleartext URLs. Production use requires TLS on the Relay center and a configured `wss://` URL.

Start local terminal serving on the Mac:

```bash
TW_TOKEN=<token> tw serve --host 127.0.0.1 --port 8311
```

Start the Mac admin connector:

```bash
TW_RELAY_SECRET=<secret> TW_TOKEN=<token> tw relay-host \
  --relay wss://devbox.example.net \
  --host-id mac-admin \
  --display-name "Mac Admin" \
  --local http://127.0.0.1:8311
```

Example config:

```json
{
  "worktreeBase": "~/worktrees",
  "mobileRelay": {
    "brokerHostId": "devbox",
    "relayUrl": "wss://devbox.example.net",
    "hostId": "mac-admin",
    "secret": "replace-with-the-same-relay-token"
  },
  "hosts": [
    { "id": "remote-a", "label": "remote-a", "host": "remote-a" },
    { "id": "remote-b", "label": "remote-b", "host": "remote-b" }
  ]
}
```

The Dashboard mobile relay menu saves the selected Relay center as `brokerHostId` so the infrastructure target survives an app restart. The saved Relay URL belongs to that center; switching centers never reuses the old URL. **Set up Relay** reuses a valid fixed WSS URL for the same center. If no fixed URL exists, or the saved URL is already a temporary `trycloudflare.com` address, it starts a fresh Cloudflare Quick Tunnel on that center and saves the returned root `wss://` URL. Environment variables still override connector fields when present. Setup refuses to rotate the shared token while `TW_RELAY_SECRET` overrides the saved token.

Automatic WSS setup first uses `cloudflared` at `~/.tmux-worktree/bin/cloudflared` or on the Relay center's `PATH`. If neither exists on a Linux amd64/arm64 center, Dashboard downloads a pinned official Cloudflare release, verifies its published SHA-256 digest, and atomically installs it in the private bin directory before stopping an existing tunnel. Other operating systems or CPU architectures still require a preinstalled `cloudflared`. The broker itself always uses Dashboard's bundled same-version `tw-cli.cjs`; an independently installed remote `tw` is not required for this action. A Quick Tunnel may publish its URL before public DNS reaches the Mac. Dashboard therefore keeps the validated remote tunnel and broker alive, saves the generated profile, and starts the connector immediately; the connector's explicit retry/backoff state owns DNS propagation and reconnects without rotating the profile again. If macOS `getaddrinfo` retains an earlier negative result after public A/AAAA records are available, the connector uses those records only for the Quick Tunnel socket while preserving the original hostname for WSS and TLS verification. The Relay center does not need to resolve its own public hostname. Blocking SSH setup runs outside the Tauri UI thread. A Quick Tunnel is a convenient temporary ingress whose URL may change after restart. Use a fixed trusted WSS reverse proxy or managed named tunnel when the endpoint must be durable.

## Dashboard Flow

Open **Settings → Connections → Relay**:

1. Pick a configured SSH host in `Relay center`. The selection is persisted independently of where development sessions run.
2. Click **Set up Relay**. Dashboard obtains trusted WSS, copies its bundled CLI to that host, starts the loopback `tw relay-server` in remote tmux session `tw-relay-server`, generates and saves a new Relay v1 token, and starts the Mac `relay-host`. A temporary tunnel, when needed, runs in remote session `tw-relay-tunnel`. Reconfiguration rotates the token and invalidates existing Android pairing.
3. Wait for **Mac connector connected**. The generated Relay URL is shown automatically and the QR appears at this point. This status proves only that the Mac connector reached the broker; it does not prove that a phone is online.
4. Scan the Relay v1 profile shown under **Android pairing**, review it on the trusted device, and confirm **Connect** in the app.

The Relay URL, Save, and Start connector controls remain available for an operator who supplies a fixed production WSS endpoint or needs to retry only the local connector. They are not required for the normal zero-to-pairing flow.

`Stop connector` stops the Mac connector and its Dashboard-managed local `tw serve`; it does not stop the broker on the selected Relay center.

The **Relay v1 profile** QR contains the current shared Relay v1 token, not a role-scoped Relay v2 capability. Scan it only on a trusted Android device. Its canonical payload is:

```text
tmuxworktree://pair?relayUrl=<percent-encoded-relay-url>&token=<percent-encoded-token>&hostId=<percent-encoded-host-id>
```

Scanning only prefills the Compose app's pairing review screen; Android does not save or connect until the user confirms. The `V2Activity` entry point names the second-generation Android UI, not the Relay protocol: this flow still uses Relay v1. Relay v2 pairing will be added separately after the broker/host capability issuer exists and must not reuse this shared secret as though it were a v2 token.

Dashboard never synthesizes a Mac mDNS or LAN Relay URL. An old `ws://<mac>.local` value remains invalid for connector startup and Android pairing; configure the trusted WSS endpoint instead.

## Android

Build the APK:

```bash
ANDROID_HOME=$HOME/Library/Android/sdk \
  ./mobile/android/gradlew -p mobile/android :app:assembleDebug
```

Install on an emulator or device:

```bash
$ANDROID_HOME/platform-tools/adb install -r \
  mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Pair from the Dashboard's Relay v1 QR. Dashboard does not place an adb command containing the shared Relay token on the clipboard. The `tmuxworktree://pair?...` payload is consumed only by the app's built-in QR scanner and opens a reviewable pairing screen. The custom scheme is intentionally not registered as a browsable Android deep link because another app could claim the same scheme and steal the Relay v1 token. Import only prefills this review; after the user explicitly confirms **Connect**, the saved profile enables normal reconnect behavior.

The Android QR flow requests camera permission when the user taps **Scan QR code**. Its CameraX UI and bundled ML Kit barcode model ship inside the APK, so opening the scanner does not wait for a Google Play services optional barcode UI/model download. A scanned or Intent-imported URL is validated on the review screen immediately; Release still requires `wss://`, and Debug permits `ws://` only for emulator/loopback hosts, never `.local` or another LAN host. External input only prefills review and cannot overwrite an existing profile or connect automatically.

After Android consumes a pairing Intent, it clears the URI data and sensitive extras, including the Relay v1 secret, from the activity Intent and compatibility-forwarding Intent. The secret is excluded from logs, crash/error text, Room, and DataStore; after explicit confirmation it is persisted only through Keystore-protected credential storage.

The authoritative Android `versionName` and `versionCode` live in `mobile/android/app/build.gradle.kts`. With the repository's current Gradle configuration, `:app:assembleRelease` produces an **unsigned build-verification artifact** only; versioning and signing are explicit release steps. The `V2Activity` class name does not imply an app 2.0 release or Relay v2 support.
