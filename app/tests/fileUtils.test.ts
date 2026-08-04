import assert from "node:assert/strict";
import test from "node:test";
import {
  detectEditorIndentation,
  getFileTypeBadge,
  getLanguageLabel,
  getLineEndingLabel,
} from "../src/fileUtils.ts";

test("editor metadata describes common source files", () => {
  assert.equal(getLanguageLabel("/repo/src/dashboard.tsx"), "TypeScript");
  assert.equal(getLanguageLabel("/repo/Cargo.toml"), "TOML");
  assert.equal(getLanguageLabel("/repo/Dockerfile"), "Dockerfile");
  assert.equal(getLanguageLabel("/repo/no-extension"), "Plain Text");
  assert.equal(getFileTypeBadge("/repo/src/dashboard.tsx"), "TSX");
  assert.equal(getFileTypeBadge("/repo/README.markdown"), "MD");
});

test("editor metadata preserves line endings and infers indentation", () => {
  assert.equal(getLineEndingLabel("one\r\ntwo\r\n"), "CRLF");
  assert.equal(getLineEndingLabel("one\ntwo\n"), "LF");
  assert.deepEqual(
    detectEditorIndentation("root\n  child\n    grandchild\n"),
    { kind: "spaces", size: 2 },
  );
  assert.deepEqual(
    detectEditorIndentation("root\n\tchild\n\t\tgrandchild\n"),
    { kind: "tabs", size: 4 },
  );
  assert.deepEqual(detectEditorIndentation("plain\ntext\n"), { kind: "spaces", size: 2 });
});
