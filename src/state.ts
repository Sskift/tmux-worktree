import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const MANAGED_STATE_VERSION = 1;
export const MANAGED_SESSION_LIFECYCLE_EXTENSION_KEY = "tw.rpc-v2.lifecycle.v1";
export const MANAGED_SESSION_LIFECYCLE_EXTENSION_VERSION = 1;
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
  extensions?: Record<string, unknown>;
}

export interface ManagedSessionReservationCorrelationV1 {
  schemaVersion: 1;
  reservationId: string;
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
  requestFingerprint: {
    schemaVersion: 1;
    algorithm: "sha256-rfc8785";
    digest: string;
  };
}

export interface ManagedTmuxIncarnationIdentityV1 {
  serverSocketPath: string;
  serverPid: string;
  serverStarted: string;
  sessionId: string;
  rawName: string;
  sessionCreated: string;
  birthMarker: string | null;
}

export interface ManagedSessionLifecycleExtensionV1 {
  schemaVersion: 1;
  incarnation: string;
  tmux: ManagedTmuxIncarnationIdentityV1 & { birthMarker: string };
  reservationCorrelation: ManagedSessionReservationCorrelationV1;
  displayLabel: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value: unknown, maxBytes = 4_096): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function assertManagedTmuxIncarnationIdentity(
  identity: ManagedTmuxIncarnationIdentityV1,
): void {
  if (!isBoundedString(identity.serverSocketPath, 4_096)
    || !/^(0|[1-9][0-9]*)$/.test(identity.serverPid)
    || !/^(0|[1-9][0-9]*)$/.test(identity.serverStarted)
    || !/^\$(0|[1-9][0-9]*)$/.test(identity.sessionId)
    || !isBoundedString(identity.rawName, 128)
    || !/^(0|[1-9][0-9]*)$/.test(identity.sessionCreated)
    || (identity.birthMarker !== null
      && !/^twbirth2\.[A-Za-z0-9_-]{22}$/.test(identity.birthMarker))) {
    throw new Error("invalid managed tmux incarnation identity");
  }
}

export function normalizeManagedSessionReservationCorrelation(
  value: unknown,
): ManagedSessionReservationCorrelationV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "reservationId",
    "hostEpoch",
    "principalId",
    "hostId",
    "commandId",
    "requestFingerprint",
  ]) || value.schemaVersion !== 1) {
    throw new Error("invalid managed reservation correlation");
  }
  for (const field of ["reservationId", "hostEpoch", "principalId", "hostId", "commandId"] as const) {
    if (!isBoundedString(value[field], 128)) {
      throw new Error(`invalid managed reservation correlation ${field}`);
    }
  }
  const fingerprint = value.requestFingerprint;
  if (!isRecord(fingerprint) || !hasExactKeys(fingerprint, ["schemaVersion", "algorithm", "digest"])
    || fingerprint.schemaVersion !== 1
    || fingerprint.algorithm !== "sha256-rfc8785"
    || typeof fingerprint.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(fingerprint.digest)) {
    throw new Error("invalid managed reservation correlation requestFingerprint");
  }
  return {
    schemaVersion: 1,
    reservationId: value.reservationId as string,
    hostEpoch: value.hostEpoch as string,
    principalId: value.principalId as string,
    hostId: value.hostId as string,
    commandId: value.commandId as string,
    requestFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256-rfc8785",
      digest: fingerprint.digest,
    },
  };
}

export function issueManagedSessionIncarnation(
  identity: ManagedTmuxIncarnationIdentityV1,
): string {
  assertManagedTmuxIncarnationIdentity(identity);
  const canonical = JSON.stringify({
    schemaVersion: 1,
    serverSocketPath: identity.serverSocketPath,
    serverPid: identity.serverPid,
    serverStarted: identity.serverStarted,
    sessionId: identity.sessionId,
    rawName: identity.rawName,
    sessionCreated: identity.sessionCreated,
    birthMarker: identity.birthMarker,
  });
  return `twinc2.${createHash("sha256").update(canonical, "utf8").digest("base64url")}`;
}

export function buildManagedSessionLifecycleExtension(
  identity: ManagedTmuxIncarnationIdentityV1 & { birthMarker: string },
  reservationCorrelation: ManagedSessionReservationCorrelationV1,
  displayLabel: string | null,
): ManagedSessionLifecycleExtensionV1 {
  assertManagedTmuxIncarnationIdentity(identity);
  if (displayLabel !== null && !isBoundedString(displayLabel, 128)) {
    throw new Error("invalid managed session display label");
  }
  return {
    schemaVersion: MANAGED_SESSION_LIFECYCLE_EXTENSION_VERSION,
    incarnation: issueManagedSessionIncarnation(identity),
    tmux: { ...identity },
    reservationCorrelation: normalizeManagedSessionReservationCorrelation(reservationCorrelation),
    displayLabel,
  };
}

/**
 * Return an exact v2 lifecycle extension. Absence is a supported legacy record;
 * a present but malformed extension is authority corruption and fails closed.
 */
export function managedSessionLifecycleExtension(
  session: ManagedSession,
): ManagedSessionLifecycleExtensionV1 | undefined {
  const extensions = session.extensions;
  if (extensions === undefined || !Object.hasOwn(extensions, MANAGED_SESSION_LIFECYCLE_EXTENSION_KEY)) {
    return undefined;
  }
  const value = extensions[MANAGED_SESSION_LIFECYCLE_EXTENSION_KEY];
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "incarnation",
    "tmux",
    "reservationCorrelation",
    "displayLabel",
  ]) || value.schemaVersion !== MANAGED_SESSION_LIFECYCLE_EXTENSION_VERSION
    || !isBoundedString(value.incarnation, 128)
    || (value.displayLabel !== null && !isBoundedString(value.displayLabel, 128))) {
    throw new Error(`managed session ${session.name} has a malformed ${MANAGED_SESSION_LIFECYCLE_EXTENSION_KEY} extension`);
  }
  const tmux = value.tmux;
  if (!isRecord(tmux) || !hasExactKeys(tmux, [
    "serverSocketPath",
    "serverPid",
    "serverStarted",
    "sessionId",
    "rawName",
    "sessionCreated",
    "birthMarker",
  ])) {
    throw new Error(`managed session ${session.name} has malformed tmux incarnation evidence`);
  }
  for (const field of [
    "serverSocketPath",
    "serverPid",
    "serverStarted",
    "sessionId",
    "rawName",
    "sessionCreated",
    "birthMarker",
  ] as const) {
    if (!isBoundedString(tmux[field], field === "serverSocketPath" ? 4_096 : 128)) {
      throw new Error(`managed session ${session.name} has invalid tmux incarnation ${field}`);
    }
  }
  const identity = tmux as unknown as ManagedTmuxIncarnationIdentityV1 & { birthMarker: string };
  try {
    assertManagedTmuxIncarnationIdentity(identity);
  } catch {
    throw new Error(`managed session ${session.name} has invalid tmux incarnation identity`);
  }
  if (identity.rawName !== session.name || issueManagedSessionIncarnation(identity) !== value.incarnation) {
    throw new Error(`managed session ${session.name} has inconsistent incarnation evidence`);
  }
  return {
    schemaVersion: 1,
    incarnation: value.incarnation,
    tmux: { ...identity },
    reservationCorrelation: normalizeManagedSessionReservationCorrelation(value.reservationCorrelation),
    displayLabel: value.displayLabel,
  };
}

export function withManagedSessionLifecycleExtension(
  session: ManagedSession,
  extension: ManagedSessionLifecycleExtensionV1,
): ManagedSession {
  return {
    ...session,
    extensions: {
      ...(session.extensions ?? {}),
      [MANAGED_SESSION_LIFECYCLE_EXTENSION_KEY]: extension,
    },
  };
}

/** V2 authority accepts legacy records, but never ambiguous names or malformed extensions. */
export function assertManagedStateLifecycleV2Authority(state: ManagedState): void {
  const names = new Set<string>();
  for (const session of state.sessions) {
    if (names.has(session.name)) {
      throw new Error(`managed state has duplicate session authority for ${session.name}`);
    }
    names.add(session.name);
    if (session.extensions !== undefined && !isRecord(session.extensions)) {
      throw new Error(`managed session ${session.name} has a malformed extensions container`);
    }
    managedSessionLifecycleExtension(session);
  }
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
  return isDeepStrictEqual(current, expected);
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
