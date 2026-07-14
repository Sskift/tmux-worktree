import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

test("only the Tauri transport imports Tauri packages", () => {
  const sourceRoot = resolve(new URL("../src", import.meta.url).pathname);
  const allowed = "platform/tauriBackend.ts";
  const offenders = sourceFiles(sourceRoot)
    .filter((path) => /["']@tauri-apps\//.test(readFileSync(path, "utf8")))
    .map((path) => relative(sourceRoot, path))
    .filter((path) => path !== allowed)
    .sort();

  assert.deepEqual(offenders, []);
});
