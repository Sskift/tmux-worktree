import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("../src/FileEditor.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/FileEditor.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../src/editorTheme.ts", import.meta.url), "utf8");

test("file editor marks every preview root and body with bounded layout classes", () => {
  assert.equal(editor.match(/pane pane--term file-editor/g)?.length, 2);
  assert.equal(editor.match(/pane__body file-editor__body/g)?.length, 2);
  assert.doesNotMatch(editor, /pane__body" style=\{\{ padding: 0 \}\}/);
});

test("file editor and CodeMirror can shrink and fill their available pane", () => {
  assert.match(css, /\.file-editor\.file-editor\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.file-editor \.file-editor__body\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.file-editor \.file-editor__cm\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;/);
  assert.match(css, /\.file-editor \.file-editor__cm \.cm-editor\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.file-editor \.file-editor__cm \.cm-scroller\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/);
});

test("file editor exposes one real file tab, breadcrumbs, tools, and a compact status bar", () => {
  assert.match(editor, /className="file-editor__tab-row" role="tablist" aria-label="Open files"/);
  assert.match(editor, /className="file-editor__tab"[\s\S]*?role="tab"[\s\S]*?aria-selected="true"[\s\S]*?aria-controls="file-editor-active-panel"[\s\S]*?tabIndex=\{0\}/);
  assert.match(editor, /role="tabpanel"[\s\S]*?aria-labelledby="file-editor-active-tab"/);
  assert.match(editor, /<\/div>\s*<button\s+className="file-editor__tab-close"/);
  assert.match(editor, /aria-label="File path"/);
  assert.match(editor, /openSearchPanel\(view\)/);
  assert.match(editor, /gotoLine\(view\)/);
  assert.match(editor, /wrapCompartmentRef\.current\.reconfigure/);
  assert.match(editor, /Ln \{cursor\.line\}, Col \{cursor\.column\}/);
  assert.match(editor, /<span className="file-editor__status-secondary">UTF-8<\/span>/);
  assert.match(editor, /hostId \? "Remote" : "Local"/);
  assert.doesNotMatch(editor, /oneDark/);
});

test("editor theme covers the important CodeMirror editing states", () => {
  assert.match(theme, /EditorView\.theme/);
  assert.match(theme, /HighlightStyle\.define/);
  assert.match(theme, /scope\?\.closest\("\.tw-shell"\)/);
  assert.doesNotMatch(theme, /getComputedStyle\(document\.documentElement\)/);
  for (const selector of [
    ".cm-activeLine",
    ".cm-activeLineGutter",
    ".cm-foldGutter",
    ".cm-matchingBracket",
    ".cm-selectionBackground",
    ".cm-searchMatch",
    ".cm-tooltip",
    ".cm-indent-guide",
  ]) {
    assert.ok(theme.includes(selector), `missing ${selector} theme`);
  }
});

test("saving and runtime styling use transactions instead of rebuilding CodeMirror", () => {
  assert.match(editor, /savingRequestRef\.current\?\.sourceKey === sourceKey/);
  assert.match(editor, /themeCompartmentRef\.current\.reconfigure/);
  assert.match(editor, /THEME_CHANGED_EVENT/);
  assert.match(editor, /saveRef\.current\(\)/);
  assert.match(editor, /initialLine\?: number/);
  assert.match(editor, /initialColumn\?: number/);
  assert.match(editor, /navigationRevision\?: number/);
  assert.match(editor, /navigationRevision, sourceKey/);
  assert.match(editor, /EditorView\.scrollIntoView/);
  assert.doesNotMatch(
    editor,
    /\[dashboardBackend, effectiveLoading, filePath, initialColumn, initialLine, loadError/,
  );
});
