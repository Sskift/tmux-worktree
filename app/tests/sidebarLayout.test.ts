import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
  SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
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
  const totalHeight = 260;
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
