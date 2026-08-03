import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
  type RelayV2ContinuityAnchorCasRequest,
  type RelayV2ContinuityAnchorOptions,
  type RelayV2ContinuityAnchorReadRequest,
  type RelayV2ContinuityAnchorSnapshot,
  type RelayV2ContinuityCheckpoint,
  type RelayV2MonotonicCasAuthority,
} from "./continuityAnchor.js";
import {
  relayAgentAuthorityContinuityAnchorId,
  type RelayAgentAuthorityStoreOwner,
} from "../extensions/agentTranscriptLifecycle/v1/store.js";

const MAX_ANCHOR_BYTES = 64 * 1024;

interface PersistedAnchor {
  version: 1;
  anchorId: string;
  casToken: string;
  checkpoint: RelayV2ContinuityCheckpoint;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function genesis(anchorId: string): RelayV2ContinuityAnchorSnapshot {
  return {
    protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
    status: "uninitialized",
    anchorId,
    casToken: `genesis-${createHash("sha256").update(anchorId).digest("hex").slice(0, 32)}`,
  };
}

function sameCheckpoint(
  left: RelayV2ContinuityCheckpoint,
  right: RelayV2ContinuityCheckpoint,
): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.anchorId === right.anchorId
    && left.sequence === right.sequence
    && left.commitId === right.commitId
    && left.parentCommitId === right.parentCommitId
    && left.stateDigest === right.stateDigest;
}

function sameSnapshot(
  left: RelayV2ContinuityAnchorSnapshot,
  right: RelayV2ContinuityAnchorSnapshot,
): boolean {
  if (left.protocolVersion !== right.protocolVersion
    || left.status !== right.status
    || left.anchorId !== right.anchorId
    || left.casToken !== right.casToken) return false;
  return left.status === "uninitialized"
    ? true
    : right.status === "committed" && sameCheckpoint(left.checkpoint, right.checkpoint);
}

class SelfHostedFileMonotonicCasAuthority implements RelayV2MonotonicCasAuthority {
  readonly #anchorId: string;
  readonly #root: string;
  readonly #path: string;
  readonly #lockPath: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(home: string, anchorId: string) {
    this.#anchorId = anchorId;
    this.#root = join(home, ".tmux-worktree", "relay-agent-transcript-lifecycle-v1");
    this.#path = join(this.#root, "self-hosted-continuity-anchor-v1.json");
    this.#lockPath = join(this.#root, "self-hosted-continuity-anchor-v1.lock");
  }

  read(request: RelayV2ContinuityAnchorReadRequest): Promise<unknown> {
    return this.#serialize(() => {
      this.#validateRequest(request);
      return this.#withLock(() => clone(this.#readCurrent()));
    });
  }

  compareAndSwap(request: RelayV2ContinuityAnchorCasRequest): Promise<unknown> {
    return this.#serialize(() => {
      this.#validateRequest(request);
      return this.#withLock(() => {
        const current = this.#readCurrent();
        if (!sameSnapshot(current, request.expected)) {
          return {
            protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
            outcome: "conflict",
            current: clone(current),
          };
        }
        const next: RelayV2ContinuityAnchorSnapshot = {
          protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
          status: "committed",
          anchorId: this.#anchorId,
          casToken: `cas-${randomBytes(24).toString("base64url")}`,
          checkpoint: clone(request.next),
        };
        this.#write(next);
        return {
          protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
          outcome: "swapped",
          current: clone(next),
        };
      });
    });
  }

  #validateRequest(request: RelayV2ContinuityAnchorReadRequest | RelayV2ContinuityAnchorCasRequest): void {
    if (request.protocolVersion !== RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION
      || request.anchorId !== this.#anchorId
      || !(request.signal instanceof AbortSignal)
      || request.signal.aborted) throw new Error("self-hosted Agent continuity request is invalid");
  }

  #serialize<T>(operation: () => T): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }

  #ensureRoot(): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const stat = statSync(this.#root);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
      throw new Error("self-hosted Agent continuity directory is unsafe");
    }
  }

  #withLock<T>(operation: () => T): T {
    this.#ensureRoot();
    const descriptor = openSync(
      this.#lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(this.#lockPath, { force: true });
    }
  }

  #readCurrent(): RelayV2ContinuityAnchorSnapshot {
    let descriptor: number;
    try {
      descriptor = openSync(this.#path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return genesis(this.#anchorId);
      throw error;
    }
    try {
      const stat = fstatSync(descriptor);
      const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > MAX_ANCHOR_BYTES) {
        throw new Error("self-hosted Agent continuity file is unsafe");
      }
      const value = JSON.parse(readFileSync(descriptor, "utf8")) as PersistedAnchor;
      if (value === null || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "anchorId,casToken,checkpoint,version"
        || value.version !== 1 || value.anchorId !== this.#anchorId
        || typeof value.casToken !== "string" || value.casToken.length < 1
        || value.checkpoint === null || typeof value.checkpoint !== "object") {
        throw new Error("self-hosted Agent continuity file is malformed");
      }
      return {
        protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        status: "committed",
        anchorId: this.#anchorId,
        casToken: value.casToken,
        checkpoint: clone(value.checkpoint),
      };
    } finally {
      closeSync(descriptor);
    }
  }

  #write(snapshot: Extract<RelayV2ContinuityAnchorSnapshot, { status: "committed" }>): void {
    const value: PersistedAnchor = {
      version: 1,
      anchorId: this.#anchorId,
      casToken: snapshot.casToken,
      checkpoint: clone(snapshot.checkpoint),
    };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.byteLength > MAX_ANCHOR_BYTES) throw new Error("self-hosted Agent continuity file is too large");
    const temporary = `${this.#path}.tmp-${randomBytes(12).toString("hex")}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.#path);
      const directory = openSync(dirname(this.#path), fsConstants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }
}

/** Non-production, same-machine continuity used only by explicit self-hosted admission. */
export function createRelayV2HostSelfHostedAgentContinuityAnchor(
  home: string,
  owner: RelayAgentAuthorityStoreOwner,
): Readonly<RelayV2ContinuityAnchorOptions> {
  const anchorId = relayAgentAuthorityContinuityAnchorId(owner);
  return Object.freeze({
    anchorId,
    authority: new SelfHostedFileMonotonicCasAuthority(home, anchorId),
    operationTimeoutMs: 5_000,
    maxPendingOperations: 16,
  });
}
