import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { expandHomePath, loadConfigFile, type Config } from "./config.js";

export type AutomationTriggerType = "manual" | "schedule";
export type AutomationOverlap = "queue" | "skip";
export type AutomationStatus = "idle" | "queued" | "running" | "success" | "failed" | "skipped";

export interface AutomationRecord {
  id: string;
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
  lastRunAt: string | null;
  lastStatus: AutomationStatus;
  lastSession: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParsedAutomationCreateArgs {
  name?: string;
  instruction: string;
  aiCmd: string;
  project?: string;
  path?: string;
  schedule?: string;
  timezone?: string;
  overlap: AutomationOverlap;
  enabled: boolean;
}

export interface AutomationTarget {
  project: string | null;
  path: string | null;
}

export interface BuildAutomationRecordOptions {
  config: Config | null;
  cwd: string;
  id?: () => string;
  now?: () => string;
}

const AUTOMATIONS_FILE = ".tw-dashboard-automations.json";
const DEFAULT_AI_CMD = "claude";
const DEFAULT_OVERLAP: AutomationOverlap = "skip";

function usage(): string {
  return `用法:
  tw automation ls
  tw automation create --instruction <text> [--name <name>] [--cmd <ai-cmd>]
                       [--project <name> | --path <path>]
                       [--schedule <cron>] [--timezone <tz>]
                       [--overlap skip|queue] [--disabled]
  tw automation rm <id|name>

别名:
  tw auto ...
  tw automation add|new ...
  tw automation delete ...`;
}

function readOptionValue(args: string[], index: number, flag: string): [string, number] {
  const current = args[index];
  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length).trim();
    if (!value) throw new Error(`${flag} 不能为空`);
    return [value, index];
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
  return [value.trim(), index + 1];
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function parseAutomationCreateArgs(args: string[]): ParsedAutomationCreateArgs {
  const parsed: Partial<ParsedAutomationCreateArgs> = {
    aiCmd: DEFAULT_AI_CMD,
    overlap: DEFAULT_OVERLAP,
    enabled: true,
    path: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--disabled") {
      parsed.enabled = false;
      continue;
    }

    let value: string;
    switch (true) {
      case arg === "--name" || arg.startsWith("--name="):
        [value, i] = readOptionValue(args, i, "--name");
        parsed.name = value;
        break;
      case arg === "--instruction" || arg.startsWith("--instruction="):
        [value, i] = readOptionValue(args, i, "--instruction");
        parsed.instruction = value;
        break;
      case arg === "--cmd" || arg.startsWith("--cmd="):
        [value, i] = readOptionValue(args, i, "--cmd");
        parsed.aiCmd = value;
        break;
      case arg === "--project" || arg.startsWith("--project="):
        [value, i] = readOptionValue(args, i, "--project");
        parsed.project = value;
        break;
      case arg === "--path" || arg.startsWith("--path="):
        [value, i] = readOptionValue(args, i, "--path");
        parsed.path = value;
        break;
      case arg === "--schedule" || arg.startsWith("--schedule="):
        [value, i] = readOptionValue(args, i, "--schedule");
        parsed.schedule = value;
        break;
      case arg === "--timezone" || arg.startsWith("--timezone="):
        [value, i] = readOptionValue(args, i, "--timezone");
        parsed.timezone = value;
        break;
      case arg === "--overlap" || arg.startsWith("--overlap="):
        [value, i] = readOptionValue(args, i, "--overlap");
        if (value !== "skip" && value !== "queue") {
          throw new Error("--overlap 只能是 skip 或 queue");
        }
        parsed.overlap = value;
        break;
      case arg === "--help" || arg === "-h":
        throw new Error(usage());
      default:
        throw new Error(`未知 automation create 参数: ${arg}\n${usage()}`);
    }
  }

  parsed.instruction = collapseWhitespace(parsed.instruction ?? "");
  if (!parsed.instruction) {
    throw new Error(`--instruction 必填\n${usage()}`);
  }
  if (parsed.project && parsed.path) {
    throw new Error("--project 和 --path 只能指定一个");
  }

  return parsed as ParsedAutomationCreateArgs;
}

function normalizePathForCompare(path: string): string {
  return resolve(expandHomePath(path));
}

function isWithinPath(parent: string, child: string): boolean {
  const rel = relative(normalizePathForCompare(parent), normalizePathForCompare(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveAutomationTarget(
  input: Pick<ParsedAutomationCreateArgs, "project" | "path">,
  config: Config | null,
  cwd: string,
): AutomationTarget {
  const project = input.project?.trim();
  const path = input.path?.trim();

  if (project) {
    if (!config?.projects[project]) {
      throw new Error(`project '${project}' not in ~/.tmux-worktree.json`);
    }
    return { project, path: null };
  }

  if (path) {
    return { project: null, path: normalizePathForCompare(path) };
  }

  let bestMatch: { name: string; length: number } | null = null;
  if (config) {
    for (const [name, item] of Object.entries(config.projects)) {
      if (!isWithinPath(item.path, cwd)) continue;
      const length = normalizePathForCompare(item.path).length;
      if (!bestMatch || length > bestMatch.length) {
        bestMatch = { name, length };
      }
    }
  }

  if (bestMatch) return { project: bestMatch.name, path: null };
  return { project: null, path: normalizePathForCompare(cwd) };
}

function defaultAutomationName(instruction: string): string {
  const firstLine = instruction.split(/\r?\n/).find((line) => line.trim());
  const name = collapseWhitespace(firstLine ?? instruction);
  return name.slice(0, 80) || "Untitled automation";
}

function newAutomationId(): string {
  return `auto-${randomBytes(6).toString("hex")}`;
}

function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildAutomationRecord(
  parsed: ParsedAutomationCreateArgs,
  options: BuildAutomationRecordOptions,
): AutomationRecord {
  const target = resolveAutomationTarget(parsed, options.config, options.cwd);
  const schedule = collapseWhitespace(parsed.schedule ?? "") || null;
  const timezone = schedule ? collapseWhitespace(parsed.timezone ?? "") || null : null;
  const now = options.now?.() ?? nowRfc3339();

  return {
    id: options.id?.() ?? newAutomationId(),
    name: collapseWhitespace(parsed.name ?? "") || defaultAutomationName(parsed.instruction),
    enabled: parsed.enabled,
    triggerType: schedule ? "schedule" : "manual",
    schedule,
    timezone,
    project: target.project,
    path: target.path,
    aiCmd: collapseWhitespace(parsed.aiCmd) || DEFAULT_AI_CMD,
    instruction: parsed.instruction,
    overlap: parsed.overlap,
    lastRunAt: null,
    lastStatus: "idle",
    lastSession: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function automationStatePath(home = homedir()): string {
  return join(home, AUTOMATIONS_FILE);
}

function readAutomations(path = automationStatePath()): AutomationRecord[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array`);
  }
  return parsed as AutomationRecord[];
}

function writeAutomations(records: AutomationRecord[], path = automationStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2) + "\n");
}

function homeShort(path: string | null): string {
  if (!path) return "";
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function targetLabel(record: AutomationRecord): string {
  return record.project || homeShort(record.path) || "-";
}

function triggerLabel(record: AutomationRecord): string {
  return record.triggerType === "schedule" && record.schedule ? record.schedule : "manual";
}

function printAutomationList(records: AutomationRecord[]): void {
  if (records.length === 0) {
    console.log("没有 automation。用 `tw automation create --instruction <text>` 创建一个。");
    return;
  }
  const nameW = Math.max(4, ...records.map((record) => record.name.length));
  const stateW = Math.max(6, ...records.map((record) => (record.enabled ? "active" : "paused").length));
  console.log(` ${"NAME".padEnd(nameW)}  ${"STATE".padEnd(stateW)}  TRIGGER           TARGET  CMD`);
  for (const record of records) {
    const state = record.enabled ? "active" : "paused";
    console.log(
      ` ${record.name.padEnd(nameW)}  ${state.padEnd(stateW)}  ${triggerLabel(record).padEnd(16)}  ${targetLabel(record)}  ${record.aiCmd}`,
    );
  }
}

function deleteAutomation(records: AutomationRecord[], target: string): AutomationRecord[] {
  const idIndex = records.findIndex((record) => record.id === target);
  if (idIndex >= 0) return records.filter((_, index) => index !== idIndex);

  const matches = records.filter((record) => record.name === target);
  if (matches.length === 0) throw new Error(`automation not found: ${target}`);
  if (matches.length > 1) {
    throw new Error(`automation name is ambiguous: ${target}; use id instead`);
  }
  return records.filter((record) => record.id !== matches[0].id);
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (arg.includes("=") || arg === "--disabled") continue;
      i++;
      continue;
    }
    values.push(arg);
  }
  return values;
}

export async function automationCmd(args: string[]): Promise<void> {
  const sub = args[0] ?? "ls";
  const rest = args.slice(1);

  switch (sub) {
    case "ls":
    case "list":
      printAutomationList(readAutomations());
      return;
    case "create":
    case "add":
    case "new": {
      const parsed = parseAutomationCreateArgs(rest);
      const config = loadConfigFile();
      const record = buildAutomationRecord(parsed, {
        config,
        cwd: process.cwd(),
      });
      const records = readAutomations();
      writeAutomations([...records, record]);
      console.log(`✓ 已创建 automation ${record.name} (${record.id})`);
      console.log(`  target: ${targetLabel(record)}`);
      return;
    }
    case "rm":
    case "delete": {
      const [target] = positional(rest);
      if (!target) throw new Error(`用法: tw automation rm <id|name>`);
      const records = readAutomations();
      const next = deleteAutomation(records, target);
      if (next.length === records.length) throw new Error(`automation not found: ${target}`);
      writeAutomations(next);
      console.log(`✓ 已删除 automation ${target}`);
      return;
    }
    case "help":
    case "-h":
    case "--help":
      console.log(usage());
      return;
    default:
      throw new Error(`未知 automation 子命令: ${sub}\n可用: ls | create | rm`);
  }
}
