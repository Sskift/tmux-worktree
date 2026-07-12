import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MANAGED_STATE_VERSION = 1;
const MANAGED_STATE_LOCK_OWNER_FILE = "owner.json";
const MANAGED_STATE_LOCK_STALE_MS = 60_000;

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

export interface ManagedStateLock {
  path: string;
  owner: string;
}

interface ManagedStateLockOwnerRecord {
  owner: string;
  createdAt: number;
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
    // Listing must remain available even when a user needs to repair a legacy
    // or damaged state file. Mutations use the strict reader below and will
    // never turn this compatibility fallback into a destructive overwrite.
    return emptyManagedState();
  }
}

export function loadManagedStateForMutation(path = managedStatePath()): ManagedState {
  if (!existsSync(path)) return emptyManagedState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `refusing to mutate invalid managed state ${path}; original file preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`refusing to mutate invalid managed state ${path}; root must be an object and the original file was preserved`);
  }
  const raw = parsed as { version?: unknown; sessions?: unknown };
  if (raw.version !== MANAGED_STATE_VERSION) {
    throw new Error(
      `refusing to mutate managed state ${path} with unsupported version ${String(raw.version)}; original file preserved`,
    );
  }
  if (!Array.isArray(raw.sessions)) {
    throw new Error(`refusing to mutate invalid managed state ${path}; sessions must be an array and the original file was preserved`);
  }
  const invalidIndex = raw.sessions.findIndex((session) => !isManagedSession(session));
  if (invalidIndex >= 0) {
    throw new Error(
      `refusing to mutate invalid managed state ${path}; sessions[${invalidIndex}] is malformed and the original file was preserved`,
    );
  }
  return {
    version: MANAGED_STATE_VERSION,
    sessions: raw.sessions as ManagedSession[],
  };
}

export function saveManagedState(state: ManagedState, path = managedStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(normalizeManagedState(state), null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
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

function sleepSync(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function managedStateLockOwnerPath(lockPath: string): string {
  return join(lockPath, MANAGED_STATE_LOCK_OWNER_FILE);
}

function readManagedStateLockOwner(lockPath: string): ManagedStateLockOwnerRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(managedStateLockOwnerPath(lockPath), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.owner !== "string" || typeof record.createdAt !== "number") return undefined;
    return { owner: record.owner, createdAt: record.createdAt };
  } catch {
    return undefined;
  }
}

function managedStateLockIsStale(lockPath: string): boolean {
  const owner = readManagedStateLockOwner(lockPath);
  if (owner) return Date.now() - owner.createdAt > MANAGED_STATE_LOCK_STALE_MS;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > MANAGED_STATE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export function acquireManagedStateLock(lockPath = `${managedStatePath()}.lock`): ManagedStateLock {
  const deadline = Date.now() + 5_000;
  const owner = `${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(
          managedStateLockOwnerPath(lockPath),
          `${JSON.stringify({ owner, createdAt: Date.now() } satisfies ManagedStateLockOwnerRecord)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { path: lockPath, owner };
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      if (managedStateLockIsStale(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for managed state lock: ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

export function releaseManagedStateLock(lock: ManagedStateLock): void {
  const current = readManagedStateLockOwner(lock.path);
  if (current?.owner !== lock.owner) return;
  rmSync(lock.path, { recursive: true, force: true });
}

function withManagedStateLock<T>(path: string, operation: () => T): T {
  const lock = acquireManagedStateLock(`${path}.lock`);
  try {
    return operation();
  } finally {
    releaseManagedStateLock(lock);
  }
}

/** Atomically merge one session record without losing concurrent RPC writes. */
export function recordManagedSession(
  session: ManagedSession,
  path = managedStatePath(),
): ManagedState {
  if (!isManagedSession(session)) {
    throw new Error("refusing to record a malformed managed session");
  }
  return withManagedStateLock(path, () => {
    const next = upsertManagedSession(loadManagedStateForMutation(path), session);
    saveManagedState(next, path);
    return next;
  });
}

/** Remove a managed record under the same inter-process lock used by creates. */
export function removeManagedSession(
  name: string,
  path = managedStatePath(),
): ManagedState {
  return withManagedStateLock(path, () => {
    const current = loadManagedStateForMutation(path);
    const next: ManagedState = {
      version: MANAGED_STATE_VERSION,
      sessions: current.sessions.filter((session) => session.name !== name),
    };
    saveManagedState(next, path);
    return next;
  });
}

function sameManagedSessionRecord(
  current: ManagedSession,
  expected: ManagedSession,
): boolean {
  return (
    current.name === expected.name
    && current.kind === expected.kind
    && current.profile === expected.profile
    && current.project === expected.project
    && current.repoPath === expected.repoPath
    && current.worktreePath === expected.worktreePath
    && current.branch === expected.branch
    && current.baseBranch === expected.baseBranch
    && current.cwd === expected.cwd
    && current.createdAt === expected.createdAt
  );
}

/**
 * Remove only the exact record observed before a lifecycle mutation.
 *
 * A same-named session can be recreated after the old tmux session is killed
 * but before state cleanup acquires the lock. In that interleaving, an
 * unconditional name-based delete would erase the replacement record.
 */
export function removeManagedSessionIfCurrent(
  expected: ManagedSession,
  path = managedStatePath(),
): ManagedState {
  if (!isManagedSession(expected)) {
    throw new Error("refusing to remove a malformed managed session");
  }
  return withManagedStateLock(path, () => {
    const current = loadManagedStateForMutation(path);
    if (!current.sessions.some((session) => sameManagedSessionRecord(session, expected))) {
      return current;
    }
    const next: ManagedState = {
      version: MANAGED_STATE_VERSION,
      sessions: current.sessions.filter(
        (session) => !sameManagedSessionRecord(session, expected),
      ),
    };
    saveManagedState(next, path);
    return next;
  });
}
