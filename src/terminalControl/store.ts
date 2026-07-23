import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  TerminalControlDrainProof,
  TerminalControlLease,
  TerminalControlOwner,
} from "./protocol";
import { TerminalControlProtocolError } from "./protocol";

export const TERMINAL_CONTROL_STATE_VERSION = 1 as const;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const ACTIVE_STORE_LOCKS = new WeakSet<object>();

export type TerminalTargetLifecycle = "ACTIVE" | "RECOVERY_REQUIRED" | "TARGET_GONE";

export type TerminalControlRecoveryReason =
  | "CONTROLLER_RESTARTED"
  | "LEASE_EXPIRED"
  | "OPERATION_IN_DOUBT"
  | "DRAIN_UNCERTAIN"
  | "BACKEND_IDENTITY_UNCERTAIN"
  | "OUTPUT_CONTINUITY_UNCERTAIN";

export interface TerminalControlRecoveryRecord {
  reason: TerminalControlRecoveryReason;
  since: string;
  previousControlEpoch: string;
  previousOwnerKind?: TerminalControlOwner["kind"];
  operationId?: string;
}

export interface TerminalControlOperationRecord {
  operationId: string;
  ownerInstanceId: string;
  fence: string;
  payloadHash: string;
  kind: "raw" | "agent-message" | "resize" | "scroll" | "lifecycle-kill";
  disposition: "committed" | "in-doubt";
  outputGeneration?: string;
  outputCursor?: number;
  completedAt: string;
}

export interface TerminalControlInFlightOperation {
  operationId: string;
  ownerInstanceId: string;
  fence: string;
  payloadHash: string;
  kind: "raw" | "agent-message" | "resize" | "scroll" | "lifecycle-kill";
  outputGeneration?: string;
  outputCursor?: number;
  startedAt: string;
}

export interface TerminalControlHandoff {
  handoffId: string;
  nextOwner: TerminalControlOwner;
  requestedAt: string;
  drain?: TerminalControlDrainProof;
}

export type TerminalControlOwnership =
  | { state: "FREE"; fence: string }
  | {
      state: "HELD";
      fence: string;
      owner: TerminalControlOwner;
      leaseId: string;
      leaseExpiresAt: string;
    }
  | {
      state: "DRAINING";
      fence: string;
      owner: TerminalControlOwner;
      leaseId: string;
      leaseExpiresAt: string;
      handoff: TerminalControlHandoff;
    };

export interface TerminalControlTargetRecord {
  controlTargetId: string;
  lifecycle: TerminalTargetLifecycle;
  managedSession: {
    name: string;
    kind: "worktree" | "terminal";
    createdAt: string;
  };
  backend: {
    kind: "tmux";
    tmuxInstanceId: string;
  };
  outputGeneration: string;
  ownership: TerminalControlOwnership;
  revision: string;
  inFlight?: TerminalControlInFlightOperation;
  recovery?: TerminalControlRecoveryRecord;
  completedOperations: TerminalControlOperationRecord[];
  updatedAt: string;
}

export interface TerminalControlState {
  version: typeof TERMINAL_CONTROL_STATE_VERSION;
  controlEpoch: string;
  targets: TerminalControlTargetRecord[];
}

export interface TerminalControlStoreLock {
  path: string;
  owner: string;
}

type LockOwner = { owner: string; pid: number; createdAt: number };

export function terminalControlHome(home = homedir()): string {
  return join(home, ".tmux-worktree");
}

export function terminalControlStatePath(home = homedir()): string {
  return process.env.TW_TERMINAL_CONTROL_STATE?.trim()
    || join(terminalControlHome(home), "terminal-control-state-v1.json");
}

export function terminalControlSocketPath(home = homedir()): string {
  const configured = process.env.TW_TERMINAL_CONTROL_SOCKET?.trim();
  if (configured) return configured;
  const preferred = join(terminalControlHome(home), "terminal-control-v1.sock");
  if (Buffer.byteLength(preferred, "utf8") <= 100) return preferred;
  const homeHash = createHash("sha256").update(home, "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), `tw-terminal-control-${homeHash}`, "v1.sock");
}

export function terminalControlOwnsSocketDirectory(path: string, home = homedir()): boolean {
  if (process.env.TW_TERMINAL_CONTROL_SOCKET?.trim()) return false;
  return path === terminalControlSocketPath(home);
}

export function emptyTerminalControlState(): TerminalControlState {
  return {
    version: TERMINAL_CONTROL_STATE_VERSION,
    controlEpoch: randomUUID(),
    targets: [],
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

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

function isStoredString(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\0\r\n]/.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isOwner(value: unknown): value is TerminalControlOwner {
  if (!isRecord(value) || !exactKeys(value, ["kind", "instanceId"])) return false;
  return ["feishu", "dashboard", "local-cli", "relay-v1", "relay-v2", "tw-serve"].includes(String(value.kind))
    && isStoredString(value.instanceId, 256);
}

function isOwnership(value: unknown): value is TerminalControlOwnership {
  if (!isRecord(value) || !isDecimal(value.fence)) return false;
  if (value.state === "FREE") return exactKeys(value, ["state", "fence"]);
  if (value.state === "HELD") {
    return exactKeys(value, ["state", "fence", "owner", "leaseId", "leaseExpiresAt"])
      && isOwner(value.owner)
      && isStoredString(value.leaseId, 128)
      && isCanonicalTimestamp(value.leaseExpiresAt);
  }
  if (value.state !== "DRAINING") return false;
  if (!exactKeys(value, ["state", "fence", "owner", "leaseId", "leaseExpiresAt", "handoff"])) return false;
  if (
    !isOwner(value.owner)
    || !isStoredString(value.leaseId, 128)
    || !isCanonicalTimestamp(value.leaseExpiresAt)
  ) return false;
  const handoff = value.handoff;
  return isRecord(handoff)
    && exactKeys(handoff, ["handoffId", "nextOwner", "requestedAt"], ["drain"])
    && isStoredString(handoff.handoffId, 128)
    && isOwner(handoff.nextOwner)
    && isCanonicalTimestamp(handoff.requestedAt)
    && (handoff.drain === undefined || isDrainProof(handoff.drain));
}

function isDrainProof(value: unknown): value is TerminalControlDrainProof {
  return isRecord(value)
    && exactKeys(value, ["disposition", "recordId", "recordedAt"])
    && ["drained", "cancelled", "uncertain"].includes(String(value.disposition))
    && isStoredString(value.recordId, 192)
    && isCanonicalTimestamp(value.recordedAt);
}

function isOperation(value: unknown, inFlight: boolean): boolean {
  if (!isRecord(value)) return false;
  const timeKey = inFlight ? "startedAt" : "completedAt";
  return exactKeys(
    value,
    ["operationId", "ownerInstanceId", "fence", "payloadHash", "kind", timeKey],
    inFlight ? ["outputGeneration", "outputCursor"] : ["disposition", "outputGeneration", "outputCursor"],
  )
    && isStoredString(value.operationId, 192)
    && isStoredString(value.ownerInstanceId, 256)
    && isDecimal(value.fence)
    && typeof value.payloadHash === "string"
    && /^[a-f0-9]{64}$/.test(value.payloadHash)
    && ["raw", "agent-message", "resize", "scroll", "lifecycle-kill"].includes(String(value.kind))
    && isCanonicalTimestamp(value[timeKey])
    && (inFlight || value.disposition === "committed" || value.disposition === "in-doubt")
    && (value.outputGeneration === undefined || isStoredString(value.outputGeneration, 128))
    && (value.outputCursor === undefined || (Number.isSafeInteger(value.outputCursor) && (value.outputCursor as number) >= 0));
}

function isRecovery(value: unknown): value is TerminalControlRecoveryRecord {
  if (!isRecord(value) || !exactKeys(
    value,
    ["reason", "since", "previousControlEpoch"],
    ["previousOwnerKind", "operationId"],
  )) return false;
  return [
    "CONTROLLER_RESTARTED",
    "LEASE_EXPIRED",
    "OPERATION_IN_DOUBT",
    "DRAIN_UNCERTAIN",
    "BACKEND_IDENTITY_UNCERTAIN",
    "OUTPUT_CONTINUITY_UNCERTAIN",
  ].includes(String(value.reason))
    && isCanonicalTimestamp(value.since)
    && isStoredString(value.previousControlEpoch, 128)
    && (value.previousOwnerKind === undefined || ["feishu", "dashboard", "local-cli", "relay-v1", "relay-v2", "tw-serve"].includes(String(value.previousOwnerKind)))
    && (value.operationId === undefined || isStoredString(value.operationId, 192));
}

function isTarget(value: unknown): value is TerminalControlTargetRecord {
  if (!isRecord(value)) return false;
  if (!exactKeys(
    value,
    ["controlTargetId", "lifecycle", "managedSession", "backend", "outputGeneration", "ownership", "revision", "completedOperations", "updatedAt"],
    ["inFlight", "recovery"],
  )) return false;
  if (!isStoredString(value.controlTargetId, 128)) return false;
  if (!["ACTIVE", "RECOVERY_REQUIRED", "TARGET_GONE"].includes(String(value.lifecycle))) return false;
  if (!isRecord(value.managedSession) || !exactKeys(value.managedSession, ["name", "kind", "createdAt"])) return false;
  if (!isStoredString(value.managedSession.name, 128)) return false;
  if (value.managedSession.kind !== "worktree" && value.managedSession.kind !== "terminal") return false;
  if (!isCanonicalTimestamp(value.managedSession.createdAt)) return false;
  if (!isRecord(value.backend) || !exactKeys(value.backend, ["kind", "tmuxInstanceId"])) return false;
  if (value.backend.kind !== "tmux" || !isStoredString(value.backend.tmuxInstanceId, 128)) return false;
  if (!isStoredString(value.outputGeneration, 128)) return false;
  if (!isOwnership(value.ownership) || !isDecimal(value.revision)) return false;
  if (!Array.isArray(value.completedOperations) || value.completedOperations.some((item) => !isOperation(item, false))) return false;
  if (value.inFlight !== undefined && !isOperation(value.inFlight, true)) return false;
  const operationIds = new Set((value.completedOperations as TerminalControlOperationRecord[]).map((item) => item.operationId));
  if (operationIds.size !== value.completedOperations.length) return false;
  if (value.inFlight !== undefined && operationIds.has((value.inFlight as TerminalControlInFlightOperation).operationId)) return false;
  if (value.recovery !== undefined && !isRecovery(value.recovery)) return false;
  if (value.lifecycle === "RECOVERY_REQUIRED" && value.recovery === undefined) return false;
  if (value.lifecycle !== "RECOVERY_REQUIRED" && value.recovery !== undefined) return false;
  if (value.lifecycle !== "ACTIVE" && value.ownership.state !== "FREE") return false;
  return isCanonicalTimestamp(value.updatedAt);
}

export function parseTerminalControlState(value: unknown): TerminalControlState {
  if (!isRecord(value) || !exactKeys(value, ["version", "controlEpoch", "targets"])) {
    throw new Error("terminal-control state root is malformed");
  }
  if (value.version !== TERMINAL_CONTROL_STATE_VERSION) {
    throw new Error(`unsupported terminal-control state version: ${String(value.version)}`);
  }
  if (!isStoredString(value.controlEpoch, 128)) {
    throw new Error("terminal-control state controlEpoch is malformed");
  }
  if (!Array.isArray(value.targets) || value.targets.some((target) => !isTarget(target))) {
    throw new Error("terminal-control state targets are malformed");
  }
  const ids = new Set<string>();
  for (const target of value.targets as TerminalControlTargetRecord[]) {
    if (ids.has(target.controlTargetId)) throw new Error("terminal-control state contains duplicate target IDs");
    ids.add(target.controlTargetId);
  }
  return value as unknown as TerminalControlState;
}

export function loadTerminalControlState(path = terminalControlStatePath()): TerminalControlState {
  if (!existsSync(path)) return emptyTerminalControlState();
  try {
    return parseTerminalControlState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `refusing to use invalid terminal-control state ${path}; original file preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fsyncDirectory(path: string): void {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `terminal-control directory is not a private real directory: ${path}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

export function saveTerminalControlState(
  state: TerminalControlState,
  path = terminalControlStatePath(),
): void {
  const validated = parseTerminalControlState(state);
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd = -1;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const contents = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < contents.byteLength) {
      offset += writeSync(fd, contents, offset, contents.byteLength - offset, offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

function lockOwnerPath(path: string): string {
  return join(path, LOCK_OWNER_FILE);
}

function readLockOwner(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(lockOwnerPath(path), "utf8")) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["owner", "pid", "createdAt"])) return undefined;
    if (typeof value.owner !== "string" || !Number.isSafeInteger(value.pid) || !Number.isFinite(value.createdAt)) return undefined;
    return value as unknown as LockOwner;
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

function lockIsStale(path: string): boolean {
  const owner = readLockOwner(path);
  if (owner) return Date.now() - owner.createdAt > LOCK_STALE_MS && !processExists(owner.pid);
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function discardStaleLock(path: string): void {
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!lockIsStale(quarantine)) {
    try {
      renameSync(quarantine, path);
    } catch {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "terminal-control lock changed while stale recovery was being claimed",
        true,
      );
    }
    return;
  }
  rmSync(quarantine, { recursive: true, force: true });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireTerminalControlStoreLock(
  lockPath = `${terminalControlStatePath()}.lock`,
): Promise<TerminalControlStoreLock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const owner = `${process.pid}-${randomUUID()}`;
  ensurePrivateDirectory(dirname(lockPath));
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const record: LockOwner = { owner, pid: process.pid, createdAt: Date.now() };
      try {
        writeFileSync(lockOwnerPath(lockPath), `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      const lock = Object.freeze({ path: lockPath, owner });
      ACTIVE_STORE_LOCKS.add(lock);
      return lock;
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      if (lockIsStale(lockPath)) {
        discardStaleLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new TerminalControlProtocolError(
          "RESOURCE_EXHAUSTED",
          `timed out waiting for terminal-control state lock: ${lockPath}`,
          true,
        );
      }
      await delay(25);
    }
  }
}

export function releaseTerminalControlStoreLock(lock: TerminalControlStoreLock): void {
  if (!lock || !ACTIVE_STORE_LOCKS.has(lock as object)) return;
  ACTIVE_STORE_LOCKS.delete(lock as object);
  const current = readLockOwner(lock.path);
  if (current?.owner !== lock.owner) return;
  rmSync(lock.path, { recursive: true, force: true });
}

/** Process-local proof that the exact acquired lock object still owns its path. */
export function isTerminalControlStoreLockAuthorityCurrent(
  lock: TerminalControlStoreLock,
  expectedPath: string,
): boolean {
  if (!lock
    || !ACTIVE_STORE_LOCKS.has(lock as object)
    || lock.path !== expectedPath) return false;
  const current = readLockOwner(lock.path);
  return current?.owner === lock.owner && current.pid === process.pid;
}

export function leaseFromTarget(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
): TerminalControlLease {
  if (target.ownership.state === "FREE") {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "target has no input owner");
  }
  return {
    controlTargetId: target.controlTargetId,
    controlEpoch: state.controlEpoch,
    leaseId: target.ownership.leaseId,
    fence: target.ownership.fence,
    owner: target.ownership.owner,
    expiresAt: target.ownership.leaseExpiresAt,
  };
}

export function nextDecimal(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

export function sameOwner(left: TerminalControlOwner, right: TerminalControlOwner): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}
