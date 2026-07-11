import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("macOS bundle explains protected repository folder access", () => {
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as { bundle?: { macOS?: { infoPlist?: string } } };
  const plist = readFileSync(new URL("../src-tauri/Info.plist", import.meta.url), "utf8");

  assert.equal(config.bundle?.macOS?.infoPlist, "Info.plist");
  assert.match(plist, /NSDesktopFolderUsageDescription/);
  assert.match(plist, /NSDocumentsFolderUsageDescription/);
  assert.match(plist, /NSDownloadsFolderUsageDescription/);
});
