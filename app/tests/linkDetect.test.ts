import assert from "node:assert/strict";
import test from "node:test";
import { detectLinks, shouldActivateTerminalLink } from "../src/linkDetect.ts";

test("remote web links support direct click while file links keep a modifier", () => {
  const plain = { metaKey: false, ctrlKey: false };
  const meta = { metaKey: true, ctrlKey: false };
  const ctrl = { metaKey: false, ctrlKey: true };

  assert.equal(shouldActivateTerminalLink(plain, { kind: "url" }, true), true);
  assert.equal(shouldActivateTerminalLink(plain, { kind: "url" }, false), false);
  assert.equal(shouldActivateTerminalLink(plain, { kind: "file" }, true), false);
  assert.equal(shouldActivateTerminalLink(meta, { kind: "file" }, true), true);
  assert.equal(shouldActivateTerminalLink(ctrl, { kind: "url" }, false), true);
});

test("terminal link detection keeps URLs distinct from source paths", () => {
  assert.deepEqual(detectLinks("open https://example.com/a then src/main.ts:42:3"), [
    {
      kind: "url",
      text: "https://example.com/a",
      url: "https://example.com/a",
      startIndex: 5,
      endIndex: 26,
    },
    {
      kind: "file",
      text: "src/main.ts:42:3",
      path: "src/main.ts",
      line: 42,
      col: 3,
      startIndex: 32,
      endIndex: 48,
    },
  ]);
});
