import { RELAY_V2_BROKER_LIMITS } from "./brokerCore.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RELAY_V2_COMMAND_DEDUPE_RETENTION_MS,
  RELAY_V2_COMMAND_RESULT_RETENTION_MS,
} from "./hostCommandPlane.js";
import {
  RelayV2HostRuntimeAuthorityError,
  type RelayV2HostRuntimeHelloBuildInput,
  type RelayV2HostRuntimeWelcomeSerializer,
} from "./hostRuntime.js";
import { RELAY_V2_STATE_SNAPSHOT_LIMITS } from "./stateSnapshotSpool.js";
import { RELAY_V2_TERMINAL_LIMITS } from "./terminalManager.js";

/**
 * Default-off production welcome serializer for the canonical Host runtime.
 * Given one admitted client.hello, the H2 welcome cut, the H1 dedupe window,
 * and the authoritative readiness capability intersection, it synchronously
 * builds the exact frozen host.welcome frame of docs/relay-v2-contract.md
 * §2.2 inside H2's H0 serializer. It owns no Host state: it never adds
 * capabilities beyond the authoritative intersection, never emits a welcome
 * for an ahead cursor, and fails closed on malformed or mismatched input.
 */

const COUNTER_MAX = 18_446_744_073_709_551_615n;

// Frozen by docs/relay-v2-contract.md §4.4 (32 query items) and §3.2/§5.4
// (state.snapshot.chunk JSON budget); the strict codec enforces the same
// values on the wire.
const MAX_COMMAND_QUERY_IDS = 32;
const STATE_SNAPSHOT_CHUNK_MAX_JSON_KEYS = 8_192;
const STATE_SNAPSHOT_CHUNK_MAX_JSON_NODES = 16_384;

const HOST_WELCOME_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  commandResultRetentionMs: RELAY_V2_COMMAND_RESULT_RETENTION_MS,
  commandDedupeRetentionMs: RELAY_V2_COMMAND_DEDUPE_RETENTION_MS,
  maxCommandQueryIds: MAX_COMMAND_QUERY_IDS,
  stateSnapshotChunkBytes: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxChunkCanonicalBytes,
  stateSnapshotChunkRecords: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxChunkRecords,
  stateSnapshotMaxBytes: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxCutCanonicalBytes,
  stateSnapshotMaxRecords: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxCutRecords,
  stateSnapshotIdleLeaseMs: RELAY_V2_STATE_SNAPSHOT_LIMITS.idleLeaseMs,
  stateSnapshotMaxLifetimeMs: RELAY_V2_STATE_SNAPSHOT_LIMITS.absoluteLeaseMs,
  stateSnapshotMaxPinnedPerPrincipal: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxCutsPerPrincipal,
  stateSnapshotMaxPinnedPerHost: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxCutsPerHost,
  stateSnapshotPinnedBytesPerHost: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxSpoolCanonicalBytes,
  stateSnapshotPinnedMetadataBytesPerHost: RELAY_V2_STATE_SNAPSHOT_LIMITS.maxMetadataBytes,
  stateSnapshotChunkMaxJsonKeys: STATE_SNAPSHOT_CHUNK_MAX_JSON_KEYS,
  stateSnapshotChunkMaxJsonNodes: STATE_SNAPSHOT_CHUNK_MAX_JSON_NODES,
  terminalReplayBytesPerStream: RELAY_V2_TERMINAL_LIMITS.streamRingBytes,
  terminalReplayBytesPerHost: RELAY_V2_TERMINAL_LIMITS.hostRingBytes,
  terminalDetachedLeaseMs: RELAY_V2_TERMINAL_LIMITS.detachedLeaseMs,
  terminalControlDedupeRetentionMs: RELAY_V2_TERMINAL_LIMITS.controlRetentionMs,
  terminalMaxUnackedBytes: RELAY_V2_TERMINAL_LIMITS.maxUnackedBytes,
  terminalMaxFrameBytes: RELAY_V2_TERMINAL_LIMITS.maxFrameBytes,
  terminalInputDedupeEntriesPerStream: RELAY_V2_TERMINAL_LIMITS.inputDedupeEntries,
  terminalResizeDedupeEntriesPerStream: RELAY_V2_TERMINAL_LIMITS.resizeDedupeEntries,
  terminalMaxStreamsPerHost: RELAY_V2_TERMINAL_LIMITS.maxStreams,
  terminalControlRecordsPerHost: RELAY_V2_TERMINAL_LIMITS.maxControlRecords,
  brokerRouteBufferedBytesPerDirection: RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection,
  brokerRouteLowWaterBytesPerDirection: RELAY_V2_BROKER_LIMITS.routeLowWaterBytesPerDirection,
});

function invalid(): never {
  throw new RelayV2HostRuntimeAuthorityError("INVALID_ARGUMENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid();
  }
}

function id(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > 128) {
    invalid();
  }
  return value;
}

function counter(value: unknown): string {
  if (typeof value !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(value)
    || BigInt(value) > COUNTER_MAX) {
    invalid();
  }
  return value;
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0) {
    invalid();
  }
  return value;
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) invalid();
  const seen = new Set<string>();
  return value.map((item) => {
    const capability = id(item);
    if (seen.has(capability)) invalid();
    seen.add(capability);
    return capability;
  });
}

/**
 * Binds the authoritative hostId once; the returned serializer is frozen,
 * stateless, and safe to inject as the canonical composition `welcome` port.
 */
export function createRelayV2HostRuntimeWelcomeSerializer(
  input: Readonly<{ hostId: string }>,
): RelayV2HostRuntimeWelcomeSerializer {
  if (!isRecord(input)) invalid();
  exactKeys(input, ["hostId"]);
  const hostId = id(input.hostId);
  return Object.freeze({
    build(buildInput: RelayV2HostRuntimeHelloBuildInput): RelayV2JsonObject {
      if (!isRecord(buildInput)) invalid();
      exactKeys(buildInput, ["hello", "cut", "commandDedupeWindow", "capabilities"]);

      const hello = buildInput.hello;
      if (!isRecord(hello)) invalid();
      exactKeys(hello, ["protocolVersion", "kind", "type", "requestId", "hostId", "payload"]);
      if (hello.protocolVersion !== 2
        || hello.kind !== "request"
        || hello.type !== "client.hello") {
        invalid();
      }
      const requestId = id(hello.requestId);
      if (id(hello.hostId) !== hostId) invalid();
      const helloPayload = hello.payload;
      if (!isRecord(helloPayload)) invalid();
      exactKeys(helloPayload, [
        "clientInstanceId",
        "capabilities",
        "requiredCapabilities",
        "resume",
      ]);
      id(helloPayload.clientInstanceId);
      capabilities(helloPayload.capabilities);
      capabilities(helloPayload.requiredCapabilities);
      let resumeCursor: Readonly<{ hostEpoch: string; lastEventSeq: string }> | null = null;
      if (helloPayload.resume !== null) {
        if (!isRecord(helloPayload.resume)) invalid();
        exactKeys(helloPayload.resume, ["hostEpoch", "lastEventSeq"]);
        resumeCursor = {
          hostEpoch: id(helloPayload.resume.hostEpoch),
          lastEventSeq: counter(helloPayload.resume.lastEventSeq),
        };
      }

      const cut = buildInput.cut;
      if (!isRecord(cut)) invalid();
      exactKeys(cut, ["hostEpoch", "hostInstanceId", "eventSeq", "requiresSnapshot"]);
      const cutHostEpoch = id(cut.hostEpoch);
      const cutHostInstanceId = id(cut.hostInstanceId);
      const cutEventSeq = counter(cut.eventSeq);
      if (typeof cut.requiresSnapshot !== "boolean") invalid();

      const window = buildInput.commandDedupeWindow;
      if (!isRecord(window)) invalid();
      exactKeys(window, ["windowId", "windowSeq", "acceptUntilMs", "queryUntilMs"]);
      const commandDedupeWindow = {
        windowId: id(window.windowId),
        windowSeq: counter(window.windowSeq),
        acceptUntilMs: safeInteger(window.acceptUntilMs),
        queryUntilMs: safeInteger(window.queryUntilMs),
      };

      const selected = capabilities(buildInput.capabilities);

      let resumeDisposition: "caught_up" | "snapshot_required";
      let resumeReason: "matched" | "fresh" | "host_epoch_changed" | "cursor_behind";
      if (resumeCursor === null) {
        resumeDisposition = "snapshot_required";
        resumeReason = "fresh";
      } else if (resumeCursor.hostEpoch !== cutHostEpoch) {
        resumeDisposition = "snapshot_required";
        resumeReason = "host_epoch_changed";
      } else {
        const hostEventSeq = BigInt(cutEventSeq);
        const clientLastEventSeq = BigInt(resumeCursor.lastEventSeq);
        if (clientLastEventSeq > hostEventSeq) {
          throw new RelayV2HostRuntimeAuthorityError("EVENT_CURSOR_AHEAD", {
            clientLastEventSeq: resumeCursor.lastEventSeq,
            hostEventSeq: cutEventSeq,
          });
        }
        if (clientLastEventSeq === hostEventSeq && !cut.requiresSnapshot) {
          resumeDisposition = "caught_up";
          resumeReason = "matched";
        } else {
          resumeDisposition = "snapshot_required";
          resumeReason = "cursor_behind";
        }
      }

      return {
        protocolVersion: 2,
        kind: "response",
        type: "host.welcome",
        requestId,
        hostId,
        hostEpoch: cutHostEpoch,
        hostInstanceId: cutHostInstanceId,
        payload: {
          selectedVersion: 2,
          capabilities: selected,
          eventSeq: cutEventSeq,
          resumeDisposition,
          resumeReason,
          commandDedupeWindow,
          limits: { ...HOST_WELCOME_LIMITS },
        },
      };
    },
  });
}
