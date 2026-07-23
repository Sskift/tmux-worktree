import type { TerminalControlLease, TerminalControlOwner } from "../../terminalControl/protocol.js";
import { TerminalControlProtocolError } from "../../terminalControl/protocol.js";
import type {
  RelayV2ExactTerminalControlTargetInputV1,
} from "./canonicalTerminalTargetResolverAdapter.js";
import type {
  RelayV2ExactCompoundObservationBindingV1,
  RelayV2RemoteExactTerminalControlCompoundAdapterV1,
} from "./remoteExactTerminalControlCompoundV1.js";
import type {
  RelayV2TerminalBackendObserver,
  RelayV2TerminalByteBackend,
  RelayV2TerminalByteHandle,
  RelayV2TerminalCanonicalTargetBindingV1,
  RelayV2TerminalExactEffectTargetV1,
  RelayV2TerminalResolvedTarget,
} from "./terminalManager.js";

const RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET = Symbol.for(
  "tmux-worktree.relay-v2.terminal-exact-effect-target",
);

const DEFAULT_IDLE_POLL_MS = 25;
const MAX_OBSERVED_CHUNK_BYTES = 384 * 1024;

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

function bounded(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane exact target is invalid",
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function resolvedTarget(value: unknown): RelayV2TerminalResolvedTarget {
  if (!isRecord(value) || !exactKeys(value, [
    "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
  ])
    || !Number.isSafeInteger(value.pane)
    || (value.pane as number) < 0
    || (value.pane as number) > 65_535) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane exact target is invalid",
    );
  }
  return {
    hostId: bounded(value.hostId),
    scopeId: bounded(value.scopeId),
    sessionId: bounded(value.sessionId),
    pane: value.pane as number,
    canonicalTargetId: bounded(value.canonicalTargetId),
    controlTargetId: bounded(value.controlTargetId),
  };
}

function exactEffectTarget(value: unknown): {
  resolved: RelayV2TerminalResolvedTarget;
  binding: RelayV2TerminalCanonicalTargetBindingV1;
} {
  if (!isRecord(value)
    || Reflect.ownKeys(value).length !== 4
    || value.schemaVersion !== 1
    || Reflect.get(value, RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET) !== true
    || !Object.hasOwn(value, "resolvedTarget")
    || !Object.hasOwn(value, "binding")) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane requires an exact effect target",
    );
  }
  const resolved = resolvedTarget(value.resolvedTarget);
  const raw = value.binding;
  if (!isRecord(raw)
    || !exactKeys(raw, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlIdentity",
    ])
    || raw.schemaVersion !== 1
    || raw.hostId !== resolved.hostId
    || raw.scopeId !== resolved.scopeId
    || raw.sessionId !== resolved.sessionId
    || raw.pane !== resolved.pane
    || raw.backendInstanceKey !== resolved.canonicalTargetId
    || !isRecord(raw.processTarget)
    || !exactKeys(raw.processTarget, ["kind", "targetId"])
    || (raw.processTarget.kind !== "local" && raw.processTarget.kind !== "ssh")
    || !isRecord(raw.managedTarget)
    || !exactKeys(raw.managedTarget, ["name", "kind", "incarnation"])
    || (raw.managedTarget.kind !== "worktree" && raw.managedTarget.kind !== "terminal")
    || !isRecord(raw.exactControlIdentity)
    || !exactKeys(raw.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || raw.exactControlIdentity.schemaVersion !== 1
    || raw.exactControlIdentity.controlTargetId !== resolved.controlTargetId) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane exact target binding is invalid",
    );
  }
  bounded(raw.processTarget.targetId);
  bounded(raw.managedTarget.name);
  bounded(raw.managedTarget.incarnation, 256);
  bounded(raw.exactControlIdentity.controlEpoch);
  bounded(raw.exactControlIdentity.targetIncarnationProof);
  return {
    resolved,
    binding: raw as unknown as RelayV2TerminalCanonicalTargetBindingV1,
  };
}

function owner(value: unknown): TerminalControlOwner & { kind: "relay-v2" } {
  if (!isRecord(value)
    || !exactKeys(value, ["kind", "instanceId"])
    || value.kind !== "relay-v2") {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane lease owner is invalid",
    );
  }
  return { kind: "relay-v2", instanceId: bounded(value.instanceId, 256) };
}

export interface RelayV2TerminalControlObservedLazyLeasePortV1 {
  consumePreparedLeaseForBinding(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    owner: TerminalControlOwner & { kind: "relay-v2" },
  ): Promise<TerminalControlLease>;
}

export interface RelayV2TerminalControlObservedBytePlaneAdapterOptionsV1 {
  readonly exactTargets: RelayV2RemoteExactTerminalControlCompoundAdapterV1;
  /** Idle tail poll interval; test isolation may shorten it. */
  readonly idlePollMs?: number;
}

interface ObservedHandleRecord {
  readonly binding: RelayV2TerminalCanonicalTargetBindingV1;
  readonly bindingJson: string;
  readonly observation: RelayV2ExactCompoundObservationBindingV1;
  readonly maxChunkBytes: number;
  readonly observer: RelayV2TerminalBackendObserver;
  cursor: number;
  displaySizeHint: Readonly<{ cols: number; rows: number }>;
  paused: boolean;
  closed: boolean;
  callbacksFenced: boolean;
  onClosedDelivered: boolean;
  pumping: boolean;
  inflightTail: Promise<void> | null;
  closeBarrier: Promise<void> | null;
  closeSelf(): Promise<void>;
}

/**
 * Byte-plane consumer over the host-side exact compound owner. It owns no
 * claim, ring, tmux access, generic output.tail, retry, or fallback: every
 * observation, tail, lazy lease, and close travels the same per-target
 * compound channel owned by RelayV2RemoteExactTerminalControlCompoundAdapterV1,
 * and TerminalControlAuthority on the target host remains the only lease,
 * input, resize, and output authority.
 */
export class RelayV2TerminalControlObservedBytePlaneAdapterV1
implements RelayV2TerminalByteBackend {
  private readonly exactTargets: RelayV2RemoteExactTerminalControlCompoundAdapterV1;
  private readonly idlePollMs: number;
  private readonly records = new Map<string, ObservedHandleRecord>();
  private admissionClosed = false;
  private adapterCloseBarrier: Promise<void> | null = null;
  readonly lazyLeasePort: RelayV2TerminalControlObservedLazyLeasePortV1;

  constructor(options: RelayV2TerminalControlObservedBytePlaneAdapterOptionsV1) {
    if (!isRecord(options)
      || !isRecord(options.exactTargets)
      || typeof options.exactTargets.observePreparedTargetForBinding !== "function"
      || typeof options.exactTargets.tailObservedTarget !== "function"
      || typeof options.exactTargets.prepareObservedTargetLease !== "function"
      || typeof options.exactTargets.fenceExactTargetForAdmission !== "function"
      || typeof options.exactTargets.consumePreparedLeaseForBinding !== "function"
      || typeof options.exactTargets.closeObservedTarget !== "function"
      || (options.idlePollMs !== undefined
        && (!Number.isSafeInteger(options.idlePollMs) || options.idlePollMs < 1))) {
      throw new TypeError("observed byte plane adapter options are invalid");
    }
    this.exactTargets = options.exactTargets;
    this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    const lazyLeasePort: RelayV2TerminalControlObservedLazyLeasePortV1 = {
      consumePreparedLeaseForBinding: (binding, consumerOwner) => (
        this.consumeLazyLease(binding, consumerOwner)
      ),
    };
    this.lazyLeasePort = Object.freeze(lazyLeasePort);
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.idlePollMs);
      timer.unref?.();
    });
  }

  private async failClosed(record: ObservedHandleRecord): Promise<void> {
    record.callbacksFenced = true;
    if (record.closed || record.onClosedDelivered) return;
    record.onClosedDelivered = true;
    try {
      await record.observer.onClosed({ reason: "backend_error", exitCode: null });
    } catch {
      // A fenced observer rejection cannot reopen the attachment.
    }
  }

  private pump(record: ObservedHandleRecord): void {
    if (record.pumping) return;
    record.pumping = true;
    void (async () => {
      try {
        while (!record.closed
          && !record.paused
          && !record.callbacksFenced) {
          let chunk;
          const inflight = this.exactTargets.tailObservedTarget(
            record.observation,
            record.cursor,
            record.maxChunkBytes,
          );
          record.inflightTail = inflight.then(() => undefined, () => undefined);
          try {
            chunk = await inflight;
          } catch {
            record.inflightTail = null;
            // The authority fenced or rejected this observation (including
            // STALE_OUTPUT_CURSOR). Fail closed exactly once; never retry.
            await this.failClosed(record);
            return;
          }
          record.inflightTail = null;
          if (record.closed || record.callbacksFenced) return;
          const bytes = Buffer.from(chunk.dataBase64, "base64");
          if (chunk.controlEpoch !== record.observation.controlEpoch
            || chunk.outputGeneration !== record.observation.outputGeneration
            || chunk.cursor !== record.cursor
            || chunk.nextCursor < record.cursor
            || bytes.byteLength > record.maxChunkBytes
            || (bytes.byteLength === 0 && chunk.nextCursor !== record.cursor)) {
            await this.failClosed(record);
            return;
          }
          record.cursor = chunk.nextCursor;
          if (bytes.byteLength === 0) {
            await this.idle();
            continue;
          }
          try {
            await record.observer.onBytes(bytes);
          } catch {
            await this.failClosed(record);
            return;
          }
          if (record.closed || record.callbacksFenced) return;
        }
      } finally {
        record.pumping = false;
      }
    })();
  }

  async open(
    target: RelayV2TerminalExactEffectTargetV1,
    options: {
      maxChunkBytes: number;
      displaySizeHint: { cols: number; rows: number };
    },
    observer: RelayV2TerminalBackendObserver,
  ): Promise<RelayV2TerminalByteHandle> {
    if (this.admissionClosed) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "observed byte plane admission is closed",
        true,
      );
    }
    const parsed = exactEffectTarget(target);
    if (!isRecord(options)
      || !Number.isSafeInteger(options.maxChunkBytes)
      || options.maxChunkBytes < 1
      || options.maxChunkBytes > MAX_OBSERVED_CHUNK_BYTES
      || !isRecord(options.displaySizeHint)
      || !Number.isSafeInteger(options.displaySizeHint.cols)
      || options.displaySizeHint.cols < 1
      || !Number.isSafeInteger(options.displaySizeHint.rows)
      || options.displaySizeHint.rows < 1
      || !isRecord(observer)
      || typeof observer.onBytes !== "function"
      || typeof observer.onClosed !== "function") {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "observed byte plane open options are invalid",
      );
    }
    if (this.records.has(canonicalJson(parsed.binding))) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "observed byte plane attachment is not fresh",
      );
    }
    const binding = structuredClone(parsed.binding);
    const observation = await this.exactTargets.observePreparedTargetForBinding(binding);
    const record: ObservedHandleRecord = {
      binding,
      bindingJson: canonicalJson(binding),
      observation,
      maxChunkBytes: options.maxChunkBytes,
      observer,
      cursor: observation.outputCursor,
      displaySizeHint: Object.freeze({
        cols: options.displaySizeHint.cols,
        rows: options.displaySizeHint.rows,
      }),
      paused: false,
      closed: false,
      callbacksFenced: false,
      onClosedDelivered: false,
      pumping: false,
      inflightTail: null,
      closeBarrier: null,
      closeSelf: () => close(),
    };
    const close = (): Promise<void> => {
      if (record.closeBarrier !== null) return record.closeBarrier;
      record.closed = true;
      record.callbacksFenced = true;
      record.closeBarrier = (async () => {
        // The compound channel serializes close-observe after the in-flight
        // tail; settle that request first so the pump never re-enters. An
        // in-flight observer callback is fenced, never awaited: the manager
        // re-enters this close after fencing its generation.
        if (record.inflightTail !== null) await record.inflightTail;
        try {
          await this.exactTargets.closeObservedTarget(record.observation);
        } finally {
          this.records.delete(record.bindingJson);
        }
      })();
      return record.closeBarrier;
    };
    this.records.set(record.bindingJson, record);
    this.pump(record);
    return Object.freeze({
      pause(): Promise<void> {
        record.paused = true;
        return Promise.resolve();
      },
      resume: (): Promise<void> => {
        record.paused = false;
        if (!record.closed && !record.callbacksFenced) this.pump(record);
        return Promise.resolve();
      },
      setDisplaySizeHint(size: { cols: number; rows: number }): Promise<void> {
        if (!isRecord(size)
          || !Number.isSafeInteger(size.cols)
          || size.cols < 1
          || !Number.isSafeInteger(size.rows)
          || size.rows < 1) {
          return Promise.reject(new TerminalControlProtocolError(
            "INVALID_REQUEST",
            "observed byte plane display size hint is invalid",
          ));
        }
        record.displaySizeHint = Object.freeze({ cols: size.cols, rows: size.rows });
        return Promise.resolve();
      },
      close,
    });
  }

  private async consumeLazyLease(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    consumerOwner: TerminalControlOwner & { kind: "relay-v2" },
  ): Promise<TerminalControlLease> {
    const parsedOwner = owner(consumerOwner);
    const bindingJson = canonicalJson(binding);
    const matches = [...this.records.values()].filter((record) => (
      !record.closed && record.bindingJson === bindingJson
    ));
    if (matches.length !== 1) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "observed byte plane observation is unavailable",
      );
    }
    const record = matches[0];
    // Re-prepare, fence, and consume strictly in order on the same compound
    // channel that owns this observation; any failure fails closed once.
    const evidence = await this.exactTargets.prepareObservedTargetLease(record.observation);
    const { exactControlToken: _token, exactControlIdentity, ...input } = evidence;
    const exactInput = input as RelayV2ExactTerminalControlTargetInputV1;
    this.exactTargets.fenceExactTargetForAdmission(exactInput, evidence);
    const freshBinding: RelayV2TerminalCanonicalTargetBindingV1 = {
      ...input,
      schemaVersion: 1,
      exactControlIdentity,
    };
    return this.exactTargets.consumePreparedLeaseForBinding(freshBinding, parsedOwner);
  }

  async close(): Promise<void> {
    if (this.adapterCloseBarrier !== null) return this.adapterCloseBarrier;
    this.admissionClosed = true;
    this.adapterCloseBarrier = (async () => {
      let firstFailure: unknown = null;
      for (const record of [...this.records.values()]) {
        try {
          await record.closeSelf();
        } catch (error) {
          if (firstFailure === null) firstFailure = error;
        }
      }
      if (firstFailure !== null) throw firstFailure;
    })();
    return this.adapterCloseBarrier;
  }
}
