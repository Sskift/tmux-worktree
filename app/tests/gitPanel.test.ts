import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitPanel = readFileSync(
  new URL("../src/dashboard/GitPanel.tsx", import.meta.url),
  "utf8",
);
const gitPanelCss = readFileSync(
  new URL("../src/dashboard/GitPanel.css", import.meta.url),
  "utf8",
);

test("GitPanel is a focused Git panel", () => {
  assert.match(gitPanel, /aria-label="Git"/);
  assert.match(gitPanel, /<GitBranch/);
  assert.match(gitPanel, /<span>Git<\/span>/);
  assert.match(gitPanel, /content: ReactNode/);
  assert.match(gitPanel, /workspace-git-panel__panel">\{content\}/);
  assert.match(gitPanel, /aria-label="Close Git panel"/);

  assert.doesNotMatch(gitPanel, /activeTab|onTabChange|onExpand|badges/);
  assert.doesNotMatch(gitPanel, /role="tab"|role="tablist"|Maximize2/);
  assert.match(
    gitPanelCss,
    /grid-template-rows:\s*46px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(gitPanelCss, /workspace-git-panel__tabs/);
});
