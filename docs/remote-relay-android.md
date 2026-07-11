# Remote Relay And Android Client

## Model

The relay design has three roles:

- `relay-server` runs on an always-reachable broker. It only authenticates peers and forwards WebSocket messages.
- `relay-host` runs on the Mac that already acts as the Dashboard admin. It reads the same local Dashboard config and aggregates local plus configured SSH remote scopes.
- Android connects to the broker as a mobile Dashboard client paired with that Mac admin connector.

The Mac remains the business authority. It owns the Dashboard state, the `tw serve` terminal backend, and the SSH credentials used to inspect or attach to remote tmux sessions. The Relay v1 broker is still a trusted transport because it authenticates with the shared token and forwards terminal traffic in plaintext inside TLS. Running `relay-host` on a remote machine would make the phone see that remote machine's tmux namespace instead of the same admin view as the Mac Dashboard.

```text
Android app
  -> wss://relay.example.com/client
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

## Commands

Start a broker:

```bash
TW_RELAY_SECRET=<secret> tw relay-server --host 0.0.0.0 --port 8787
```

## Stable Broker On A Devbox

The broker should run on a machine that both the Mac and Android can reach. A devbox is a good fit because it can stay online while the Mac and phone reconnect.

Relay v1 uses one shared relay token for all three peers:

- `relay-server` on the devbox
- `relay-host` launched by the Mac Dashboard
- Android client

Install or update the CLI on the devbox, then start the broker in a long-lived service. If the devbox has user systemd:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/tw-relay-server.service <<'EOF'
[Unit]
Description=tmux-worktree relay broker

[Service]
Environment=TW_RELAY_SECRET=replace-with-a-long-random-token
ExecStart=%h/.npm-global/bin/tw relay-server --host 0.0.0.0 --port 8787
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
  'TW_RELAY_SECRET=replace-with-a-long-random-token tw relay-server --host 0.0.0.0 --port 8787'
```

Expose the broker through a stable URL. Prefer TLS and use the WebSocket URL in Dashboard and Android:

```text
wss://devbox.example.net
```

Production Android builds require `wss://`. Debug builds allow `ws://` only for emulator/loopback hosts such as `10.0.2.2`, `127.0.0.1`, or `localhost`; private-network cleartext URLs are intentionally rejected because they expose the shared Relay v1 token and terminal traffic.

If the devbox only accepts SSH and does not expose port `8787` directly, keep the broker on the devbox and forward it through the Mac:

```bash
ssh -fN -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8787:127.0.0.1:8787 devbox.example.net

ssh -fN -o ExitOnForwardFailure=yes \
  -L 0.0.0.0:8787:127.0.0.1:8787 devbox.example.net
```

The forward can still be useful for local relay-host testing, but production Android cannot pair to `ws://<mac-local-name>.local:8787`. Put TLS in front of the forwarded broker and configure its `wss://` URL before pairing.

Start local terminal serving on the Mac:

```bash
TW_TOKEN=<token> tw serve --port 8311
```

Start the Mac admin connector:

```bash
TW_RELAY_SECRET=<secret> TW_TOKEN=<token> tw relay-host \
  --relay wss://relay.example.com \
  --host-id mac-admin \
  --display-name "Mac Admin" \
  --local http://127.0.0.1:8311
```

Example config:

```json
{
  "worktreeBase": "~/worktrees",
  "mobileRelay": {
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

The Dashboard mobile relay menu can save the same `mobileRelay` block for you. Environment variables still override the config when present.

## Dashboard Flow

Open **Settings → Connections → Relay**:

1. Pick a configured SSH host in `Broker`.
2. Click `Start Broker`.
3. Dashboard copies its bundled CLI to that host, starts `tw relay-server` in a remote tmux session named `tw-relay-server`, generates a relay token, and saves `mobileRelay` in `~/.tmux-worktree.json`.
4. Dashboard starts the local Mac connector with the generated URL and token.
5. Use `Copy Android v1 launch` for an adb handoff, or scan the Relay v1 profile shown for an active saved `wss://` configuration.

The **Relay v1 profile** QR contains the current shared Relay v1 token, not a role-scoped Relay v2 capability. Scan it only on a trusted Android device. Its canonical payload is:

```text
tmuxworktree://pair?relayUrl=<percent-encoded-relay-url>&token=<percent-encoded-token>&hostId=<percent-encoded-host-id>
```

Scanning or launching only prefills the V2 review screen; Android does not save or connect until the user confirms. Relay v2 pairing will be added separately after the broker/host capability issuer exists and must not reuse this shared secret as though it were a v2 token.

When the broker is only reachable over SSH, Dashboard may initially suggest the Mac's mDNS address:

```text
ws://<mac-local-name>.local:8787
```

That cleartext URL is for local setup only. Before pairing a production Android build, put TLS in front of the broker and edit `Relay URL` to a trusted `wss://` address such as `wss://devbox.example.net`. An upgraded 1.x profile that still contains `ws://` is returned to the V2 pairing review instead of entering an endless reconnect loop.

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

Launch with a paired identity:

```bash
adb shell am start -n com.tmuxworktree.mobile/.V2Activity \
  --es relayUrl "'wss://relay.example.com'" \
  --es hostId "'mac-admin'" \
  --es relaySecret "'<secret>'"
```

The nested quoting is intentional because `adb shell` is parsed once on the desktop and again on Android; Dashboard's copied command escapes arbitrary configured values for both shells. The launch command opens a reviewable pairing screen, while the `tmuxworktree://pair?...` payload is consumed by the app's built-in QR scanner. The custom scheme is intentionally not registered as a browsable Android deep link because another app could claim the same scheme and steal the Relay v1 token. Neither path enables `autoConnect`.

The source currently keeps `versionName=1.0.3` aligned with the repository and uses the higher `versionCode=20000` for Android upgrade ordering. `:app:assembleRelease` produces an **unsigned build-verification artifact** only. This source merge does not start a 2.0 release or produce a production-distributable APK; version bumps and signing happen in the unified release process.
