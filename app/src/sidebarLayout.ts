export const SIDEBAR_WORKTREES_MIN_HEIGHT = 40;
export const SIDEBAR_TERMINALS_MIN_HEIGHT = 40;
export const SIDEBAR_GIT_MIN_HEIGHT = 80;
export const SIDEBAR_AUTOMATIONS_MIN_HEIGHT = 72;
export const SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT = 132;

type SidebarSplits = {
  totalHeight: number;
  sectionSplit: number;
  gitHeight: number;
  automationHeight?: number;
};

type NormalizedSidebarSplits = {
  sectionSplit: number;
  automationHeight: number;
  gitHeight: number;
};

type WorktreeAutomationSplit = {
  sectionSplit: number;
  automationHeight: number;
};

type ResizeWorktreeAutomationSplitArgs = WorktreeAutomationSplit & {
  deltaY: number;
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
}: SidebarSplits): NormalizedSidebarSplits {
  const total = Math.max(0, finiteOr(totalHeight, 0));
  const requestedAutomation = Math.max(0, finiteOr(automationHeight, 0));
  if (requestedAutomation <= 0) {
    const minimumTotal =
      SIDEBAR_WORKTREES_MIN_HEIGHT +
      SIDEBAR_TERMINALS_MIN_HEIGHT +
      SIDEBAR_GIT_MIN_HEIGHT;

    if (total <= minimumTotal) {
      return {
        sectionSplit: Math.max(
          0,
          total - SIDEBAR_GIT_MIN_HEIGHT - SIDEBAR_TERMINALS_MIN_HEIGHT,
        ),
        automationHeight: 0,
        gitHeight: SIDEBAR_GIT_MIN_HEIGHT,
      };
    }

    const maxSection =
      total - SIDEBAR_GIT_MIN_HEIGHT - SIDEBAR_TERMINALS_MIN_HEIGHT;
    const nextSection = clamp(
      finiteOr(sectionSplit, SIDEBAR_WORKTREES_MIN_HEIGHT),
      SIDEBAR_WORKTREES_MIN_HEIGHT,
      maxSection,
    );
    const maxGit = total - nextSection - SIDEBAR_TERMINALS_MIN_HEIGHT;
    const nextGit = clamp(
      finiteOr(gitHeight, SIDEBAR_GIT_MIN_HEIGHT),
      SIDEBAR_GIT_MIN_HEIGHT,
      maxGit,
    );

    return {
      sectionSplit: nextSection,
      automationHeight: 0,
      gitHeight: nextGit,
    };
  }

  const automationMin = requestedAutomation > 0 ? SIDEBAR_AUTOMATIONS_MIN_HEIGHT : 0;
  const minimumTotal =
    SIDEBAR_WORKTREES_MIN_HEIGHT +
    SIDEBAR_TERMINALS_MIN_HEIGHT +
    SIDEBAR_GIT_MIN_HEIGHT +
    automationMin;

  if (total <= minimumTotal) {
    const nextGit = Math.min(SIDEBAR_GIT_MIN_HEIGHT, total);
    const afterGit = Math.max(0, total - nextGit);
    const terminalSpace = Math.min(SIDEBAR_TERMINALS_MIN_HEIGHT, afterGit);
    const listSpace = Math.max(0, afterGit - terminalSpace);
    const nextAutomation = Math.min(automationMin, listSpace);
    return {
      sectionSplit: Math.max(0, listSpace - nextAutomation),
      automationHeight: nextAutomation,
      gitHeight: nextGit,
    };
  }

  const maxGit =
    total - SIDEBAR_WORKTREES_MIN_HEIGHT - automationMin - SIDEBAR_TERMINALS_MIN_HEIGHT;
  const nextGit = clamp(
    finiteOr(gitHeight, SIDEBAR_GIT_MIN_HEIGHT),
    SIDEBAR_GIT_MIN_HEIGHT,
    maxGit,
  );
  const listTotal = total - nextGit;
  const maxAutomation =
    listTotal - SIDEBAR_WORKTREES_MIN_HEIGHT - SIDEBAR_TERMINALS_MIN_HEIGHT;
  const nextAutomation =
    requestedAutomation > 0
      ? clamp(requestedAutomation, automationMin, maxAutomation)
      : 0;
  const maxSection = listTotal - nextAutomation - SIDEBAR_TERMINALS_MIN_HEIGHT;
  const nextSection = clamp(
    finiteOr(sectionSplit, SIDEBAR_WORKTREES_MIN_HEIGHT),
    SIDEBAR_WORKTREES_MIN_HEIGHT,
    maxSection,
  );

  return {
    sectionSplit: nextSection,
    automationHeight: nextAutomation,
    gitHeight: nextGit,
  };
}

export function resizeWorktreeAutomationSplit({
  sectionSplit,
  automationHeight,
  deltaY,
}: ResizeWorktreeAutomationSplitArgs): WorktreeAutomationSplit {
  const total = Math.max(0, finiteOr(sectionSplit, 0) + finiteOr(automationHeight, 0));
  const maxSection = Math.max(
    SIDEBAR_WORKTREES_MIN_HEIGHT,
    total - SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
  );
  const nextSection = clamp(
    finiteOr(sectionSplit, SIDEBAR_WORKTREES_MIN_HEIGHT) + finiteOr(deltaY, 0),
    SIDEBAR_WORKTREES_MIN_HEIGHT,
    maxSection,
  );

  return {
    sectionSplit: nextSection,
    automationHeight: Math.max(0, total - nextSection),
  };
}
