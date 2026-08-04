export const SETTINGS_SECTION_IDS = [
  "general",
  "appearance",
  "connections",
  "integrations",
  "agents",
  "history",
  "automation",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTION_IDS.includes(value as SettingsSectionId);
}
