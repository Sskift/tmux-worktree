import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, rmSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { TerminalControlRequestInput } from "../../terminalControl/client.js";
import {
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  TERMINAL_CONTROL_ERROR_CODES,
  TerminalControlProtocolError,
  parseTerminalControlRequest,
  type TerminalControlLease,
  type TerminalControlOwner,
  type TerminalControlRequest,
} from "../../terminalControl/protocol.js";
import type {
  TerminalControlAuthority,
  TerminalControlRelayV2ExactTargetAuthorityPort,
} from "../../terminalControl/authority.js";
import {
  isTerminalControlStoreLockAuthorityCurrent,
  terminalControlSocketPath,
  type TerminalControlStoreLock,
} from "../../terminalControl/store.js";
import type {
  RelayV2ExactTerminalControlTargetEvidenceV1,
  RelayV2ExactTerminalControlTargetInputV1,
  RelayV2PreparedExactTerminalControlLeasePortV1,
} from "./canonicalTerminalTargetResolverAdapter.js";
import type { RelayV2TerminalCanonicalTargetBindingV1 } from "./terminalManager.js";
import type { RelayV2TerminalControlRequestPort } from "./terminalControlAuthorityAdapter.js";
import { RelayV2TerminalControlExactTargetAuthorityAdapter } from "./terminalControlExactTargetAuthorityAdapter.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
} from "./strictJson.js";

export const RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION = 1 as const;
export const RELAY_V2_REMOTE_EXACT_COMPOUND_ENTRYPOINT = "rpc-v2-remote-exact-v1" as const;
export const RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES = 384 * 1024;

const MAX_ACTIVE_CHANNELS = 256;
const JSON_LIMITS = Object.freeze({
  maxDepth: 20,
  maxDirectKeys: 64,
  maxTotalKeys: 512,
  maxNodes: 4_096,
});

export type RelayV2ExactCompoundProcessTargetV1 = Readonly<{
  kind: "local" | "ssh";
  targetId: string;
}>;

export interface RelayV2RemoteExactCompoundChannelV1 {
  request(frame: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export interface RelayV2RemoteExactCompoundChannelFactoryV1 {
  open(
    processTarget: RelayV2ExactCompoundProcessTargetV1,
  ): Promise<RelayV2RemoteExactCompoundChannelV1>;
}

export interface RelayV2RemoteExactCompoundAuthorityOwnerV1 {
  readonly authority: TerminalControlAuthority;
  readonly exactAuthority?: TerminalControlRelayV2ExactTargetAuthorityPort;
  close(): Promise<void>;
}

export interface RelayV2RemoteExactCompoundServerOptionsV1 {
  source: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): Promise<void>;
  openOwner(
    processTarget: RelayV2ExactCompoundProcessTargetV1,
  ): Promise<RelayV2RemoteExactCompoundAuthorityOwnerV1>;
}

export interface RelayV2RemoteExactTerminalControlCompoundAdapterOptionsV1 {
  channels: RelayV2RemoteExactCompoundChannelFactoryV1;
  owner: TerminalControlOwner & { kind: "relay-v2" };
}

interface HostRecord {
  readonly input: RelayV2ExactTerminalControlTargetInputV1;
  readonly inputJson: string;
  evidence: RelayV2ExactTerminalControlTargetEvidenceV1;
  readonly channel: RelayV2RemoteExactCompoundChannelV1;
  state: "prepared" | "admitted" | "consumed" | "observing" | "closed";
  lease: TerminalControlLease | null;
  observation: RelayV2ExactCompoundObservationBindingV1 | null;
}

export interface RelayV2ExactCompoundObservationBindingV1 {
  schemaVersion: 1;
  controlTargetId: string;
  controlEpoch: string;
  targetIncarnationProof: string;
  outputGeneration: string;
  outputCursor: number;
}

export interface RelayV2ExactCompoundObservationTailV1 {
  controlEpoch: string;
  outputGeneration: string;
  cursor: number;
  dataBase64: string;
  nextCursor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function bounded(value: unknown, maxBytes = 256): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound identity is invalid");
  }
  return value;
}

function owner(value: unknown): TerminalControlOwner & { kind: "relay-v2" } {
  if (!isRecord(value)
    || !exactKeys(value, ["kind", "instanceId"])
    || value.kind !== "relay-v2") {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound owner is invalid");
  }
  return { kind: "relay-v2", instanceId: bounded(value.instanceId) };
}

function sameOwner(left: TerminalControlOwner, right: TerminalControlOwner): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}

function processTarget(value: unknown): RelayV2ExactCompoundProcessTargetV1 {
  if (!isRecord(value)
    || !exactKeys(value, ["kind", "targetId"])
    || (value.kind !== "local" && value.kind !== "ssh")) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "remote exact compound authority requires an exact process target",
    );
  }
  return Object.freeze({ kind: value.kind, targetId: bounded(value.targetId, 128) });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function terminalBinding(
  input: RelayV2ExactTerminalControlTargetInputV1,
  identity: RelayV2ExactTerminalControlTargetEvidenceV1["exactControlIdentity"],
): RelayV2TerminalCanonicalTargetBindingV1 {
  return {
    ...clone(input),
    exactControlIdentity: clone(identity),
  };
}

function lease(value: unknown): TerminalControlLease {
  if (!isRecord(value)
    || !exactKeys(value, [
      "controlTargetId", "controlEpoch", "leaseId", "fence", "owner", "expiresAt",
    ])) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound lease is malformed");
  }
  const parsedOwner = owner(value.owner);
  const expiresAt = bounded(value.expiresAt, 64);
  if (!/^(?:0|[1-9]\d*)$/.test(bounded(value.fence, 32))
    || !Number.isFinite(Date.parse(expiresAt))
    || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound lease is malformed");
  }
  return {
    controlTargetId: bounded(value.controlTargetId, 128),
    controlEpoch: bounded(value.controlEpoch, 128),
    leaseId: bounded(value.leaseId, 128),
    fence: value.fence as string,
    owner: parsedOwner,
    expiresAt,
  };
}

function identity(value: unknown): RelayV2ExactTerminalControlTargetEvidenceV1["exactControlIdentity"] {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || value.schemaVersion !== 1) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound identity is malformed");
  }
  return Object.freeze({
    schemaVersion: 1,
    controlTargetId: bounded(value.controlTargetId, 128),
    controlEpoch: bounded(value.controlEpoch, 128),
    targetIncarnationProof: bounded(value.targetIncarnationProof, 128),
  });
}

function observationBinding(value: unknown): RelayV2ExactCompoundObservationBindingV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
      "outputGeneration", "outputCursor",
    ])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.outputCursor)
    || (value.outputCursor as number) < 0) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound observation is malformed");
  }
  return Object.freeze({
    schemaVersion: 1,
    controlTargetId: bounded(value.controlTargetId, 128),
    controlEpoch: bounded(value.controlEpoch, 128),
    targetIncarnationProof: bounded(value.targetIncarnationProof, 128),
    outputGeneration: bounded(value.outputGeneration, 128),
    outputCursor: value.outputCursor as number,
  });
}

function observationTail(value: unknown): RelayV2ExactCompoundObservationTailV1 {
  if (!isRecord(value)
    || !exactKeys(value, ["controlEpoch", "outputGeneration", "cursor", "dataBase64", "nextCursor"])
    || !Number.isSafeInteger(value.cursor)
    || (value.cursor as number) < 0
    || !Number.isSafeInteger(value.nextCursor)
    || (value.nextCursor as number) < 0) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound observation tail is malformed");
  }
  const dataBase64 = value.dataBase64;
  if (typeof dataBase64 !== "string"
    || /[\0\r\n]/.test(dataBase64)
    || Buffer.byteLength(dataBase64, "utf8") > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound observation tail is malformed");
  }
  return Object.freeze({
    controlEpoch: bounded(value.controlEpoch, 128),
    outputGeneration: bounded(value.outputGeneration, 128),
    cursor: value.cursor as number,
    dataBase64,
    nextCursor: value.nextCursor as number,
  });
}

function observationCursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound tail cursor is invalid");
  }
  return value as number;
}

function observationMaxBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound tail bound is invalid");
  }
  return value as number;
}

function protocolError(value: unknown): TerminalControlProtocolError {
  if (!isRecord(value)
    || !exactKeys(value, ["code", "message", "retryable"])
    || typeof value.retryable !== "boolean") {
    return new TerminalControlProtocolError("INTERNAL", "remote exact compound rejection is malformed");
  }
  let code: string;
  let message: string;
  try {
    code = bounded(value.code, 64);
    message = bounded(value.message, 512);
  } catch {
    return new TerminalControlProtocolError("INTERNAL", "remote exact compound rejection is malformed");
  }
  if (!(TERMINAL_CONTROL_ERROR_CODES as readonly string[]).includes(code)) {
    return new TerminalControlProtocolError("INTERNAL", "remote exact compound rejection code is unknown");
  }
  return new TerminalControlProtocolError(
    code as ConstructorParameters<typeof TerminalControlProtocolError>[0],
    message,
    value.retryable,
  );
}

function responseResult(value: unknown): unknown {
  if (!isRecord(value)
    || !exactKeys(value, ["protocolVersion", "ok"], ["result", "error"])
    || value.protocolVersion !== RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION
    || typeof value.ok !== "boolean") {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound response is malformed");
  }
  if (value.ok === false) {
    if (!Object.hasOwn(value, "error") || Object.hasOwn(value, "result")) {
      throw new TerminalControlProtocolError("INTERNAL", "remote exact compound response is malformed");
    }
    throw protocolError(value.error);
  }
  if (!Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
    throw new TerminalControlProtocolError("INTERNAL", "remote exact compound response is malformed");
  }
  return value.result;
}

function errorPayload(error: unknown): Record<string, unknown> {
  const normalized = error instanceof TerminalControlProtocolError
    ? error
    : new TerminalControlProtocolError("INTERNAL", "remote exact compound authority failed");
  return {
    protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
    },
  };
}

function successPayload(result: unknown): Record<string, unknown> {
  return {
    protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
    ok: true,
    result,
  };
}

async function writeJson(
  write: (frame: Uint8Array) => Promise<void>,
  value: Record<string, unknown>,
): Promise<void> {
  await write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function* strictFrames(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  let buffer = Buffer.alloc(0);
  for await (const rawChunk of source) {
    if (!(rawChunk instanceof Uint8Array)) {
      throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound input is not bytes");
    }
    if (rawChunk.byteLength
      > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES - buffer.byteLength) {
      throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound frame is too large");
    }
    buffer = Buffer.concat([buffer, Buffer.from(rawChunk)]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.byteLength === 0 || frame.includes(0x0d)) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound frame is malformed");
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = parseRelayV2JsonObject(decodeRelayV2StrictUtf8(frame), JSON_LIMITS);
      } catch {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound JSON is malformed");
      }
      yield parsed;
    }
  }
  if (buffer.byteLength !== 0) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound frame is truncated");
  }
}

function effectRequest(value: unknown, activeLease: TerminalControlLease): TerminalControlRequest {
  if (!isRecord(value)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound effect is malformed");
  }
  const request = parseTerminalControlRequest({
    ...value,
    protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
    requestId: `relay-v2-remote-${randomUUID()}`,
  });
  const allowed = new Set([
    "ownership.status", "lease.renew", "lease.release",
    "input.raw", "input.agent-message", "input.resize",
  ]);
  if (!allowed.has(request.type)) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound effect is not allowed");
  }
  if (request.type === "ownership.status") {
    if (request.controlTargetId !== activeLease.controlTargetId) {
      throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound target changed");
    }
  } else if (!Object.hasOwn(request, "lease")
    || canonicalJson((request as { lease: TerminalControlLease }).lease) !== canonicalJson(activeLease)) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound lease changed");
  }
  return request;
}

/**
 * Explicit-version target-side owner. Exactly one preparation and one lease
 * live in this process; neither the process-local claim nor a reusable lease
 * acquisition capability crosses the channel.
 */
export async function runRelayV2RemoteExactCompoundServerV1(
  options: RelayV2RemoteExactCompoundServerOptionsV1,
): Promise<void> {
  if (!isRecord(options)
    || !isRecord(options.source)
    || typeof options.source[Symbol.asyncIterator] !== "function"
    || typeof options.write !== "function"
    || typeof options.openOwner !== "function") {
    throw new TypeError("invalid remote exact compound server options");
  }
  const frames = strictFrames(options.source)[Symbol.asyncIterator]();
  let owned: RelayV2RemoteExactCompoundAuthorityOwnerV1 | null = null;
  let exact: RelayV2TerminalControlExactTargetAuthorityAdapter | null = null;
  let preparedInput: RelayV2ExactTerminalControlTargetInputV1 | null = null;
  let preparedEvidence: RelayV2ExactTerminalControlTargetEvidenceV1 | null = null;
  let activeLease: TerminalControlLease | null = null;
  let observationOpen = false;
  let channelOwner: (TerminalControlOwner & { kind: "relay-v2" }) | null = null;
  try {
    while (true) {
      const next = await frames.next();
      if (next.done) break;
      const frame = next.value;
      try {
        if (!exactKeys(frame, ["protocolVersion", "type"], ["processTarget", "owner", "input", "request", "cursor", "maxBytes"])
          || frame.protocolVersion !== RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION
          || typeof frame.type !== "string") {
          throw new TerminalControlProtocolError("INVALID_REQUEST", "remote exact compound frame shape is invalid");
        }
        if (frame.type === "hello") {
          if (owned !== null
            || !exactKeys(frame, ["protocolVersion", "type", "processTarget"])) {
            throw new TerminalControlProtocolError(
              "PERMISSION_DENIED",
              "remote exact compound preflight is not fresh",
            );
          }
          const target = processTarget(frame.processTarget);
          owned = await options.openOwner(target);
          if (!isRecord(owned)
            || !isRecord(owned.authority)
            || typeof owned.close !== "function") {
            throw new TerminalControlProtocolError("INTERNAL", "remote exact compound owner is invalid");
          }
          await owned.close();
          owned = null;
          await writeJson(options.write, successPayload({ processTarget: clone(target) }));
          break;
        }
        if (frame.type === "prepare") {
          if (preparedInput !== null
            || activeLease !== null
            || !exactKeys(frame, ["protocolVersion", "type", "processTarget", "owner", "input"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound preparation is not fresh");
          }
          const target = processTarget(frame.processTarget);
          const reservationOwner = owner(frame.owner);
          if (owned === null) {
            owned = await options.openOwner(target);
            if (!isRecord(owned)
              || !isRecord(owned.authority)
              || typeof owned.close !== "function") {
              throw new TerminalControlProtocolError("INTERNAL", "remote exact compound owner is invalid");
            }
            exact = new RelayV2TerminalControlExactTargetAuthorityAdapter({
              authority: owned.exactAuthority ?? owned.authority,
              owner: reservationOwner,
            });
            channelOwner = reservationOwner;
          } else if (exact === null || channelOwner === null || !sameOwner(channelOwner, reservationOwner)) {
            throw new TerminalControlProtocolError(
              "PERMISSION_DENIED",
              "remote exact compound preparation crossed its channel owner",
            );
          }
          preparedInput = clone(frame.input) as RelayV2ExactTerminalControlTargetInputV1;
          preparedEvidence = await exact.resolveExactTarget(preparedInput);
          await writeJson(options.write, successPayload({
            exactControlIdentity: clone(preparedEvidence.exactControlIdentity),
          }));
          continue;
        }
        if (frame.type === "admit") {
          if (exact === null
            || preparedInput === null
            || preparedEvidence === null
            || activeLease !== null
            || !exactKeys(frame, ["protocolVersion", "type", "owner"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound claim is unavailable");
          }
          const consumerOwner = owner(frame.owner);
          exact.fenceExactTargetForAdmission(preparedInput, preparedEvidence);
          activeLease = await exact.consumePreparedLeaseForBinding(
            terminalBinding(preparedInput, preparedEvidence.exactControlIdentity),
            consumerOwner,
          );
          preparedInput = null;
          preparedEvidence = null;
          await writeJson(options.write, successPayload(clone(activeLease)));
          continue;
        }
        if (frame.type === "observe") {
          if (exact === null
            || preparedInput === null
            || preparedEvidence === null
            || activeLease !== null
            || observationOpen
            || !exactKeys(frame, ["protocolVersion", "type"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound observation is unavailable");
          }
          const binding = await (async () => {
            exact.fenceExactTargetForAdmission(preparedInput, preparedEvidence);
            return exact.consumePreparedObservationForBinding(
              terminalBinding(preparedInput, preparedEvidence.exactControlIdentity),
            );
          })();
          preparedInput = null;
          preparedEvidence = null;
          observationOpen = true;
          await writeJson(options.write, successPayload(clone(binding)));
          continue;
        }
        if (frame.type === "tail") {
          if (exact === null
            || !observationOpen
            || !exactKeys(frame, ["protocolVersion", "type", "cursor"], ["maxBytes"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound observation is unavailable");
          }
          try {
            const chunk = await exact.tailObservation(
              observationCursor(frame.cursor),
              observationMaxBytes(frame.maxBytes),
            );
            await writeJson(options.write, successPayload(clone(chunk)));
          } catch (error) {
            if (error instanceof TerminalControlProtocolError
              && error.code === "STALE_OUTPUT_CURSOR") {
              // The authority already fenced this observation; drain the
              // target-side handle so later frames see the same fence.
              observationOpen = false;
              await exact.closeObservation().catch(() => undefined);
            }
            throw error;
          }
          continue;
        }
        if (frame.type === "close-observe") {
          if (exact === null
            || !exactKeys(frame, ["protocolVersion", "type"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound observation is unavailable");
          }
          if (observationOpen) {
            await exact.closeObservation();
            observationOpen = false;
          }
          await writeJson(options.write, successPayload({ closed: true }));
          continue;
        }
        if (frame.type === "effect") {
          if (owned === null
            || activeLease === null
            || !exactKeys(frame, ["protocolVersion", "type", "request"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound lease is unavailable");
          }
          const request = effectRequest(frame.request, activeLease);
          const result = await owned.authority.handle(request);
          if (request.type === "lease.renew") {
            const envelope = result as { lease?: unknown };
            activeLease = lease(envelope.lease);
          }
          await writeJson(options.write, successPayload(result));
          if (request.type === "lease.release") {
            activeLease = null;
            if (!observationOpen) break;
          }
          continue;
        }
        if (frame.type === "rollback") {
          if (exact === null
            || preparedInput === null
            || preparedEvidence === null
            || activeLease !== null
            || !exactKeys(frame, ["protocolVersion", "type"])) {
            throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound rollback is unavailable");
          }
          const rolledBack = await exact.rollbackPreparedTarget(preparedInput, preparedEvidence);
          preparedInput = null;
          preparedEvidence = null;
          await writeJson(options.write, successPayload({ rolledBack }));
          if (!observationOpen) break;
          continue;
        }
        throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound operation is not allowed");
      } catch (error) {
        await writeJson(options.write, errorPayload(error));
        break;
      }
    }
  } finally {
    if (owned !== null && activeLease !== null) {
      try {
        await owned.authority.handle({
          protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
          requestId: `relay-v2-remote-release-${randomUUID()}`,
          type: "lease.release",
          lease: activeLease,
        });
      } catch {}
    }
    try {
      await exact?.close();
    } finally {
      await owned?.close();
    }
  }
}

async function writeStdout(frame: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) => error ? reject(error) : resolve());
  });
}

export function relayV2RemoteExactCompoundSocketPathV1(
  daemonSocketPath = terminalControlSocketPath(),
): string {
  const digest = createHash("sha256").update(daemonSocketPath, "utf8").digest("hex").slice(0, 16);
  return join(dirname(daemonSocketPath), `.relay-v2-exact-${digest}.sock`);
}

export interface RelayV2RemoteExactCompoundDaemonIngressV1 {
  readonly socketPath: string;
  closeAndDrain(): Promise<void>;
}

function listenUnix(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function writeSocket(socket: Socket, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error("remote exact compound daemon connection is closed"));
      return;
    }
    socket.write(frame, (error) => error ? reject(error) : resolve());
  });
}

function ownedUnixSocket(value: Stats, label: string): void {
  const uid = process.getuid?.();
  if (uid === undefined
    || value.isSymbolicLink()
    || !value.isSocket()
    || value.uid !== uid) {
    throw new Error(`${label} is not a same-uid real Unix socket`);
  }
}

function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function retireVerifiedStaleSocket(
  socketPath: string,
  primaryLock: TerminalControlStoreLock,
  primaryLockPath: string,
): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (!isTerminalControlStoreLockAuthorityCurrent(primaryLock, primaryLockPath)) {
    throw new Error("remote exact compound ingress lacks the current primary daemon lock");
  }
  const observed = lstatSync(socketPath);
  ownedUnixSocket(observed, "existing remote exact compound ingress");
  if (await socketIsLive(socketPath)) {
    throw new Error("remote exact compound ingress is already live");
  }
  if (!isTerminalControlStoreLockAuthorityCurrent(primaryLock, primaryLockPath)) {
    throw new Error("remote exact compound primary daemon lock changed during stale cleanup");
  }
  const current = lstatSync(socketPath);
  ownedUnixSocket(current, "existing remote exact compound ingress");
  if (current.dev !== observed.dev || current.ino !== observed.ino) {
    throw new Error("remote exact compound ingress changed during stale cleanup");
  }
  rmSync(socketPath);
}

function removeExactOwnedSocket(
  socketPath: string,
  identity: Readonly<{ dev: number; ino: number; uid: number }>,
  primaryLock: TerminalControlStoreLock,
  primaryLockPath: string,
): void {
  if (!existsSync(socketPath)) return;
  if (!isTerminalControlStoreLockAuthorityCurrent(primaryLock, primaryLockPath)) {
    throw new Error("remote exact compound ingress lost the primary daemon lock before cleanup");
  }
  const current = lstatSync(socketPath);
  ownedUnixSocket(current, "owned remote exact compound ingress");
  if (current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.uid !== identity.uid) {
    throw new Error("owned remote exact compound ingress changed before cleanup");
  }
  rmSync(socketPath);
}

/**
 * Private sibling ingress owned by the already-running terminal-control
 * daemon. The caller must already own the daemon server lock; this function
 * never opens state or constructs an authority.
 */
export async function openRelayV2RemoteExactCompoundDaemonIngressV1(options: {
  daemonSocketPath: string;
  authority: TerminalControlAuthority;
  primaryServerLock: TerminalControlStoreLock;
}): Promise<RelayV2RemoteExactCompoundDaemonIngressV1> {
  if (!isRecord(options)
    || typeof options.daemonSocketPath !== "string"
    || !isRecord(options.authority)
    || typeof options.authority.handle !== "function"
    || typeof options.authority.captureRelayV2ExactProcessTarget !== "function") {
    throw new TypeError("invalid remote exact compound daemon ingress options");
  }
  const primaryLockPath = `${options.daemonSocketPath}.server.lock`;
  if (!isTerminalControlStoreLockAuthorityCurrent(
    options.primaryServerLock,
    primaryLockPath,
  )) throw new TypeError("invalid remote exact compound daemon ingress options");
  const socketPath = relayV2RemoteExactCompoundSocketPathV1(options.daemonSocketPath);
  await retireVerifiedStaleSocket(socketPath, options.primaryServerLock, primaryLockPath);
  const sockets = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  let admissionClosed = false;
  let ownedSocketIdentity: Readonly<{ dev: number; ino: number; uid: number }> | null = null;
  const server = createServer((socket) => {
    if (admissionClosed || sockets.size >= MAX_ACTIVE_CHANNELS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => undefined);
    const handler = runRelayV2RemoteExactCompoundServerV1({
      source: socket,
      write: (frame) => writeSocket(socket, frame),
      async openOwner(target) {
        const exactAuthority = options.authority.captureRelayV2ExactProcessTarget(target);
        return Object.freeze({
          authority: options.authority,
          exactAuthority,
          async close(): Promise<void> {},
        });
      },
    }).catch(() => undefined).finally(() => {
      sockets.delete(socket);
      if (!socket.destroyed) socket.end();
      handlers.delete(handler);
    });
    handlers.add(handler);
  });
  try {
    await listenUnix(server, socketPath);
    const created = lstatSync(socketPath);
    ownedUnixSocket(created, "created remote exact compound ingress");
    ownedSocketIdentity = Object.freeze({
      dev: created.dev,
      ino: created.ino,
      uid: created.uid,
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    try { server.close(); } catch {}
    if (ownedSocketIdentity !== null) {
      removeExactOwnedSocket(
        socketPath,
        ownedSocketIdentity,
        options.primaryServerLock,
        primaryLockPath,
      );
    }
    throw error;
  }
  let closeBarrier: Promise<void> | null = null;
  return Object.freeze({
    socketPath,
    closeAndDrain(): Promise<void> {
      if (closeBarrier !== null) return closeBarrier;
      admissionClosed = true;
      closeBarrier = (async () => {
        const listenerClosed = new Promise<void>((resolve) => {
          try { server.close(() => resolve()); } catch { resolve(); }
        });
        for (const socket of sockets) socket.destroy();
        await listenerClosed;
        await Promise.allSettled([...handlers]);
        removeExactOwnedSocket(
          socketPath,
          ownedSocketIdentity!,
          options.primaryServerLock,
          primaryLockPath,
        );
      })();
      return closeBarrier;
    },
  });
}

async function connectUnix(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      reject(new Error(`Relay v2 exact daemon ingress is unavailable: ${error.message}`));
    };
    const onConnect = () => {
      socket.off("error", onError);
      socket.on("error", () => undefined);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

class LocalExactCompoundChannelV1 implements RelayV2RemoteExactCompoundChannelV1 {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private operation: Promise<void> = Promise.resolve();
  private closeBarrier: Promise<void> | null = null;

  constructor(private readonly socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  }

  private async nextFrame(): Promise<Record<string, unknown>> {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const frame = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (frame.byteLength === 0 || frame.includes(0x0d)) {
          throw new TerminalControlProtocolError(
            "INTERNAL",
            "local exact compound response is malformed",
          );
        }
        try {
          return parseRelayV2JsonObject(decodeRelayV2StrictUtf8(frame), JSON_LIMITS);
        } catch {
          throw new TerminalControlProtocolError(
            "INTERNAL",
            "local exact compound response is malformed",
          );
        }
      }
      const next = await this.iterator.next();
      if (next.done) {
        throw new TerminalControlProtocolError(
          "CAPABILITY_UNAVAILABLE",
          "local exact compound daemon closed before responding",
        );
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TerminalControlProtocolError(
          "INTERNAL",
          "local exact compound daemon returned non-byte data",
        );
      }
      if (next.value.byteLength
        > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES - this.buffer.byteLength) {
        throw new TerminalControlProtocolError(
          "INTERNAL",
          "local exact compound response exceeds the limit",
        );
      }
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    }
  }

  private async requestOne(frame: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closeBarrier !== null || this.socket.destroyed) {
      throw new TerminalControlProtocolError(
        "CAPABILITY_UNAVAILABLE",
        "local exact compound channel is closed",
      );
    }
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (encoded.byteLength > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES) {
      throw new TerminalControlProtocolError(
        "INVALID_REQUEST",
        "local exact compound request exceeds the limit",
      );
    }
    await writeSocket(this.socket, encoded);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.nextFrame(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.socket.destroy();
            reject(new TerminalControlProtocolError(
              "CAPABILITY_UNAVAILABLE",
              "local exact compound daemon timed out",
            ));
          }, 30_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  request(frame: Readonly<Record<string, unknown>>): Promise<unknown> {
    const result = this.operation.then(() => this.requestOne(frame));
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.closeBarrier = (async () => {
      if (this.socket.destroyed) return;
      const closed = new Promise<void>((resolve) => {
        this.socket.once("close", () => resolve());
      });
      this.socket.end();
      const timer = setTimeout(() => this.socket.destroy(), 5_000);
      timer.unref?.();
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.closeBarrier;
  }
}

/** Explicit local sibling transport; it never connects to terminal-control v1. */
export function captureRelayV2LocalExactCompoundChannelFactoryV1(options: {
  daemonSocketPath: string;
  processTarget: RelayV2ExactCompoundProcessTargetV1;
}): RelayV2RemoteExactCompoundChannelFactoryV1 {
  if (!isRecord(options)
    || typeof options.daemonSocketPath !== "string"
    || options.daemonSocketPath.length === 0
    || options.daemonSocketPath.trim() !== options.daemonSocketPath
    || /[\0\r\n]/.test(options.daemonSocketPath)) {
    throw new TypeError("invalid local exact compound channel options");
  }
  const exactTarget = processTarget(options.processTarget);
  if (exactTarget.kind !== "local") {
    throw new TypeError("local exact compound channel requires a local process target");
  }
  const socketPath = relayV2RemoteExactCompoundSocketPathV1(options.daemonSocketPath);
  return Object.freeze({
    async open(rawTarget: RelayV2ExactCompoundProcessTargetV1) {
      const target = processTarget(rawTarget);
      if (target.kind !== "local"
        || target.targetId !== exactTarget.targetId) {
        throw new TerminalControlProtocolError(
          "CAPABILITY_UNAVAILABLE",
          "local exact compound process target is unavailable",
        );
      }
      return new LocalExactCompoundChannelV1(await connectUnix(socketPath));
    },
  });
}

/**
 * Opens and closes one claim-free channel per exact H2 process target. A root
 * may not proceed if any configured daemon, SSH child, or protocol version is
 * unavailable.
 */
export async function preflightRelayV2ExactCompoundTargetsV1(
  channels: RelayV2RemoteExactCompoundChannelFactoryV1,
  rawTargets: readonly RelayV2ExactCompoundProcessTargetV1[],
): Promise<void> {
  if (!isRecord(channels)
    || typeof channels.open !== "function"
    || !Array.isArray(rawTargets)) {
    throw new TypeError("invalid exact compound preflight options");
  }
  const seen = new Set<string>();
  for (const rawTarget of rawTargets) {
    const target = processTarget(rawTarget);
    const key = `${target.kind}\0${target.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const channel = await channels.open(target);
    try {
      const result = responseResult(await channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "hello",
        processTarget: clone(target),
      }));
      if (!isRecord(result)
        || !exactKeys(result, ["processTarget"])
        || canonicalJson(processTarget(result.processTarget)) !== canonicalJson(target)) {
        throw new TerminalControlProtocolError(
          "INTERNAL",
          "exact compound preflight response is malformed",
        );
      }
    } finally {
      await channel.close();
    }
  }
}

async function proxyBoundedFrames(
  source: AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  let pendingBytes = 0;
  for await (const rawChunk of source) {
    if (!(rawChunk instanceof Uint8Array)) {
      throw new Error("remote exact compound proxy received non-byte input");
    }
    let offset = 0;
    while (offset < rawChunk.byteLength) {
      const newline = rawChunk.indexOf(0x0a, offset);
      const end = newline < 0 ? rawChunk.byteLength : newline;
      const segmentBytes = end - offset;
      if (segmentBytes > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES - pendingBytes) {
        throw new Error("remote exact compound proxy frame exceeds the limit");
      }
      pendingBytes += segmentBytes;
      if (newline < 0) break;
      pendingBytes = 0;
      offset = newline + 1;
    }
    await write(rawChunk);
  }
  if (pendingBytes !== 0) {
    throw new Error("remote exact compound proxy closed with a truncated frame");
  }
}

/** Hidden SSH child: bounded stdio-to-existing-daemon proxy, and nothing else. */
export async function runRelayV2RemoteExactCompoundStdioV1(): Promise<void> {
  const socket = await connectUnix(
    relayV2RemoteExactCompoundSocketPathV1(terminalControlSocketPath()),
  );
  const upstream = proxyBoundedFrames(process.stdin, (chunk) => writeSocket(socket, chunk))
    .then(() => { if (!socket.destroyed) socket.end(); });
  const downstream = proxyBoundedFrames(socket, writeStdout);
  const first = await Promise.race([
    upstream.then(() => ({ side: "upstream" as const }), (error: unknown) => ({ side: "failed" as const, error })),
    downstream.then(() => ({ side: "downstream" as const }), (error: unknown) => ({ side: "failed" as const, error })),
  ]);
  if (first.side === "failed") {
    socket.destroy();
    process.stdin.destroy();
    await Promise.allSettled([upstream, downstream]);
    throw first.error;
  }
  if (first.side === "upstream") {
    await downstream;
    return;
  }
  socket.destroy();
  process.stdin.destroy();
  await upstream.catch(() => undefined);
}

/**
 * Host-side exact port. The public token names only this live compound channel;
 * the target-side claim is never serialized or reacquired.
 */
export class RelayV2RemoteExactTerminalControlCompoundAdapterV1
implements RelayV2PreparedExactTerminalControlLeasePortV1, RelayV2TerminalControlRequestPort {
  private readonly channels: RelayV2RemoteExactCompoundChannelFactoryV1;
  private readonly owner: TerminalControlOwner & { kind: "relay-v2" };
  private readonly records = new Map<string, HostRecord>();
  private admissionClosed = false;
  private closeBarrier: Promise<void> | null = null;

  constructor(options: RelayV2RemoteExactTerminalControlCompoundAdapterOptionsV1) {
    if (!isRecord(options)
      || !isRecord(options.channels)
      || typeof options.channels.open !== "function") {
      throw new TypeError("remote exact compound adapter requires a channel factory");
    }
    this.channels = options.channels;
    this.owner = Object.freeze(owner(options.owner));
  }

  async resolveExactTarget(
    input: RelayV2ExactTerminalControlTargetInputV1,
  ): Promise<RelayV2ExactTerminalControlTargetEvidenceV1> {
    if (this.admissionClosed || this.records.size >= MAX_ACTIVE_CHANNELS) {
      throw new TerminalControlProtocolError("RESOURCE_EXHAUSTED", "remote exact compound admission is closed", true);
    }
    const target = processTarget(input.processTarget);
    const channel = await this.channels.open(target);
    try {
      const result = responseResult(await channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "prepare",
        processTarget: clone(target),
        owner: clone(this.owner),
        input: clone(input),
      }));
      if (!isRecord(result) || !exactKeys(result, ["exactControlIdentity"])) {
        throw new TerminalControlProtocolError("INTERNAL", "remote exact compound preparation is malformed");
      }
      const token = `twrc2.${randomUUID()}`;
      const evidence = Object.freeze({
        ...clone(input),
        processTarget: Object.freeze(clone(input.processTarget)),
        managedTarget: Object.freeze(clone(input.managedTarget)),
        exactControlToken: token,
        exactControlIdentity: identity(result.exactControlIdentity),
      });
      this.records.set(token, {
        input: clone(input),
        inputJson: canonicalJson(input),
        evidence,
        channel,
        state: "prepared",
        lease: null,
        observation: null,
      });
      return evidence;
    } catch (error) {
      await channel.close().catch(() => undefined);
      throw error;
    }
  }

  fenceExactTargetForAdmission(
    input: RelayV2ExactTerminalControlTargetInputV1,
    evidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): void {
    const record = this.records.get(evidence.exactControlToken);
    if (!record
      || record.state !== "prepared"
      || record.inputJson !== canonicalJson(input)
      || canonicalJson(record.evidence) !== canonicalJson(evidence)) {
      if (record) void this.retire(evidence.exactControlToken, record, true);
      throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound preparation is stale");
    }
    record.state = "admitted";
  }

  async consumePreparedLeaseForBinding(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    consumerOwner: TerminalControlOwner & { kind: "relay-v2" },
  ): Promise<TerminalControlLease> {
    const matches = [...this.records.entries()].filter(([, record]) => (
      record.state === "admitted"
      && canonicalJson(terminalBinding(record.input, record.evidence.exactControlIdentity))
        === canonicalJson(binding)
    ));
    if (matches.length !== 1) {
      throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound claim is unavailable");
    }
    const [token, record] = matches[0];
    try {
      const admitted = lease(responseResult(await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "admit",
        owner: clone(consumerOwner),
      })));
      if (!sameOwner(admitted.owner, consumerOwner)
        || admitted.controlTargetId !== binding.exactControlIdentity.controlTargetId
        || admitted.controlEpoch !== binding.exactControlIdentity.controlEpoch) {
        throw new TerminalControlProtocolError("INTERNAL", "remote exact compound admitted lease changed");
      }
      record.state = "consumed";
      record.lease = admitted;
      return Object.freeze({ ...admitted, owner: Object.freeze({ ...admitted.owner }) });
    } catch (error) {
      this.records.delete(token);
      record.state = "closed";
      await record.channel.close().catch(() => undefined);
      if (error instanceof TerminalControlProtocolError
        && error.code !== "INTERNAL"
        && error.code !== "OPERATION_IN_DOUBT") throw error;
      throw new TerminalControlProtocolError(
        "OPERATION_IN_DOUBT",
        "remote exact compound admission outcome is uncertain",
      );
    }
  }

  private observationRecord(
    binding: RelayV2ExactCompoundObservationBindingV1,
  ): [string, HostRecord] {
    const parsed = observationBinding(binding);
    const matches = [...this.records.entries()].filter(([, record]) => (
      record.observation !== null
      && canonicalJson(record.observation) === canonicalJson(parsed)
    ));
    if (matches.length !== 1) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "remote exact compound observation is unavailable",
      );
    }
    return matches[0];
  }

  private async retireFailedObservation(token: string, record: HostRecord, error: unknown): Promise<never> {
    this.records.delete(token);
    record.state = "closed";
    await record.channel.close().catch(() => undefined);
    if (error instanceof TerminalControlProtocolError
      && error.code !== "INTERNAL"
      && error.code !== "OPERATION_IN_DOUBT") throw error;
    throw new TerminalControlProtocolError(
      "OPERATION_IN_DOUBT",
      "remote exact compound observation outcome is uncertain",
    );
  }

  /**
   * Atomically consumes the admitted claim into a read-only observation on
   * the same compound channel. The response must re-prove the prepared
   * HostRecord identity; any mismatch fails closed and drains the channel.
   */
  async observePreparedTargetForBinding(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
  ): Promise<RelayV2ExactCompoundObservationBindingV1> {
    const matches = [...this.records.entries()].filter(([, record]) => (
      record.state === "admitted"
      && canonicalJson(terminalBinding(record.input, record.evidence.exactControlIdentity))
        === canonicalJson(binding)
    ));
    if (matches.length !== 1) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "remote exact compound observation claim is unavailable",
      );
    }
    const [token, record] = matches[0];
    try {
      const observed = observationBinding(responseResult(await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "observe",
      })));
      if (observed.controlTargetId !== record.evidence.exactControlIdentity.controlTargetId
        || observed.controlEpoch !== record.evidence.exactControlIdentity.controlEpoch
        || observed.targetIncarnationProof
          !== record.evidence.exactControlIdentity.targetIncarnationProof) {
        throw new TerminalControlProtocolError(
          "INTERNAL",
          "remote exact compound observation binding changed",
        );
      }
      record.state = "observing";
      record.observation = observed;
      return Object.freeze({ ...observed });
    } catch (error) {
      return this.retireFailedObservation(token, record, error);
    }
  }

  /** Tails the pinned output generation over the same compound channel. */
  async tailObservedTarget(
    binding: RelayV2ExactCompoundObservationBindingV1,
    cursor: number,
    maxBytes?: number,
  ): Promise<RelayV2ExactCompoundObservationTailV1> {
    const parsedCursor = observationCursor(cursor);
    const parsedMaxBytes = observationMaxBytes(maxBytes);
    const [token, record] = this.observationRecord(binding);
    try {
      const chunk = observationTail(responseResult(await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "tail",
        cursor: parsedCursor,
        ...(parsedMaxBytes === undefined ? {} : { maxBytes: parsedMaxBytes }),
      })));
      if (chunk.controlEpoch !== record.observation!.controlEpoch
        || chunk.outputGeneration !== record.observation!.outputGeneration) {
        throw new TerminalControlProtocolError(
          "INTERNAL",
          "remote exact compound observation tail crossed its binding",
        );
      }
      return Object.freeze({ ...chunk });
    } catch (error) {
      return this.retireFailedObservation(token, record, error);
    }
  }

  /**
   * Starts a fresh claim on the channel that already owns this observation,
   * so observation and the subsequent lease acquire/renew/release stay in
   * one canonical child.
   */
  async prepareObservedTargetLease(
    binding: RelayV2ExactCompoundObservationBindingV1,
  ): Promise<RelayV2ExactTerminalControlTargetEvidenceV1> {
    const [token, record] = this.observationRecord(binding);
    if (record.state !== "observing") {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "remote exact compound observation channel is busy",
      );
    }
    try {
      const result = responseResult(await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "prepare",
        processTarget: clone(record.input.processTarget),
        owner: clone(this.owner),
        input: clone(record.input),
      }));
      if (!isRecord(result) || !exactKeys(result, ["exactControlIdentity"])) {
        throw new TerminalControlProtocolError("INTERNAL", "remote exact compound preparation is malformed");
      }
      const evidence = Object.freeze({
        ...clone(record.input),
        processTarget: Object.freeze(clone(record.input.processTarget)),
        managedTarget: Object.freeze(clone(record.input.managedTarget)),
        exactControlToken: token,
        exactControlIdentity: identity(result.exactControlIdentity),
      });
      record.evidence = evidence;
      record.state = "prepared";
      return evidence;
    } catch (error) {
      return this.retireFailedObservation(token, record, error);
    }
  }

  /**
   * Idempotently closes the observation. When the same channel still holds
   * this observation's prepared/admitted claim, the claim is rolled back and
   * confirmed first, so the target-side deferred reset observes FREE instead
   * of a HELD reservation; a rollback failure keeps the record, the handle,
   * and this close retryable. An idle channel is drained afterwards.
   */
  async closeObservedTarget(
    binding: RelayV2ExactCompoundObservationBindingV1,
  ): Promise<void> {
    const parsed = observationBinding(binding);
    const matches = [...this.records.entries()].filter(([, record]) => (
      record.observation !== null
      && canonicalJson(record.observation) === canonicalJson(parsed)
    ));
    if (matches.length !== 1) return;
    const [token, record] = matches[0];
    if (record.state === "prepared" || record.state === "admitted") {
      let rolledBack: unknown;
      try {
        rolledBack = responseResult(await record.channel.request({
          protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
          type: "rollback",
        }));
      } catch (error) {
        if (error instanceof TerminalControlProtocolError
          && error.code !== "INTERNAL"
          && error.code !== "OPERATION_IN_DOUBT") throw error;
        throw new TerminalControlProtocolError(
          "OPERATION_IN_DOUBT",
          "remote exact compound claim rollback outcome is uncertain",
        );
      }
      if (!isRecord(rolledBack)
        || !exactKeys(rolledBack, ["rolledBack"])
        || rolledBack.rolledBack !== true) {
        throw new TerminalControlProtocolError(
          "OPERATION_IN_DOUBT",
          "remote exact compound claim rollback was not confirmed",
        );
      }
      record.state = "observing";
    }
    try {
      const result = responseResult(await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "close-observe",
      }));
      if (!isRecord(result) || !exactKeys(result, ["closed"]) || result.closed !== true) {
        throw new TerminalControlProtocolError(
          "INTERNAL",
          "remote exact compound observation close is malformed",
        );
      }
      record.observation = null;
      if (record.state === "observing") {
        this.records.delete(token);
        record.state = "closed";
        await record.channel.close();
      }
    } catch (error) {
      return this.retireFailedObservation(token, record, error);
    }
  }

  async request<T = unknown>(input: TerminalControlRequestInput): Promise<T> {
    const candidates = [...this.records.entries()].filter(([, record]) => {
      if (record.state !== "consumed" || record.lease === null) return false;
      if (input.type === "ownership.status") {
        return input.controlTargetId === record.lease.controlTargetId;
      }
      return Object.hasOwn(input, "lease")
        && canonicalJson((input as { lease: TerminalControlLease }).lease)
          === canonicalJson(record.lease);
    });
    if (candidates.length !== 1) {
      throw new TerminalControlProtocolError("PERMISSION_DENIED", "remote exact compound lease is unavailable");
    }
    const [token, record] = candidates[0];
    try {
      const result = responseResult(await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "effect",
        request: clone(input),
      }));
      if (input.type === "lease.renew") {
        const envelope = result as { lease?: unknown };
        record.lease = lease(envelope.lease);
      }
      if (input.type === "lease.release") {
        record.lease = null;
        if (record.observation === null) {
          this.records.delete(token);
          record.state = "closed";
          await record.channel.close();
        } else {
          record.state = "observing";
        }
      }
      return result as T;
    } catch (error) {
      this.records.delete(token);
      record.state = "closed";
      await record.channel.close().catch(() => undefined);
      if (error instanceof TerminalControlProtocolError
        && error.code !== "INTERNAL"
        && error.code !== "OPERATION_IN_DOUBT") throw error;
      throw new TerminalControlProtocolError(
        "OPERATION_IN_DOUBT",
        "remote exact compound effect outcome is uncertain",
      );
    }
  }

  fenceNewPreparations(): void {
    this.admissionClosed = true;
  }

  private async retire(token: string, record: HostRecord, rollback: boolean): Promise<void> {
    if (record.state === "closed") return;
    this.records.delete(token);
    const canRollback = rollback && (record.state === "prepared" || record.state === "admitted");
    record.state = "closed";
    if (canRollback) {
      await record.channel.request({
        protocolVersion: RELAY_V2_REMOTE_EXACT_COMPOUND_PROTOCOL_VERSION,
        type: "rollback",
      }).catch(() => undefined);
    }
    await record.channel.close();
  }

  async close(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.admissionClosed = true;
    this.closeBarrier = (async () => {
      const records = [...this.records.entries()];
      this.records.clear();
      const results = await Promise.allSettled(records.map(([token, record]) => (
        this.retire(token, record, true)
      )));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.closeBarrier;
  }
}
