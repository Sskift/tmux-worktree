import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const header = readFileSync(
  new URL("../src/dashboard/WorkspaceHeader.tsx", import.meta.url),
  "utf8",
);
const headerCss = readFileSync(
  new URL("../src/dashboard/WorkspaceHeader.css", import.meta.url),
  "utf8",
);

test("workspace header responds to its center track instead of the window", () => {
  assert.match(header, /workspace-header__layout/);
  assert.match(headerCss, /container-name:\s*workspace-header/);
  assert.match(headerCss, /container-type:\s*inline-size/);
  assert.match(
    headerCss,
    /@container workspace-header \(max-width: 820px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto auto/,
  );
  assert.doesNotMatch(headerCss, /@media \(max-width: 1279px\)/);
});

test("constrained headers preserve identity and primary actions while collapsing context copy", () => {
  assert.match(header, /className="workspace-header__chip-copy"/);
  assert.match(header, /title=\{`Host: \$\{hostLabel\}`\}/);
  assert.match(header, /title=\{`Agent command: \$\{agentCommand\}`\}/);
  assert.match(headerCss, /\.workspace-header__identity\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(
    headerCss,
    /\.workspace-header__actions\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-width:\s*max-content/,
  );
  assert.match(
    headerCss,
    /@container workspace-header \(max-width: 820px\)[\s\S]*?\.workspace-header__chip-copy\s*\{[\s\S]*?clip-path:\s*inset\(50%\)/,
  );
  assert.match(headerCss, /@container workspace-header \(max-width: 560px\)/);
  assert.match(header, />Scratch<\/span>/);
  assert.match(header, />Git<\/span>/);
  assert.doesNotMatch(header, />Inspector<\/span>/);
});
