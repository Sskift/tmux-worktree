import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the Dashboard can destroy its window without receiving native close authority", () => {
  const capability = JSON.parse(
    readFileSync(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ) as { permissions?: unknown };

  assert.ok(Array.isArray(capability.permissions));
  assert.equal(
    capability.permissions.includes("core:window:allow-destroy"),
    true,
  );
  assert.equal(
    capability.permissions.includes("core:window:allow-close"),
    false,
  );
});
