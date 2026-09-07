import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dirs = [];

// Create a tracked temp directory. All tracked directories are removed
// recursively after the importing file's tests finish, so per-test mkdtemp
// calls do not leak into the host's temp directory.
export function tmpDir(tag = "tw-test-") {
  const dir = mkdtempSync(join(tmpdir(), tag));
  dirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
