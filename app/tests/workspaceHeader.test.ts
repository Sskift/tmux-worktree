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

test("workspace header is a branded native titlebar with compact workspace context", () => {
  assert.match(header, /workspace-header__layout/);
  assert.match(header, /128x128\.png/);
  assert.match(header, />tmux-worktree<\/span>/);
  assert.match(header, /aria-label="Current workspace"/);
  assert.match(header, /className="workspace-header__status-dot"/);
  assert.match(header, /<h1>\{title\}<\/h1>/);
  assert.doesNotMatch(header, /agentCommand/);
  assert.doesNotMatch(header, /workspace-header__chip/);
  assert.match(
    headerCss,
    /grid-template-columns:\s*max-content minmax\(0, 1fr\) max-content/,
  );
  assert.match(
    headerCss,
    /\.workspace-header__brand img\s*\{[\s\S]*?width:\s*20px/,
  );
  assert.match(headerCss, /-webkit-app-region:\s*drag/);
  assert.match(headerCss, /-webkit-app-region:\s*no-drag/);
});

test("workspace header responds to its center track instead of the window", () => {
  assert.match(headerCss, /container-name:\s*workspace-header/);
  assert.match(headerCss, /container-type:\s*inline-size/);
  assert.match(
    headerCss,
    /@container workspace-header \(max-width: 820px\)[\s\S]*?\.workspace-header__host\s*\{[\s\S]*?display:\s*none/,
  );
  assert.doesNotMatch(headerCss, /@media \(max-width: 1279px\)/);
});

test("Files, Git, and Scratch are independent primary actions", () => {
  assert.match(
    header,
    /branch && <span className="workspace-header__detail">/,
  );
  assert.match(
    header,
    /className="workspace-header__detail workspace-header__host"/,
  );
  assert.match(
    headerCss,
    /\.workspace-header__actions\s*\{[\s\S]*?min-width:\s*max-content/,
  );
  assert.match(
    headerCss,
    /@container workspace-header \(max-width: 660px\)[\s\S]*?\.workspace-header__action span\s*\{[\s\S]*?display:\s*none/,
  );
  assert.match(headerCss, /@container workspace-header \(max-width: 500px\)/);
  assert.match(header, /aria-pressed=\{filesActive\}/);
  assert.match(header, /title=\{filesAvailable \? "Open file explorer"/);
  assert.match(header, />Files<\/span>/);
  assert.match(header, />Scratch<\/span>/);
  assert.match(header, />Git<\/span>/);
  assert.doesNotMatch(header, />Inspector<\/span>/);
});
