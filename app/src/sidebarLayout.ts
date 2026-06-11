export const SIDEBAR_WORKTREES_MIN_HEIGHT = 40;
export const SIDEBAR_TERMINALS_MIN_HEIGHT = 40;
export const SIDEBAR_GIT_MIN_HEIGHT = 80;
export const SIDEBAR_AUTOMATIONS_HEIGHT = 132;

type SidebarSplits = {
  totalHeight: number;
  sectionSplit: number;
  gitHeight: number;
  automationHeight?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeSidebarSplits({
  totalHeight,
  sectionSplit,
  gitHeight,
  automationHeight = 0,
}: SidebarSplits): Omit<SidebarSplits, "totalHeight" | "automationHeight"> {
  const total = Math.max(0, finiteOr(totalHeight, 0));
  const automation = Math.max(0, finiteOr(automationHeight, 0));
  const minimumTotal =
    SIDEBAR_WORKTREES_MIN_HEIGHT +
    SIDEBAR_TERMINALS_MIN_HEIGHT +
    SIDEBAR_GIT_MIN_HEIGHT +
    automation;

  if (total <= minimumTotal) {
    return {
      sectionSplit: Math.max(
        0,
        total - SIDEBAR_GIT_MIN_HEIGHT - SIDEBAR_TERMINALS_MIN_HEIGHT - automation,
      ),
      gitHeight: SIDEBAR_GIT_MIN_HEIGHT,
    };
  }

  const maxSection =
    total - SIDEBAR_GIT_MIN_HEIGHT - SIDEBAR_TERMINALS_MIN_HEIGHT - automation;
  const nextSection = clamp(
    finiteOr(sectionSplit, SIDEBAR_WORKTREES_MIN_HEIGHT),
    SIDEBAR_WORKTREES_MIN_HEIGHT,
    maxSection,
  );
  const maxGit = total - nextSection - SIDEBAR_TERMINALS_MIN_HEIGHT - automation;
  const nextGit = clamp(
    finiteOr(gitHeight, SIDEBAR_GIT_MIN_HEIGHT),
    SIDEBAR_GIT_MIN_HEIGHT,
    maxGit,
  );

  return {
    sectionSplit: nextSection,
    gitHeight: nextGit,
  };
}
