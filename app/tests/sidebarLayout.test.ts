import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
  SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
  SIDEBAR_GIT_MIN_HEIGHT,
  SIDEBAR_STABLE_LAYOUT_MIN_HEIGHT,
  SIDEBAR_TERMINALS_MIN_HEIGHT,
  SIDEBAR_WORKTREES_MIN_HEIGHT,
  isStableSidebarLayoutHeight,
  normalizeSidebarSplits,
  resizeWorktreeAutomationSplit,
} from "../src/sidebarLayout.ts";

test("automation can collapse to the terminal minimum height", () => {
  assert.equal(SIDEBAR_AUTOMATIONS_MIN_HEIGHT, SIDEBAR_TERMINALS_MIN_HEIGHT);
});

test("automation sidebar css min-height matches layout constraint", () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const match = css.match(/\.sidebar__section--automations\s*\{[^}]*min-height:\s*(\d+)px;/);

  assert.ok(match, "automation section min-height rule should be explicit");
  assert.equal(Number(match[1]), SIDEBAR_AUTOMATIONS_MIN_HEIGHT);
});

test("sidebar layout ignores transient tiny heights from window manager events", () => {
  assert.equal(isStableSidebarLayoutHeight(0), false);
  assert.equal(isStableSidebarLayoutHeight(SIDEBAR_STABLE_LAYOUT_MIN_HEIGHT - 1), false);
  assert.equal(isStableSidebarLayoutHeight(SIDEBAR_STABLE_LAYOUT_MIN_HEIGHT), true);
});

test("dashboard guards sidebar normalize and persistence against unstable heights", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /if \(!isStableSidebarLayoutHeight\(totalHeight\)\) return;/);
  assert.match(app, /if \(!isStableSidebarLayoutHeight\(sidebarHeight\)\) return;/);
});

test("worktree activity label shows status only with readable theme colors", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const nameRule = css.match(/\.session__name\s*\{[^}]*font-size:\s*(\d+)px;/);
  const metaRule = css.match(/\.session__meta\s*\{[^}]*font-size:\s*(\d+)px;/);
  const runningRule = css.match(/\.session__meta--activity-running\s*\{([^}]*)\}/);

  assert.ok(!app.includes("s.window_count"), "worktree row should not render tmux window count");
  assert.ok(nameRule, "session name font-size rule should be explicit");
  assert.ok(metaRule, "session meta font-size rule should be explicit");
  assert.equal(metaRule[1], nameRule[1], "status label should match worktree name size");
  assert.ok(runningRule, "running status color rule should be explicit");
  assert.match(runningRule[1], /color:\s*var\(--text\)/);
  assert.ok(!runningRule[1].includes("var(--ok)"), "running status should not use fixed semantic green");
});

test("worktree sidebar renders a single stable title span", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const sessionRule = css.match(/\n\.session\s*\{([^}]*)\}/);

  assert.ok(!app.includes("displayName.indexOf(\"-\")"), "worktree title should not split on '-'");
  assert.ok(!app.includes("session__tail\">{tail}"), "worktree title should not render a separate tail");
  assert.ok(sessionRule, "session grid rule should be explicit");
  assert.match(sessionRule[1], /grid-template-columns:\s*14px 16px minmax\(0,\s*1fr\) auto auto;/);
});

test("worktree sidebar groups sessions by project with collapsible headers", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

  assert.match(app, /function groupSessionsByProject\(sessions: Session\[\], hosts: HostConfig\[\]\): SessionGroup\[\]/);
  assert.match(app, /const \[collapsedProjects, setCollapsedProjects\]/);
  assert.match(app, /sessionGroups\.map\(\(group\) =>/);
  assert.match(app, /className="session-project__toggle"/);
  assert.match(css, /\.session-project__toggle\s*\{/);
  assert.match(css, /\.session-project \.session\s*\{/);
});

test("remote scratch terminals start on the selected host cwd", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const deck = readFileSync(new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url), "utf8");

  assert.match(app, /function buildSshShellArgs\(host: HostConfig, cwd: string\): string\[\]/);
  assert.match(deck, /function shellQuoteArg\(value: string\): string/);
  assert.match(app, /buildSshShellArgs\(scratchContext\.host, scratchContext\.cwd\)/);
  assert.match(app, /hostId=\{scratchContext\.host\?\.id \?\? null\}/);
  assert.match(app, /`cd \$\{shellQuoteArg\(cwd\)\} && exec "\\\$\{SHELL:-\/bin\/sh\}"`/);
  assert.doesNotMatch(app, /"sh",\s*"-c"/);
  assert.doesNotMatch(app, /"sh",\s*"-lc"/);
  assert.doesNotMatch(app, /exec "\$\{SHELL:-\/bin\/sh\}" -l/);
  assert.doesNotMatch(app, /if \(session\?\.hostId\) return homeDir \?\? "\/";/);
});

test("worktree project groups can persist collapsed state without breaking sort indices", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const sortable = readFileSync(new URL("../src/useSortable.ts", import.meta.url), "utf8");

  assert.match(app, /collapsedProjects/);
  assert.match(app, /session-project__toggle/);
  assert.match(app, /data-sort-index=\{i\}/);
  assert.ok(sortable.includes('querySelectorAll<HTMLElement>("[data-sort-index]")'));
});

test("normalizeSidebarSplits shrinks git to keep terminals visible after height shrinks", () => {
  const totalHeight = 360;
  const result = normalizeSidebarSplits({
    totalHeight,
    sectionSplit: 220,
    gitHeight: 220,
  });

  assert.equal(result.sectionSplit, 220);
  assert.equal(result.gitHeight, totalHeight - 220 - SIDEBAR_TERMINALS_MIN_HEIGHT);
  assert.equal(result.automationHeight, 0);
  assert.ok(result.gitHeight >= SIDEBAR_GIT_MIN_HEIGHT);
  assert.ok(result.sectionSplit + result.gitHeight + SIDEBAR_TERMINALS_MIN_HEIGHT <= totalHeight);
});

test("normalizeSidebarSplits reserves resizable automation space when present", () => {
  const totalHeight = 500;
  const result = normalizeSidebarSplits({
    totalHeight,
    sectionSplit: 200,
    gitHeight: 120,
    automationHeight: SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
  });

  assert.equal(result.sectionSplit, 200);
  assert.equal(result.automationHeight, SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT);
  assert.equal(result.gitHeight, 120);
  assert.equal(
    result.sectionSplit +
      result.automationHeight +
      result.gitHeight +
      SIDEBAR_TERMINALS_MIN_HEIGHT,
    492,
  );
});

test("normalizeSidebarSplits clamps automation height before terminals disappear", () => {
  const totalHeight = 200;
  const result = normalizeSidebarSplits({
    totalHeight,
    sectionSplit: 80,
    gitHeight: 120,
    automationHeight: 160,
  });

  assert.equal(result.sectionSplit, SIDEBAR_WORKTREES_MIN_HEIGHT);
  assert.equal(result.automationHeight, SIDEBAR_AUTOMATIONS_MIN_HEIGHT);
  assert.ok(result.sectionSplit >= SIDEBAR_WORKTREES_MIN_HEIGHT);
  assert.ok(result.gitHeight >= SIDEBAR_GIT_MIN_HEIGHT);
  assert.equal(
    result.sectionSplit +
      result.automationHeight +
      result.gitHeight +
      SIDEBAR_TERMINALS_MIN_HEIGHT,
    totalHeight,
  );
});

test("normalizeSidebarSplits shrinks worktrees when git minimum would crowd terminals", () => {
  const totalHeight = 180;
  const result = normalizeSidebarSplits({
    totalHeight,
    sectionSplit: 120,
    gitHeight: 100,
  });

  assert.equal(result.gitHeight, SIDEBAR_GIT_MIN_HEIGHT);
  assert.equal(result.sectionSplit, totalHeight - SIDEBAR_GIT_MIN_HEIGHT - SIDEBAR_TERMINALS_MIN_HEIGHT);
  assert.ok(result.sectionSplit >= SIDEBAR_WORKTREES_MIN_HEIGHT);
});

test("resizeWorktreeAutomationSplit preserves the terminals boundary", () => {
  const result = resizeWorktreeAutomationSplit({
    sectionSplit: 200,
    automationHeight: 132,
    deltaY: 30,
  });

  assert.equal(result.sectionSplit, 230);
  assert.equal(result.automationHeight, 102);
  assert.equal(result.sectionSplit + result.automationHeight, 332);
});

test("resizeWorktreeAutomationSplit clamps automation at its minimum height", () => {
  const result = resizeWorktreeAutomationSplit({
    sectionSplit: 200,
    automationHeight: 132,
    deltaY: 400,
  });

  assert.equal(result.automationHeight, SIDEBAR_AUTOMATIONS_MIN_HEIGHT);
  assert.equal(result.sectionSplit + result.automationHeight, 332);
});
