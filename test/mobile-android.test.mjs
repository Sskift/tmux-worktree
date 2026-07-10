import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Android terminal refits after keyboard viewport changes", () => {
  const source = readFileSync("mobile/android/app/src/main/java/com/tmuxworktree/mobile/MainActivity.java", "utf8");

  assert.match(source, /installViewportChangeWatcher\(root\)/);
  assert.match(source, /addOnGlobalLayoutListener/);
  assert.match(source, /requestTerminalFitBurst/);
  assert.match(source, /window\.visualViewport/);
  assert.match(source, /visualViewport\.addEventListener\('resize',fitBurst\)/);
  assert.match(source, /new ResizeObserver\(fitBurst\)/);
  assert.match(source, /term\.cols&&term\.rows&&\(term\.cols!==lastCols\|\|term\.rows!==lastRows\)/);
  assert.match(source, /html,body,#terminal\{margin:0;width:100%;height:100%;/);
  assert.doesNotMatch(source, /--app-height/);
  assert.doesNotMatch(source, /visualViewport\.height/);
});

test("Android package version matches current release line", () => {
  const gradle = readFileSync("mobile/android/app/build.gradle.kts", "utf8");

  assert.match(gradle, /versionCode = 10002/);
  assert.match(gradle, /versionName = "1\.0\.2"/);
});

test("Android worktree list groups sessions by project", () => {
  const source = readFileSync("mobile/android/app/src/main/java/com/tmuxworktree/mobile/MainActivity.java", "utf8");

  assert.match(source, /import java\.util\.LinkedHashMap;/);
  assert.match(source, /item\.optString\("project"\)/);
  assert.match(source, /final String project;/);
  assert.match(source, /worktreeGroupKey\(RelaySession session\)/);
  assert.match(source, /sessionProject\(RelaySession session\)/);
  assert.match(source, /\/\.tmux-worktree\/worktrees\//);
});

test("Android connection profile can be edited and cleared after auto reconnect", () => {
  const source = readFileSync("mobile/android/app/src/main/java/com/tmuxworktree/mobile/MainActivity.java", "utf8");

  assert.match(source, /installIdentityEditStopper\(relayInput\)/);
  assert.match(source, /installIdentityEditStopper\(tokenInput\)/);
  assert.match(source, /identityToggleButton/);
  assert.match(source, /setIdentityExpanded\(!identityExpanded\)/);
  assert.match(source, /setIdentityExpanded\(false\)/);
  assert.match(source, /identityCard\.setVisibility\(identityExpanded \? View\.VISIBLE : View\.GONE\)/);
  assert.match(source, /stopReconnectForIdentityEdit\(\)/);
  assert.match(source, /clearSavedIdentity\(\)/);
  assert.match(source, /\.remove\("relayUrl"\)/);
  assert.match(source, /\.remove\("relaySecret"\)/);
  assert.match(source, /\.remove\("hostId"\)/);
  assert.match(source, /putBoolean\("autoConnect", false\)/);
  assert.match(source, /setStatusUi\("Relay and token required", WARNING\)/);
  assert.match(source, /setStatusUi\("Invalid relay URL", ERROR_C\)/);
  assert.doesNotMatch(source, /identityCard\.setVisibility\(View\.GONE\)/);
});

test("Android terminal stream errors reopen the active session", () => {
  const source = readFileSync("mobile/android/app/src/main/java/com/tmuxworktree/mobile/MainActivity.java", "utf8");

  assert.match(source, /private boolean openTerminalStream\(boolean resetDisplay\)/);
  assert.match(source, /private void scheduleTerminalStreamReopen\(String reason\)/);
  assert.match(source, /terminalStreamReopenScheduled/);
  assert.match(source, /activeStreamId = UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(source, /isRecoverableTerminalStreamError\(error\)/);
  assert.match(source, /normalized\.contains\("terminal stream is not open"\)/);
  assert.match(source, /scheduleTerminalStreamReopen\("Reopening terminal stream"\)/);
  assert.match(source, /if \(activeStreamId == null\) \{\s*if \(!openTerminalStream\(false\) \|\| activeStreamId == null\) return;\s*\}/s);
});

test("mobile relay failures stay visible on Android and in the Dashboard", () => {
  const android = readFileSync("mobile/android/app/src/main/java/com/tmuxworktree/mobile/MainActivity.java", "utf8");
  const dashboard = readFileSync("app/src/App.tsx", "utf8");
  const backend = readFileSync("app/src-tauri/src/lib.rs", "utf8");

  assert.match(android, /if \(reconnectAttempt >= 3\) \{\s*setIdentityExpanded\(true\);\s*\}/s);
  assert.match(dashboard, /setInterval\(refresh, 2000\)/);
  assert.match(dashboard, /mobileRelayConnected\s*\? "Connected"/);
  assert.match(backend, /connection_state: String/);
  assert.match(backend, /load_mobile_relay_runtime_status/);
  assert.match(backend, /status\.relay_url == resolved_relay_url && status\.host_id == resolved_host_id/);
});

test("Android terminal supports touch scrolling through xterm scrollback", () => {
  const source = readFileSync("mobile/android/app/src/main/java/com/tmuxworktree/mobile/MainActivity.java", "utf8");

  assert.match(source, /scrollback:5000/);
  assert.match(source, /function installTouchScroll\(\)/);
  assert.match(source, /touchstart/);
  assert.match(source, /touchmove/);
  assert.match(source, /passive:false,capture:true/);
  assert.match(source, /e\.preventDefault\(\)/);
  assert.match(source, /term\.scrollLines\(-whole\)/);
  assert.match(source, /installTouchScroll\(\);/);
});

test("Android app declares a launcher icon", () => {
  const manifest = readFileSync("mobile/android/app/src/main/AndroidManifest.xml", "utf8");
  const foreground = readFileSync("mobile/android/app/src/main/res/drawable/ic_launcher_foreground.xml", "utf8");
  const adaptive = readFileSync("mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", "utf8");

  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(foreground, /<vector /);
  assert.match(adaptive, /<adaptive-icon/);
  assert.match(adaptive, /@drawable\/ic_launcher_foreground/);
});
