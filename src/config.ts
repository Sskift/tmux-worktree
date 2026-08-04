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
  tmuxPath?: string;
  hosts: HostConfig[];
}

export interface HostConfig {
  id: string;
  label?: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  worktreeBase?: string;
  tmuxPath?: string;
  twPath?: string;
}

export const CONFIG_PATH = join(homedir(), ".tmux-worktree.json");

/**
 * Canonical default for newly-created worktrees.
 *
 * Keeping this under HOME makes the same contract portable across macOS and
 * remote Linux hosts. Dashboard discovery still recognises the historical
 * /private/tmp location, but new CLI and RPC mutations must use this value.
 */
export function defaultWorktreeBase(home = homedir()): string {
  return join(home, ".tmux-worktree", "worktrees");
}

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
const TMUX_PATH_FIELDS = ["tmuxPath", "tmux_path", "tmuxBin", "tmux_bin"];
const TW_PATH_FIELDS = ["twPath", "tw_path", "twBin", "tw_bin"];

const HOSTS_FIELDS = ["hosts", "remotes", "remoteHosts"];
const HOST_ID_FIELDS = ["id", "name", "key"];
const HOST_LABEL_FIELDS = ["label", "displayName", "display_name"];
const HOST_HOST_FIELDS = ["host", "hostname", "address"];
const HOST_USER_FIELDS = ["user", "username"];
const HOST_IDENTITY_FIELDS = ["identityFile", "identity_file", "keyFile", "key_file"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function expandHomePath(value: string, home = homedir()): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  return trimmed;
}

export function resolveWorktreeBase(value?: string, home = homedir()): string {
  return value?.trim() ? expandHomePath(value, home) : defaultWorktreeBase(home);
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
  const tmuxPath = stringField(raw, TMUX_PATH_FIELDS);
  const hosts = hostsFromRaw(raw);
  return {
    projects,
    worktreeBase: worktreeBase ? expandHomePath(worktreeBase) : undefined,
    tmuxPath: tmuxPath ? expandHomePath(tmuxPath) : undefined,
    hosts,
  };
}

function hostFromRaw(value: unknown, fallbackId?: string): HostConfig | undefined {
  if (typeof value === "string" && value.trim()) {
    const host = value.trim();
    const id = fallbackId?.trim() || host;
    return { id, label: id, host };
  }
  if (!isRecord(value)) return undefined;

  const host = stringField(value, HOST_HOST_FIELDS) || fallbackId?.trim();
  const id = stringField(value, HOST_ID_FIELDS) || fallbackId?.trim() || host;
  if (!host || !id) return undefined;
  const rawPort = value.port;
  const port = typeof rawPort === "number"
    ? rawPort
    : typeof rawPort === "string" && rawPort.trim()
      ? Number(rawPort)
      : undefined;
  const rawWorktreeBase = stringField(value, WORKTREE_BASE_FIELDS);
  const rawIdentityFile = stringField(value, HOST_IDENTITY_FIELDS);
  const rawTmuxPath = stringField(value, TMUX_PATH_FIELDS);
  const rawTwPath = stringField(value, TW_PATH_FIELDS);
  return {
    id,
    label: stringField(value, HOST_LABEL_FIELDS) || id,
    host,
    user: stringField(value, HOST_USER_FIELDS),
    port: Number.isInteger(port) && port && port > 0 ? port : undefined,
    // identityFile is local and may be expanded here. The remaining paths are
    // evaluated on the remote host and must retain a leading `~`.
    identityFile: rawIdentityFile ? expandHomePath(rawIdentityFile) : undefined,
    worktreeBase: rawWorktreeBase,
    tmuxPath: rawTmuxPath,
    twPath: rawTwPath,
  };
}

function hostsFromRaw(raw: unknown): HostConfig[] {
  if (!isRecord(raw)) return [];
  let rawHosts: unknown;
  for (const field of HOSTS_FIELDS) {
    if (raw[field] !== undefined) {
      rawHosts = raw[field];
      break;
    }
  }
  if (Array.isArray(rawHosts)) {
    return rawHosts.flatMap((item): HostConfig[] => {
      const host = hostFromRaw(item);
      return host ? [host] : [];
    });
  }
  if (isRecord(rawHosts)) {
    return Object.entries(rawHosts).flatMap(([id, value]): HostConfig[] => {
      const host = hostFromRaw(value, id);
      return host ? [host] : [];
    });
  }
  return [];
}

export function loadConfigFile(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
}
