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
  assert.match(source, /--app-height/);
});

test("Android package version matches current release line", () => {
  const gradle = readFileSync("mobile/android/app/build.gradle.kts", "utf8");

  assert.match(gradle, /versionCode = 1206/);
  assert.match(gradle, /versionName = "0\.12\.6"/);
});
