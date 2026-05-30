import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface ProjectConfig {
  name: string;
  path: string;
  branch?: string;
}

export interface Config {
  projects: Record<string, ProjectConfig>;
  worktreeBase?: string;
}

export const CONFIG_PATH = join(homedir(), ".tmux-worktree.json");

const PROJECT_KEYS = ["projects", "repositories", "repos"];
const PROJECT_NAME_FIELDS = ["name", "key", "id", "label"];
const PROJECT_PATH_FIELDS = [
  "path",
  "dir",
  "directory",
  "root",
  "repo",
  "repoPath",
  "repository",
  "repositoryPath",
];
const PROJECT_BRANCH_FIELDS = [
  "branch",
  "targetBranch",
  "target_branch",
  "defaultBranch",
  "default_branch",
];
const WORKTREE_BASE_FIELDS = [
  "worktreeBase",
  "worktree_base",
  "worktreeDir",
  "worktreeRoot",
  "worktreesDir",
  "worktreesRoot",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function stringField(value: unknown, fields: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const field of fields) {
    const raw = value[field];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

function projectFromValue(name: string, value: unknown): ProjectConfig | undefined {
  if (typeof value === "string" && value.trim()) {
    return { name, path: expandHomePath(value) };
  }
  const rawPath = stringField(value, PROJECT_PATH_FIELDS);
  if (!rawPath) return undefined;
  const rawBranch = stringField(value, PROJECT_BRANCH_FIELDS);
  return {
    name,
    path: expandHomePath(rawPath),
    branch: rawBranch,
  };
}

function projectsValue(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return undefined;
  for (const key of PROJECT_KEYS) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

export function normalizeConfig(raw: unknown): Config {
  const projects: Record<string, ProjectConfig> = {};
  const value = projectsValue(raw);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        const path = expandHomePath(item);
        const name = basename(path) || path;
        projects[name] = { name, path };
        continue;
      }
      const name = stringField(item, PROJECT_NAME_FIELDS);
      if (!name) continue;
      const project = projectFromValue(name, item);
      if (project) projects[name] = project;
    }
  } else if (isRecord(value)) {
    for (const [name, projectValue] of Object.entries(value)) {
      const project = projectFromValue(name, projectValue);
      if (project) projects[name] = project;
    }
  }

  const worktreeBase = stringField(raw, WORKTREE_BASE_FIELDS);
  return {
    projects,
    worktreeBase: worktreeBase ? expandHomePath(worktreeBase) : undefined,
  };
}

export function loadConfigFile(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
}
