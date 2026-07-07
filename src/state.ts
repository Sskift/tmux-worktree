import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MANAGED_STATE_VERSION = 1;

export type ManagedSessionKind = "worktree" | "terminal";
export type ManagedSessionProfile = "cli" | "dashboard";

export interface ManagedSession {
  name: string;
  kind: ManagedSessionKind;
  profile: ManagedSessionProfile;
  project?: string;
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  cwd?: string;
  createdAt: string;
}

export interface ManagedState {
  version: number;
  sessions: ManagedSession[];
}

export function twHomeDir(home = homedir()): string {
  return join(home, ".tmux-worktree");
}

export function managedStatePath(home = homedir()): string {
  return join(twHomeDir(home), "state.json");
}

export function emptyManagedState(): ManagedState {
  return { version: MANAGED_STATE_VERSION, sessions: [] };
}

export function normalizeManagedState(value: unknown): ManagedState {
  if (!value || typeof value !== "object") return emptyManagedState();
  const raw = value as { version?: unknown; sessions?: unknown };
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.filter(isManagedSession)
    : [];
  return {
    version: MANAGED_STATE_VERSION,
    sessions,
  };
}

function isManagedSession(value: unknown): value is ManagedSession {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.name === "string" &&
    (raw.kind === "worktree" || raw.kind === "terminal") &&
    (raw.profile === "cli" || raw.profile === "dashboard") &&
    typeof raw.createdAt === "string"
  );
}

export function loadManagedState(path = managedStatePath()): ManagedState {
  if (!existsSync(path)) return emptyManagedState();
  try {
    return normalizeManagedState(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return emptyManagedState();
  }
}

export function saveManagedState(state: ManagedState, path = managedStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normalizeManagedState(state), null, 2) + "\n");
}

export function upsertManagedSession(
  state: ManagedState,
  session: ManagedSession,
): ManagedState {
  const sessions = state.sessions.filter((existing) => existing.name !== session.name);
  sessions.push(session);
  return {
    version: MANAGED_STATE_VERSION,
    sessions,
  };
}
