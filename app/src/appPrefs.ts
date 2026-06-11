const LAST_AI_CMD_KEY = "tw-dashboard:last-ai-cmd";

export function loadLastAiCmd(): string {
  try {
    return localStorage.getItem(LAST_AI_CMD_KEY)?.trim() || "claude";
  } catch {
    return "claude";
  }
}

export function saveLastAiCmd(cmd: string): void {
  try {
    const trimmed = cmd.trim();
    if (trimmed) localStorage.setItem(LAST_AI_CMD_KEY, trimmed);
  } catch {
    /* ignore quota/availability errors */
  }
}
