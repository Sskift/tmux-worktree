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

  assert.match(gradle, /versionCode = 1208/);
  assert.match(gradle, /versionName = "0\.12\.8"/);
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
