import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

test("app dropdowns use MenuSelect instead of native select elements", () => {
  const srcDir = new URL("../src", import.meta.url).pathname;
  const offenders = tsxFiles(srcDir).filter((path) =>
    /<select[\s>]/.test(readFileSync(path, "utf8")),
  );

  assert.deepEqual(
    offenders.map((path) => path.replace(srcDir, "src")),
    [],
  );
});
