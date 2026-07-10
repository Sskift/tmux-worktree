import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inspector = readFileSync(
  new URL("../src/dashboard/Inspector.tsx", import.meta.url),
  "utf8",
);
const inspectorCss = readFileSync(
  new URL("../src/dashboard/Inspector.css", import.meta.url),
  "utf8",
);

test("Inspector is a focused Git panel", () => {
  assert.match(inspector, /aria-label="Git"/);
  assert.match(inspector, /<GitBranch/);
  assert.match(inspector, /<span>Git<\/span>/);
  assert.match(inspector, /content: ReactNode/);
  assert.match(inspector, /workspace-inspector__panel">\{content\}/);
  assert.match(inspector, /aria-label="Close Git panel"/);

  assert.doesNotMatch(inspector, /activeTab|onTabChange|onExpand|badges/);
  assert.doesNotMatch(inspector, /role="tab"|role="tablist"|Maximize2/);
  assert.match(
    inspectorCss,
    /grid-template-rows:\s*46px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(inspectorCss, /workspace-inspector__tabs/);
});
