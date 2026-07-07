export type AutomationStatus = "idle" | "queued" | "running" | "success" | "failed" | "skipped";
export type AutomationTriggerType = "manual" | "schedule";
export type AutomationOverlap = "queue" | "skip";
export type AutomationScheduleKind =
  | "manual"
  | "every-5-minutes"
  | "every-15-minutes"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export type ParsedAutomationSchedule = {
  kind: AutomationScheduleKind;
  hour: number;
  minute: number;
  custom: string;
};

export type Automation = {
  id: string;
  name: string;
  instruction: string;
  aiCmd: string;
  project: string;
  path: string;
  schedule: string;
  allowOverlap: boolean;
  active: boolean;
  status?: AutomationStatus;
  lastRunAt?: string;
  lastSession?: string;
};

export type AutomationRecord = {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: AutomationTriggerType;
  schedule?: string | null;
  timezone?: string | null;
  project?: string | null;
  path?: string | null;
  aiCmd: string;
  instruction: string;
  overlap: AutomationOverlap;
  lastRunAt?: string | null;
  lastStatus: AutomationStatus;
  lastSession?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SaveAutomationInput = {
  id?: string;
  name: string;
  enabled: boolean;
  triggerType: AutomationTriggerType;
  schedule: string | null;
  timezone: string | null;
  project: string | null;
  path: string | null;
  aiCmd: string;
  instruction: string;
  overlap: AutomationOverlap;
};

export type AutomationDraft = {
  name: string;
  instruction: string;
  aiCmd: string;
  project: string;
  path: string;
  schedule: string;
  allowOverlap: boolean;
  active: boolean;
};

export type AutomationRunStatus = "queued" | "running" | "success" | "failed" | "skipped";

export type AutomationRun = {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  target: string;
  sessionName?: string | null;
  message?: string | null;
};

export type AutomationRunRecord = {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  sessionName?: string | null;
  error?: string | null;
};

export type DraftValidation = {
  valid: boolean;
  errors: Partial<Record<"name" | "instruction" | "target" | "aiCmd", string>>;
};

export function triggerLabel(value: Pick<AutomationDraft, "schedule"> | Pick<Automation, "schedule">): string {
  const label = automationScheduleLabel(value.schedule);
  return label === "manual" ? label : `schedule · ${label}`;
}

export function automationStatusLabel(value: Pick<AutomationDraft, "active"> | Pick<Automation, "active">): string {
  return value.active ? "active" : "paused";
}

export function createAutomationDraft(automation?: Automation): AutomationDraft {
  return {
    name: automation?.name ?? "",
    instruction: automation?.instruction ?? "",
    aiCmd: automation?.aiCmd ?? "claude",
    project: automation?.project ?? "",
    path: automation?.path ?? "",
    schedule: automation?.schedule ?? "",
    allowOverlap: automation?.allowOverlap ?? false,
    active: automation?.active ?? true,
  };
}

const DEFAULT_SCHEDULE_HOUR = 9;
const DEFAULT_SCHEDULE_MINUTE = 0;

function cronNumber(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function isValidClock(hour: number | null, minute: number | null): boolean {
  return hour != null && minute != null && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function normalizeSchedule(schedule: string): string {
  return schedule
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:0)\/(\d+) /, "*/$1 ");
}

function clampClockPart(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function formatAutomationClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseAutomationClockTime(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return isValidClock(hour, minute) ? { hour, minute } : null;
}

export function parseAutomationSchedule(schedule: string): ParsedAutomationSchedule {
  const trimmed = schedule.trim();
  const custom = trimmed || "0 9 * * *";
  const normalized = normalizeSchedule(trimmed);
  if (!trimmed) {
    return {
      kind: "manual",
      hour: DEFAULT_SCHEDULE_HOUR,
      minute: DEFAULT_SCHEDULE_MINUTE,
      custom,
    };
  }
  if (normalized === "*/5 * * * *") {
    return {
      kind: "every-5-minutes",
      hour: DEFAULT_SCHEDULE_HOUR,
      minute: DEFAULT_SCHEDULE_MINUTE,
      custom,
    };
  }
  if (normalized === "*/15 * * * *") {
    return {
      kind: "every-15-minutes",
      hour: DEFAULT_SCHEDULE_HOUR,
      minute: DEFAULT_SCHEDULE_MINUTE,
      custom,
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      kind: "custom",
      hour: DEFAULT_SCHEDULE_HOUR,
      minute: DEFAULT_SCHEDULE_MINUTE,
      custom,
    };
  }

  const [minutePart, hourPart, dayOfMonth, month, dayOfWeek] = parts;
  const minute = cronNumber(minutePart);
  const hour = cronNumber(hourPart);

  if (minute != null && hourPart === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return { kind: "hourly", hour: DEFAULT_SCHEDULE_HOUR, minute, custom };
  }
  if (
    hour == null ||
    minute == null ||
    !isValidClock(hour, minute) ||
    dayOfMonth !== "*" ||
    month !== "*"
  ) {
    return {
      kind: "custom",
      hour: DEFAULT_SCHEDULE_HOUR,
      minute: DEFAULT_SCHEDULE_MINUTE,
      custom,
    };
  }
  if (dayOfWeek === "*") return { kind: "daily", hour, minute, custom };
  if (dayOfWeek === "1-5" || dayOfWeek === "1,2,3,4,5") {
    return { kind: "weekdays", hour, minute, custom };
  }
  if (/^[0-7]$/.test(dayOfWeek)) return { kind: "weekly", hour, minute, custom };
  return { kind: "custom", hour, minute, custom };
}

export function buildAutomationSchedule(
  kind: AutomationScheduleKind,
  hour: number,
  minute: number,
  custom = "",
): string {
  if (kind === "manual") return "";
  if (kind === "custom") return custom.trim();
  if (kind === "every-5-minutes") return "*/5 * * * *";
  if (kind === "every-15-minutes") return "*/15 * * * *";
  if (kind === "hourly") return "0 * * * *";

  const safeHour = clampClockPart(hour, 0, 23, DEFAULT_SCHEDULE_HOUR);
  const safeMinute = clampClockPart(minute, 0, 59, DEFAULT_SCHEDULE_MINUTE);
  if (kind === "daily") return `${safeMinute} ${safeHour} * * *`;
  if (kind === "weekdays") return `${safeMinute} ${safeHour} * * 1-5`;
  return `${safeMinute} ${safeHour} * * 1`;
}

export function automationScheduleLabel(schedule: string): string {
  const trimmed = schedule.trim();
  if (!trimmed) return "manual";
  const normalized = normalizeSchedule(trimmed);
  if (normalized === "*/5 * * * *") return "Every 5 minutes";
  if (normalized === "*/15 * * * *") return "Every 15 minutes";

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return trimmed;
  const [minutePart, hourPart, dayOfMonth, month, dayOfWeek] = parts;
  const minute = cronNumber(minutePart);
  const hour = cronNumber(hourPart);
  if (minute != null && hourPart === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Hourly";
  }
  if (minute == null || hour == null || dayOfMonth !== "*" || month !== "*") return trimmed;
  const clock = formatAutomationClockTime(hour, minute);
  if (dayOfWeek === "*") return `Daily at ${clock}`;
  if (dayOfWeek === "1-5" || dayOfWeek === "1,2,3,4,5") return `Weekdays at ${clock}`;
  if (/^[0-7]$/.test(dayOfWeek)) return `Weekly at ${clock}`;
  return trimmed;
}

export function updateAutomationDraft(
  draft: AutomationDraft,
  patch: Partial<AutomationDraft>,
): AutomationDraft {
  return {
    ...draft,
    ...patch,
    name: patch.name === undefined ? draft.name : patch.name.trim(),
    instruction:
      patch.instruction === undefined ? draft.instruction : patch.instruction.trim(),
    aiCmd: patch.aiCmd === undefined ? draft.aiCmd : patch.aiCmd.trim(),
    project: patch.project === undefined ? draft.project : patch.project.trim(),
    path: patch.path === undefined ? draft.path : patch.path.trim(),
    schedule: patch.schedule === undefined ? draft.schedule : patch.schedule.trim(),
    allowOverlap:
      patch.allowOverlap === undefined ? draft.allowOverlap : Boolean(patch.allowOverlap),
    active: patch.active === undefined ? draft.active : Boolean(patch.active),
  };
}

export function validateAutomationDraft(draft: AutomationDraft): DraftValidation {
  const errors: DraftValidation["errors"] = {};
  if (!draft.name.trim()) errors.name = "Name is required";
  if (!draft.instruction.trim()) errors.instruction = "Instruction is required";
  if (!draft.project.trim() && !draft.path.trim()) errors.target = "Choose a project or path";
  if (!draft.aiCmd.trim()) errors.aiCmd = "AI command is required";
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function formatAutomationRunSummary(run: AutomationRun): string {
  const pieces = [run.status, run.target, formatRunTimestamp(run.startedAt)];
  const message = run.message?.trim();
  if (message) pieces.push(message);
  return pieces.join(" · ");
}

export function automationFromRecord(record: AutomationRecord): Automation {
  return {
    id: record.id,
    name: record.name,
    instruction: record.instruction,
    aiCmd: record.aiCmd,
    project: record.project ?? "",
    path: record.path ?? "",
    schedule: record.schedule ?? "",
    allowOverlap: record.overlap === "queue",
    active: record.enabled,
    status: record.lastStatus,
    lastRunAt: record.lastRunAt ?? undefined,
    lastSession: record.lastSession ?? undefined,
  };
}

export function automationSaveInputFromDraft(
  draft: AutomationDraft,
  id?: string,
): SaveAutomationInput {
  const value = updateAutomationDraft(draft, draft);
  const schedule = value.schedule || null;
  const timezone = schedule ? Intl.DateTimeFormat().resolvedOptions().timeZone || null : null;
  return {
    ...(id ? { id } : {}),
    name: value.name,
    enabled: value.active,
    triggerType: schedule ? "schedule" : "manual",
    schedule,
    timezone,
    project: value.project || null,
    path: value.path || null,
    aiCmd: value.aiCmd,
    instruction: value.instruction,
    overlap: value.allowOverlap ? "queue" : "skip",
  };
}

export function automationRunFromRecord(
  record: AutomationRunRecord,
  automation?: Pick<Automation, "id" | "project" | "path">,
): AutomationRun {
  return {
    id: record.id,
    automationId: record.automationId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    sessionName: record.sessionName ?? null,
    target:
      automation?.project?.trim() ||
      automation?.path?.trim() ||
      record.sessionName?.trim() ||
      record.automationId,
    message: record.error ?? null,
  };
}

export function shouldRunAutomationSchedule(
  automation: Pick<Automation, "active" | "schedule" | "lastRunAt">,
  now = new Date(),
): boolean {
  if (!automation.active) return false;
  const schedule = automation.schedule.trim();
  if (!schedule) return false;
  if (!cronMatches(schedule, now)) return false;
  return minuteKey(automation.lastRunAt) !== minuteKey(now.toISOString());
}

function formatRunTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hour = date.getUTCHours().toString().padStart(2, "0");
  const minute = date.getUTCMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function cronMatches(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    cronFieldMatches(minute, date.getMinutes(), 0, 59) &&
    cronFieldMatches(hour, date.getHours(), 0, 23) &&
    cronFieldMatches(dayOfMonth, date.getDate(), 1, 31) &&
    cronFieldMatches(month, date.getMonth() + 1, 1, 12) &&
    cronFieldMatches(dayOfWeek, date.getDay(), 0, 7, true)
  );
}

function cronFieldMatches(
  expression: string,
  value: number,
  min: number,
  max: number,
  sundaySeven = false,
): boolean {
  return expression.split(",").some((rawPart) => {
    const part = rawPart.trim();
    if (!part) return false;
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step <= 0) return false;

    const range = parseCronRange(rangePart, min, max, sundaySeven);
    if (!range) return false;
    if (value < range.start || value > range.end) return false;
    return (value - range.start) % step === 0;
  });
}

function parseCronRange(
  value: string,
  min: number,
  max: number,
  sundaySeven: boolean,
): { start: number; end: number } | null {
  if (value === "*") return { start: min, end: sundaySeven ? 6 : max };
  if (value.includes("-")) {
    const [rawStart, rawEnd] = value.split("-");
    const start = parseCronNumber(rawStart, sundaySeven);
    const end = parseCronNumber(rawEnd, sundaySeven);
    if (start === null || end === null || start > end) return null;
    if (start < min || end > max) return null;
    return { start, end };
  }
  const number = parseCronNumber(value, sundaySeven);
  if (number === null || number < min || number > max) return null;
  return { start: number, end: number };
}

function parseCronNumber(value: string, sundaySeven: boolean): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (sundaySeven && parsed === 7) return 0;
  return parsed;
}

function minuteKey(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toISOString().slice(0, 16);
}
