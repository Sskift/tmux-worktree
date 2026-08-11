import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const FEISHU_MEETING_STORAGE_VERSION = 1;
export const FEISHU_MEETING_DEDUP_LIMIT = 1024;
export const FEISHU_MEETING_SESSION_LIMIT = 64;
export const FEISHU_MEETING_MAX_PENDING_BATCH_BYTES = 128 * 1024;

export type MeetingSessionState =
  | "invited"
  | "joining"
  | "active"
  | "summarizing"
  | "leaving"
  | "ended"
  | "rejected"
  | "recovery-required";

export interface MeetingPolicy {
  enabled: boolean;
  autoAnswer: boolean;
  bindingId: string;
  allowedInviterIds: string[];
  leaveOnTargetLoss: true;
}

export interface PreparedMeetingBatch {
  batchId: string;
  meetingId: string;
  rangeStart: string;
  rangeEnd: string;
  content: string;
  createdAt: string;
}

export interface MeetingSession {
  id: string;
  state: MeetingSessionState;
  bindingId: string;
  inviteEventId?: string;
  callId?: string;
  inviterId?: string;
  meetingNo: string;
  meetingId?: string;
  pageToken?: string;
  joinedAt?: string;
  lastEventAt?: string;
  completedAt?: string;
  error?: string;
  pendingBatch?: PreparedMeetingBatch;
}

interface MeetingsFile {
  version: 1;
  policy: MeetingPolicy;
  sessions: MeetingSession[];
  inviteDedupIds: string[];
}

interface FeishuMeetingStorageLock {
  path: string;
  owner: string;
}

interface FeishuMeetingStorageLockOwner {
  owner: string;
  pid: number;
  createdAt: number;
}

const FEISHU_MEETING_STORAGE_LOCK_WAIT_MS = 5_000;
const FEISHU_MEETING_STORAGE_LOCK_STALE_MS = 60_000;

export interface FeishuMeetingPaths {
  root: string;
  meetings: string;
  lock: string;
}

export function feishuMeetingPaths(home = homedir()): FeishuMeetingPaths {
  const root = join(home, ".tmux-worktree");
  return {
    root,
    meetings: join(root, "feishu-meetings-v1.json"),
    lock: join(root, "feishu-meeting-storage.lock"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeText(value: unknown, maxBytes = 1024): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !value.includes("\0");
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isMeetingNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{9}$/.test(value);
}

const MEETING_SESSION_STATES: MeetingSessionState[] = [
  "invited", "joining", "active", "summarizing", "leaving", "ended", "rejected", "recovery-required",
];

function isPreparedMeetingBatch(value: unknown): value is PreparedMeetingBatch {
  if (!isRecord(value) || !exactKeys(value, [
    "batchId", "meetingId", "rangeStart", "rangeEnd", "content", "createdAt",
  ])) return false;
  return [value.batchId, value.meetingId, value.rangeStart, value.rangeEnd]
    .every((item) => isSafeText(item))
    && typeof value.content === "string"
    && Buffer.byteLength(value.content, "utf8") <= FEISHU_MEETING_MAX_PENDING_BATCH_BYTES
    && isIso(value.createdAt);
}

function isMeetingPolicy(value: unknown): value is MeetingPolicy {
  if (!isRecord(value) || !exactKeys(value, [
    "enabled", "autoAnswer", "bindingId", "allowedInviterIds", "leaveOnTargetLoss",
  ])) return false;
  if (typeof value.enabled !== "boolean" || typeof value.autoAnswer !== "boolean") return false;
  if (!isSafeText(value.bindingId)) return false;
  if (value.leaveOnTargetLoss !== true) return false;
  if (!Array.isArray(value.allowedInviterIds)) return false;
  if (!value.allowedInviterIds.every((item) => isSafeText(item))) return false;
  if (value.autoAnswer && value.allowedInviterIds.length === 0) return false;
  return true;
}

function isMeetingSession(value: unknown): value is MeetingSession {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "state", "bindingId", "meetingNo",
  ], [
    "inviteEventId", "callId", "inviterId", "meetingId", "pageToken",
    "joinedAt", "lastEventAt", "completedAt", "error", "pendingBatch",
  ])) return false;
  if (!isSafeText(value.id) || !isSafeText(value.bindingId)) return false;
  if (!MEETING_SESSION_STATES.includes(value.state as MeetingSessionState)) return false;
  if (!isMeetingNumber(value.meetingNo)) return false;
  const optionalText = [value.inviteEventId, value.callId, value.inviterId, value.meetingId, value.pageToken];
  if (!optionalText.every((item) => item === undefined || isSafeText(item))) return false;
  const optionalIso = [value.joinedAt, value.lastEventAt, value.completedAt];
  if (!optionalIso.every((item) => item === undefined || isIso(item))) return false;
  if (value.error !== undefined && !isSafeText(value.error, 4096)) return false;
  if (value.pendingBatch !== undefined && !isPreparedMeetingBatch(value.pendingBatch)) return false;
  return true;
}

function validateMeetingsFile(value: unknown): value is MeetingsFile {
  if (!isRecord(value) || !exactKeys(value, ["version", "policy", "sessions", "inviteDedupIds"])) return false;
  if (value.version !== 1) return false;
  if (!isMeetingPolicy(value.policy)) return false;
  if (!Array.isArray(value.sessions) || value.sessions.length > FEISHU_MEETING_SESSION_LIMIT) return false;
  if (!value.sessions.every(isMeetingSession)) return false;
  if (!Array.isArray(value.inviteDedupIds) || value.inviteDedupIds.length > FEISHU_MEETING_DEDUP_LIMIT) return false;
  if (!value.inviteDedupIds.every((item) => isSafeText(item))) return false;
  return true;
}

function storageLockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function readStorageLockOwner(lockPath: string): FeishuMeetingStorageLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(storageLockOwnerPath(lockPath), "utf8")) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["owner", "pid", "createdAt"])) return undefined;
    if (!isSafeText(value.owner) || !Number.isSafeInteger(value.pid) || !Number.isFinite(value.createdAt)) {
      return undefined;
    }
    return value as unknown as FeishuMeetingStorageLockOwner;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function storageLockIsStale(lockPath: string): boolean {
  const owner = readStorageLockOwner(lockPath);
  if (owner) {
    return Date.now() - owner.createdAt > FEISHU_MEETING_STORAGE_LOCK_STALE_MS && !processExists(owner.pid);
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > FEISHU_MEETING_STORAGE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function waitForStorageLock(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireFeishuMeetingStorageLock(lockPath: string): FeishuMeetingStorageLock {
  const deadline = Date.now() + FEISHU_MEETING_STORAGE_LOCK_WAIT_MS;
  const owner = `${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(storageLockOwnerPath(lockPath), `${JSON.stringify({
          owner,
          pid: process.pid,
          createdAt: Date.now(),
        } satisfies FeishuMeetingStorageLockOwner)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { path: lockPath, owner };
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      if (storageLockIsStale(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Feishu meeting storage lock: ${lockPath}`);
      waitForStorageLock(20);
    }
  }
}

function releaseFeishuMeetingStorageLock(lock: FeishuMeetingStorageLock): void {
  if (readStorageLockOwner(lock.path)?.owner !== lock.owner) return;
  rmSync(lock.path, { recursive: true, force: true });
}

function loadFile<T>(path: string, empty: T, validate: (value: unknown) => value is T): T {
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`refusing invalid Feishu meeting state ${path}; original preserved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(parsed)) throw new Error(`refusing malformed Feishu meeting state ${path}; original preserved`);
  return parsed;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd = -1;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    writeSync(fd, contents, 0, contents.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

export function defaultMeetingPolicy(): MeetingPolicy {
  return {
    enabled: false,
    autoAnswer: false,
    bindingId: "",
    allowedInviterIds: [],
    leaveOnTargetLoss: true,
  };
}

export class FeishuMeetingStore {
  readonly paths: FeishuMeetingPaths;

  constructor(paths = feishuMeetingPaths()) {
    this.paths = paths;
  }

  read(): {
    policy: MeetingPolicy;
    sessions: MeetingSession[];
    inviteDedupIds: string[];
  } {
    const lock = acquireFeishuMeetingStorageLock(this.paths.lock);
    try {
      const file = loadFile(
        this.paths.meetings,
        { version: 1, policy: defaultMeetingPolicy(), sessions: [], inviteDedupIds: [] } as MeetingsFile,
        validateMeetingsFile,
      );
      return {
        policy: file.policy,
        sessions: file.sessions,
        inviteDedupIds: file.inviteDedupIds,
      };
    } finally {
      releaseFeishuMeetingStorageLock(lock);
    }
  }

  write(state: {
    policy: MeetingPolicy;
    sessions: MeetingSession[];
    inviteDedupIds: string[];
  }): void {
    const file = {
      version: 1,
      policy: state.policy,
      sessions: state.sessions.slice(-FEISHU_MEETING_SESSION_LIMIT),
      inviteDedupIds: state.inviteDedupIds.slice(-FEISHU_MEETING_DEDUP_LIMIT),
    } satisfies MeetingsFile;
    if (!validateMeetingsFile(file)) {
      throw new Error("refusing to persist malformed Feishu meeting state");
    }
    const lock = acquireFeishuMeetingStorageLock(this.paths.lock);
    try {
      atomicWrite(this.paths.meetings, file);
    } finally {
      releaseFeishuMeetingStorageLock(lock);
    }
  }
}
