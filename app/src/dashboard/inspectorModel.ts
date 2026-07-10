export const INSPECTOR_TABS = [
  "files",
  "git",
  "diff",
  "automation",
  "feishu",
] as const;

export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export function moveInspectorTab(
  current: InspectorTab,
  direction: -1 | 1,
): InspectorTab {
  const index = INSPECTOR_TABS.indexOf(current);
  return INSPECTOR_TABS[
    (index + direction + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
  ];
}
