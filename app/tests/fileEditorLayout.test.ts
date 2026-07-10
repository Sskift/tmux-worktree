import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("../src/FileEditor.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

test("file editor marks every preview root and body with bounded layout classes", () => {
  assert.equal(editor.match(/pane pane--term file-editor/g)?.length, 2);
  assert.equal(editor.match(/pane__body file-editor__body/g)?.length, 2);
  assert.doesNotMatch(editor, /pane__body" style=\{\{ padding: 0 \}\}/);
});

test("file editor and CodeMirror can shrink and fill their available pane", () => {
  assert.match(css, /\.file-editor\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.file-editor__body\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.file-editor__cm\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;/);
  assert.match(css, /\.file-editor__cm \.cm-editor\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.file-editor__cm \.cm-scroller\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/);
});
