# Remote Relay And Android Client

## Model

The relay design has three roles:

- `relay-server` runs on an always-reachable broker. It only authenticates peers and forwards WebSocket messages.
- `relay-host` runs on the Mac that already acts as the Dashboard admin. It reads the same local Dashboard config and aggregates local plus configured SSH remote scopes.
- Android connects to the broker as a mobile Dashboard client paired with that Mac admin connector.

The Mac remains the trust boundary. It owns the Dashboard state, the `tw serve` terminal backend, and the SSH credentials used to inspect or attach to remote tmux sessions. Running `relay-host` on a remote machine would make the phone see that remote machine's tmux namespace instead of the same admin view as the Mac Dashboard.

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
  "hosts": [
    { "id": "remote-a", "label": "remote-a", "host": "remote-a" },
    { "id": "remote-b", "label": "remote-b", "host": "remote-b" }
  ]
}
```

## Android

Build the APK:

```bash
ANDROID_HOME=$HOME/Library/Android/sdk \
  gradle -p mobile/android :app:assembleDebug
```

Install on an emulator or device:

```bash
$ANDROID_HOME/platform-tools/adb install -r \
  mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Launch with a paired identity:

```bash
adb shell "am start -n com.tmuxworktree.mobile/.MainActivity \
  --es relayUrl 'wss://relay.example.com' \
  --es hostId 'mac-admin' \
  --es relaySecret '<secret>' \
  --ez autoConnect true"
```
