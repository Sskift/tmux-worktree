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
import type { TerminalControlAgentSource } from "./terminalControl/protocol";
export const FEISHU_BRIDGE_STORAGE_VERSION = 1;
export const FEISHU_EVENT_DEDUP_LIMIT = 4096;
export const FEISHU_TURN_HISTORY_LIMIT = 256;
export const FEISHU_REPLY_HISTORY_LIMIT = 256;

export type FeishuBindingStatus = "active" | "pausing" | "paused" | "stale";
export type FeishuReplyMode = "topic" | "direct";

export type FeishuActivityWatchStatus =
  | "probing"
  | "armed"
  | "stop-candidate"
  | "sending"
  | "sent"
  | "uncertain"
  | "cancelled"
  | "recovery-required";

export interface FeishuActivityWatch {
  id: string;
  status: FeishuActivityWatchStatus;
  controlEpoch: string;
  leaseId: string;
  fence: string;
  outputGeneration: string;
  source?: TerminalControlAgentSource;
  createdAt: string;
  observedRunningAt?: string;
  stopCandidateAt?: string;
  completedAt?: string;
  messageId?: string;
  error?: string;
}

export interface FeishuHandoffRecord {
  handoffId: string;
  controlEpoch: string;
  fence: string;
  nextOwnerKind: "feishu" | "dashboard" | "local-cli";
  bridgeRole: "current" | "next";
  status: "prepared" | "committed" | "cancelled" | "withdrawn" | "uncertain";
  drain: {
    disposition: "drained" | "cancelled";
    recordId: string;
    recordedAt: string;
  };
  completedAt?: string;
  error?: string;
}

export interface FeishuBinding {
  version: 1;
  id: string;
  chatId: string;
  chatName: string;
  controlTargetId: string;
  backendBirthId?: string;
  sessionName: string;
  status: FeishuBindingStatus;
  options: {
    mentionOnly: boolean;
    replyAsCard: boolean;
    includeQuotedContext: boolean;
    replyMode: FeishuReplyMode;
  };
  allowedSenderIds: string[];
  createdAt: string;
  createdBy: string;
  sessionSummary?: string;
  activityWatch?: FeishuActivityWatch;
  lastActivityAt?: string;
  staleReason?: string;
  handoff?: FeishuHandoffRecord;
}

export type FeishuTurnStatus =
  | "prepared"
  | "awaiting"
  | "replying"
  | "completed"
  | "cancelled"
  | "timed-out"
  | "recovery-required";

export interface FeishuTurn {
  id: string;
  bindingId: string;
  chatId: string;
  eventId: string;
  messageId: string;
  senderId: string;
  status: FeishuTurnStatus;
  controlTargetId: string;
  controlEpoch: string;
  leaseId: string;
  fence: string;
  outputGeneration?: string;
  cursor?: number;
  markerNonce?: string;
  outputRemainderBase64?: string;
  output: string;
  operationId: string;
  outboundAttemptId: string;
  createdAt: string;
  deadlineAt: string;
  lastOutputAt?: string;
  markerSeenAt?: string;
  completedAt?: string;
  error?: string;
}

export interface FeishuOutboundReply {
  id: string;
  turnId: string;
  sourceMessageId: string;
  idempotencyKey: string;
  status: "prepared" | "sent" | "uncertain";
  textDigest: string;
  createdAt: string;
  deliveryKind?: "turn-reply" | "recovery-notice";
  text?: string;
  sessionName?: string;
  tone?: "answer" | "status";
  replyMode?: FeishuReplyMode;
  chatId?: string;
  finalTurnStatus?: "completed" | "timed-out";
  completedAt?: string;
  replyMessageId?: string;
  error?: string;
}

type StoredFeishuBinding = Omit<FeishuBinding, "options"> & {
  options: Omit<FeishuBinding["options"], "replyMode"> & {
    replyMode?: FeishuReplyMode;
  };
};

interface BindingsFile { version: 1; bindings: FeishuBinding[] }
interface StoredBindingsFile { version: 1; bindings: StoredFeishuBinding[] }
interface DedupFile { version: 1; eventIds: string[] }
interface TurnsFile { version: 1; turns: FeishuTurn[] }
interface RepliesFile { version: 1; replies: FeishuOutboundReply[] }

interface FeishuBridgeStorageLock {
  path: string;
  owner: string;
}

interface FeishuBridgeStorageLockOwner {
  owner: string;
  pid: number;
  createdAt: number;
}

const FEISHU_STORAGE_LOCK_WAIT_MS = 5_000;
const FEISHU_STORAGE_LOCK_STALE_MS = 60_000;

export interface FeishuBridgePaths {
  root: string;
  bindings: string;
  dedup: string;
  turns: string;
  replies: string;
  lock: string;
  socket: string;
  instanceLock: string;
}

export function feishuBridgePaths(home = homedir()): FeishuBridgePaths {
  const root = join(home, ".tmux-worktree");
  return {
    root,
    bindings: join(root, "feishu-bindings.json"),
    dedup: join(root, "feishu-event-dedup.json"),
    turns: join(root, "feishu-turns.json"),
    replies: join(root, "feishu-outbound-replies.json"),
    lock: join(root, "feishu-bridge-storage.lock"),
    socket: feishuBridgeSocketPath(home),
    instanceLock: join(root, "feishu-bridge-v1.lock"),
  };
}

export function feishuBridgeSocketPath(home = homedir()): string {
  const preferred = join(home, ".tmux-worktree", "feishu-bridge-v1.sock");
  if (Buffer.byteLength(preferred, "utf8") <= 100) return preferred;
  const homeHash = createHash("sha256").update(home, "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), `tw-feishu-bridge-${homeHash}`, "v1.sock");
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

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isBinding(value: unknown): value is StoredFeishuBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "id", "chatId", "chatName", "controlTargetId",
    "sessionName", "status", "options", "allowedSenderIds", "createdAt", "createdBy",
  ], [
    "backendBirthId", "sessionSummary", "activityWatch", "lastActivityAt", "staleReason", "handoff",
  ])) return false;
  if (value.version !== 1 || !isSafeText(value.id) || !isSafeText(value.chatId)
    || !isSafeText(value.chatName) || !isSafeText(value.controlTargetId)
    || (value.backendBirthId !== undefined && !isSafeText(value.backendBirthId))
    || !isSafeText(value.sessionName)
    || !isSafeText(value.createdBy) || !isIso(value.createdAt)) return false;
  if (value.status !== "active" && value.status !== "pausing"
    && value.status !== "paused" && value.status !== "stale") return false;
  if (!isRecord(value.options) || !exactKeys(value.options, [
    "mentionOnly", "replyAsCard", "includeQuotedContext",
  ], ["replyMode"]) || typeof value.options.mentionOnly !== "boolean"
    || typeof value.options.replyAsCard !== "boolean"
    || typeof value.options.includeQuotedContext !== "boolean"
    || (value.options.replyMode !== undefined
      && value.options.replyMode !== "topic"
      && value.options.replyMode !== "direct")) return false;
  return Array.isArray(value.allowedSenderIds)
    && value.allowedSenderIds.every((item) => isSafeText(item))
    && (value.sessionSummary === undefined || isSafeText(value.sessionSummary))
    && (value.activityWatch === undefined || isActivityWatch(value.activityWatch))
    && (value.lastActivityAt === undefined || isIso(value.lastActivityAt))
    && (value.staleReason === undefined || isSafeText(value.staleReason))
    && (value.handoff === undefined || isHandoffRecord(value.handoff));
}

function isCanonicalBinding(value: unknown): value is FeishuBinding {
  return isBinding(value) && value.options.replyMode !== undefined;
}

function isHandoffRecord(value: unknown): value is FeishuHandoffRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "handoffId", "controlEpoch", "fence", "nextOwnerKind", "bridgeRole",
    "status", "drain",
  ], ["completedAt", "error"])) return false;
  if (![value.handoffId, value.controlEpoch].every((item) => isSafeText(item))
    || !isDecimal(value.fence)
    || !["feishu", "dashboard", "local-cli"].includes(String(value.nextOwnerKind))
    || (value.bridgeRole !== "current" && value.bridgeRole !== "next")
    || !["prepared", "committed", "cancelled", "withdrawn", "uncertain"].includes(String(value.status))
    || !isRecord(value.drain)
    || !exactKeys(value.drain, ["disposition", "recordId", "recordedAt"])
    || (value.drain.disposition !== "drained" && value.drain.disposition !== "cancelled")
    || !isSafeText(value.drain.recordId)
    || !isIso(value.drain.recordedAt)) return false;
  return (value.completedAt === undefined || isIso(value.completedAt))
    && (value.error === undefined || isSafeText(value.error, 4096));
}

function isActivityWatch(value: unknown): value is FeishuActivityWatch {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "status", "controlEpoch", "leaseId", "fence", "outputGeneration", "createdAt",
  ], [
    "source", "observedRunningAt", "stopCandidateAt", "completedAt", "messageId", "error",
  ])) return false;
  const statuses: FeishuActivityWatchStatus[] = [
    "probing", "armed", "stop-candidate", "sending", "sent", "uncertain", "cancelled",
    "recovery-required",
  ];
  const fieldsValid = [value.id, value.controlEpoch, value.leaseId, value.outputGeneration]
    .every((item) => isSafeText(item))
    && statuses.includes(value.status as FeishuActivityWatchStatus)
    && isDecimal(value.fence)
    && isIso(value.createdAt)
    && (value.source === undefined || isAgentSource(value.source))
    && [value.observedRunningAt, value.stopCandidateAt, value.completedAt]
      .every((item) => item === undefined || isIso(item))
    && (value.messageId === undefined || isSafeText(value.messageId))
    && (value.error === undefined || isSafeText(value.error, 4096));
  if (!fieldsValid) return false;

  const status = value.status as FeishuActivityWatchStatus;
  const runningWasObserved = value.observedRunningAt !== undefined;
  const stopWasObserved = value.stopCandidateAt !== undefined;
  const hasCompletedAt = value.completedAt !== undefined;
  const hasError = value.error !== undefined;
  if ((status === "armed" || status === "stop-candidate" || status === "sending" || status === "sent")
    && !runningWasObserved) return false;
  if ((status === "armed" || status === "stop-candidate" || status === "sending" || status === "sent")
    && value.source === undefined) return false;
  if ((status === "stop-candidate" || status === "sending" || status === "sent")
    && !stopWasObserved) return false;
  if ((status === "sending" || status === "sent" || status === "uncertain"
      || status === "cancelled" || status === "recovery-required")
    !== hasCompletedAt) return false;
  if ((status === "uncertain" || status === "cancelled" || status === "recovery-required")
    !== hasError) return false;
  if (status !== "sent" && value.messageId !== undefined) return false;
  return true;
}

function isAgentSource(value: unknown): value is TerminalControlAgentSource {
  if (!isRecord(value) || !exactKeys(
    value,
    ["provider", "boundary", "sourceId", "sessionId", "turnId", "startedAt"],
  )) return false;
  return (value.provider === "claude" || value.provider === "codex")
    && (value.boundary === "after" || value.boundary === "inclusive" || value.boundary === "exact")
    && typeof value.sourceId === "string"
    && /^[0-9a-f]{64}$/u.test(value.sourceId)
    && isSafeText(value.sessionId)
    && isSafeText(value.turnId)
    && isIso(value.startedAt);
}

function isCanonicalBase64(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength <= maxBytes && decoded.toString("base64") === value;
}

function isTurn(value: unknown): value is FeishuTurn {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "bindingId", "chatId", "eventId", "messageId", "senderId", "status",
    "controlTargetId", "controlEpoch", "leaseId", "fence", "output",
    "operationId", "outboundAttemptId", "createdAt", "deadlineAt",
  ], [
    "outputGeneration", "cursor", "markerNonce", "outputRemainderBase64",
    "lastOutputAt", "markerSeenAt", "completedAt", "error",
  ])) return false;
  const statuses: FeishuTurnStatus[] = [
    "prepared", "awaiting", "replying", "completed", "cancelled", "timed-out", "recovery-required",
  ];
  return [
    value.id, value.bindingId, value.chatId, value.eventId, value.messageId, value.senderId,
    value.controlTargetId, value.controlEpoch, value.leaseId,
    value.operationId, value.outboundAttemptId,
  ].every((item) => isSafeText(item))
    && statuses.includes(value.status as FeishuTurnStatus)
    && isDecimal(value.fence)
    && (value.outputGeneration === undefined || isSafeText(value.outputGeneration))
    && (value.cursor === undefined || (Number.isSafeInteger(value.cursor) && (value.cursor as number) >= 0))
    && (value.markerNonce === undefined || isSafeText(value.markerNonce, 128))
    && (value.outputRemainderBase64 === undefined || isCanonicalBase64(value.outputRemainderBase64, 3))
    && ((value.outputGeneration === undefined) === (value.cursor === undefined))
    && (!["awaiting", "replying", "completed", "timed-out"].includes(String(value.status))
      || (value.outputGeneration !== undefined && value.cursor !== undefined))
    && typeof value.output === "string" && Buffer.byteLength(value.output, "utf8") <= 128 * 1024
    && isIso(value.createdAt) && isIso(value.deadlineAt)
    && [value.lastOutputAt, value.markerSeenAt, value.completedAt]
      .every((item) => item === undefined || isIso(item))
    && (value.error === undefined || isSafeText(value.error, 4096));
}

function storageLockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function readStorageLockOwner(lockPath: string): FeishuBridgeStorageLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(storageLockOwnerPath(lockPath), "utf8")) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["owner", "pid", "createdAt"])) return undefined;
    if (!isSafeText(value.owner) || !Number.isSafeInteger(value.pid) || !Number.isFinite(value.createdAt)) {
      return undefined;
    }
    return value as unknown as FeishuBridgeStorageLockOwner;
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
    return Date.now() - owner.createdAt > FEISHU_STORAGE_LOCK_STALE_MS && !processExists(owner.pid);
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > FEISHU_STORAGE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function waitForStorageLock(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireFeishuBridgeStorageLock(lockPath: string): FeishuBridgeStorageLock {
  const deadline = Date.now() + FEISHU_STORAGE_LOCK_WAIT_MS;
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
        } satisfies FeishuBridgeStorageLockOwner)}\n`, { flag: "wx", mode: 0o600 });
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
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Feishu bridge storage lock: ${lockPath}`);
      waitForStorageLock(20);
    }
  }
}

function releaseFeishuBridgeStorageLock(lock: FeishuBridgeStorageLock): void {
  if (readStorageLockOwner(lock.path)?.owner !== lock.owner) return;
  rmSync(lock.path, { recursive: true, force: true });
}

function isReply(value: unknown): value is FeishuOutboundReply {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "turnId", "sourceMessageId", "idempotencyKey", "status", "textDigest", "createdAt",
  ], [
    "deliveryKind", "text", "sessionName", "tone", "replyMode", "chatId",
    "finalTurnStatus", "completedAt", "replyMessageId", "error",
  ])) return false;
  const durablePayloadFields = [
    value.text,
    value.sessionName,
    value.tone,
    value.deliveryKind,
  ];
  const hasAnyDurablePayload = durablePayloadFields.some((item) => item !== undefined)
    || value.replyMode !== undefined
    || value.chatId !== undefined
    || value.finalTurnStatus !== undefined;
  const validDurablePayload = value.deliveryKind === "turn-reply"
    ? isSafeText(value.text, 16 * 1024)
      && isSafeText(value.sessionName)
      && (value.replyMode === "topic" || value.replyMode === "direct")
      && (value.finalTurnStatus === "completed" || value.finalTurnStatus === "timed-out")
      && value.tone === (value.finalTurnStatus === "completed" ? "answer" : "status")
      && value.chatId === undefined
    : value.deliveryKind === "recovery-notice"
      ? isSafeText(value.text, 16 * 1024)
        && isSafeText(value.sessionName)
        && value.tone === "status"
        && isSafeText(value.chatId)
        && value.replyMode === undefined
        && value.finalTurnStatus === undefined
      : false;
  return [value.id, value.turnId, value.sourceMessageId, value.idempotencyKey, value.textDigest]
    .every((item) => isSafeText(item))
    && (value.status === "prepared" || value.status === "sent" || value.status === "uncertain")
    && isIso(value.createdAt)
    && (!hasAnyDurablePayload || validDurablePayload)
    && (value.completedAt === undefined || isIso(value.completedAt))
    && (value.replyMessageId === undefined || isSafeText(value.replyMessageId))
    && (value.error === undefined || isSafeText(value.error, 4096));
}

function loadFile<T>(path: string, empty: T, validate: (value: unknown) => value is T): T {
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`refusing invalid Feishu bridge state ${path}; original preserved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(parsed)) throw new Error(`refusing malformed Feishu bridge state ${path}; original preserved`);
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

function validateStoredBindings(value: unknown): value is StoredBindingsFile {
  return isRecord(value) && exactKeys(value, ["version", "bindings"])
    && value.version === 1 && Array.isArray(value.bindings) && value.bindings.every(isBinding);
}
function validateBindings(value: unknown): value is BindingsFile {
  return isRecord(value) && exactKeys(value, ["version", "bindings"])
    && value.version === 1 && Array.isArray(value.bindings)
    && value.bindings.every(isCanonicalBinding);
}
function validateDedup(value: unknown): value is DedupFile {
  return isRecord(value) && exactKeys(value, ["version", "eventIds"])
    && value.version === 1 && Array.isArray(value.eventIds)
    && value.eventIds.length <= FEISHU_EVENT_DEDUP_LIMIT
    && value.eventIds.every((item) => isSafeText(item));
}
function validateTurns(value: unknown): value is TurnsFile {
  return isRecord(value) && exactKeys(value, ["version", "turns"])
    && value.version === 1 && Array.isArray(value.turns)
    && value.turns.length <= FEISHU_TURN_HISTORY_LIMIT && value.turns.every(isTurn);
}
function validateReplies(value: unknown): value is RepliesFile {
  return isRecord(value) && exactKeys(value, ["version", "replies"])
    && value.version === 1 && Array.isArray(value.replies)
    && value.replies.length <= FEISHU_REPLY_HISTORY_LIMIT && value.replies.every(isReply);
}

export class FeishuBridgeStore {
  readonly paths: FeishuBridgePaths;

  constructor(paths = feishuBridgePaths()) {
    this.paths = paths;
  }

  read(): {
    bindings: FeishuBinding[];
    eventIds: string[];
    turns: FeishuTurn[];
    replies: FeishuOutboundReply[];
  } {
    const lock = acquireFeishuBridgeStorageLock(this.paths.lock);
    try {
      return {
        bindings: loadFile(
          this.paths.bindings,
          { version: 1, bindings: [] } as StoredBindingsFile,
          validateStoredBindings,
        ).bindings.map((binding): FeishuBinding => ({
          ...binding,
          options: {
            ...binding.options,
            replyMode: binding.options.replyMode ?? "topic",
          },
        })),
        eventIds: loadFile(this.paths.dedup, { version: 1, eventIds: [] } as DedupFile, validateDedup).eventIds,
        turns: loadFile(this.paths.turns, { version: 1, turns: [] } as TurnsFile, validateTurns).turns,
        replies: loadFile(this.paths.replies, { version: 1, replies: [] } as RepliesFile, validateReplies).replies,
      };
    } finally {
      releaseFeishuBridgeStorageLock(lock);
    }
  }

  write(state: {
    bindings: FeishuBinding[];
    eventIds: string[];
    turns: FeishuTurn[];
    replies: FeishuOutboundReply[];
  }): void {
    const bindings = { version: 1, bindings: state.bindings } satisfies BindingsFile;
    const dedup = { version: 1, eventIds: state.eventIds.slice(-FEISHU_EVENT_DEDUP_LIMIT) } satisfies DedupFile;
    const turns = { version: 1, turns: state.turns.slice(-FEISHU_TURN_HISTORY_LIMIT) } satisfies TurnsFile;
    const replies = { version: 1, replies: state.replies.slice(-FEISHU_REPLY_HISTORY_LIMIT) } satisfies RepliesFile;
    if (!validateBindings(bindings) || !validateDedup(dedup)
      || !validateTurns(turns) || !validateReplies(replies)) {
      throw new Error("refusing to persist malformed Feishu bridge state");
    }
    const lock = acquireFeishuBridgeStorageLock(this.paths.lock);
    try {
      atomicWrite(this.paths.bindings, bindings);
      atomicWrite(this.paths.dedup, dedup);
      atomicWrite(this.paths.turns, turns);
      atomicWrite(this.paths.replies, replies);
    } finally {
      releaseFeishuBridgeStorageLock(lock);
    }
  }
}
