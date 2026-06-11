import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDEBAR_AUTOMATIONS_HEIGHT,
  SIDEBAR_GIT_MIN_HEIGHT,
  SIDEBAR_TERMINALS_MIN_HEIGHT,
  SIDEBAR_WORKTREES_MIN_HEIGHT,
  normalizeSidebarSplits,
} from "../src/sidebarLayout.ts";

test("normalizeSidebarSplits shrinks git to keep terminals visible after height shrinks", () => {
  const totalHeight = 360;
  const result = normalizeSidebarSplits({
    totalHeight,
    sectionSplit: 220,
    gitHeight: 220,
  });

  assert.equal(result.sectionSplit, 220);
  assert.equal(result.gitHeight, totalHeight - 220 - SIDEBAR_TERMINALS_MIN_HEIGHT);
  assert.ok(result.gitHeight >= SIDEBAR_GIT_MIN_HEIGHT);
  assert.ok(result.sectionSplit + result.gitHeight + SIDEBAR_TERMINALS_MIN_HEIGHT <= totalHeight);
});

test("normalizeSidebarSplits reserves automation space when present", () => {
  const totalHeight = 420;
  const result = normalizeSidebarSplits({
    totalHeight,
    sectionSplit: 260,
    gitHeight: 200,
    automationHeight: SIDEBAR_AUTOMATIONS_HEIGHT,
  });

  assert.equal(
    result.sectionSplit + result.gitHeight + SIDEBAR_TERMINALS_MIN_HEIGHT + SIDEBAR_AUTOMATIONS_HEIGHT,
    totalHeight,
  );
  assert.ok(result.sectionSplit >= SIDEBAR_WORKTREES_MIN_HEIGHT);
  assert.ok(result.gitHeight >= SIDEBAR_GIT_MIN_HEIGHT);
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
