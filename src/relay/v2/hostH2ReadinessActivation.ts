import { isPromise } from "node:util/types";
import type { RelayV2JsonObject } from "./codecSchema.js";
import type {
  RelayV2HostCapabilityReadinessSourceSink,
} from "./hostCapabilityReadiness.js";
import type {
  RelayV2MaterializedStateRuntimeH2Port,
  RelayV2StateEventSink,
} from "./resourceState.js";
import type {
  RelayV2StateSnapshotHostH2Authority,
  RelayV2StateSnapshotHostSpoolPort,
  RelayV2StateSnapshotActivationLease,
  RelayV2StateSnapshotReadinessReceiptBinding,
  RelayV2StateSnapshotReadinessReceiptIssue,
} from "./stateSnapshotSpool.js";

export type RelayV2HostH2ReadinessSnapshotSpool = RelayV2StateSnapshotHostSpoolPort;

export interface RelayV2HostH2ReadinessLifecycle {
  /** Consumes one exact, live receipt from this owner's captured spool. */
  activate(issue: RelayV2StateSnapshotReadinessReceiptIssue): Promise<boolean>;
  /** Withdraws H2 and releases this owner generation without disposing the owner. */
  close(): void;
}

export interface RelayV2HostH2ReadinessActivationOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  authority: RelayV2StateSnapshotHostH2Authority;
  readinessSink: RelayV2HostCapabilityReadinessSourceSink<"h2">;
}

/**
 * Deep H2 lifecycle owner. The captured spool port is also the sole port that
 * the surrounding runtime may use, preventing split receipt/runtime authority.
 */
export interface RelayV2HostH2ReadinessActivation {
  readonly runtimeH2: RelayV2MaterializedStateRuntimeH2Port;
  readonly snapshotSpool: RelayV2HostH2ReadinessSnapshotSpool;
  readonly lifecycle: RelayV2HostH2ReadinessLifecycle;
  dispose(): void;
}

interface H2MutationAttempt {
  readonly epoch: bigint;
}

interface H2ActivationRecord {
  readonly attempt: H2MutationAttempt;
  active: boolean;
  retired: boolean;
  released: boolean;
  lease: RelayV2StateSnapshotActivationLease | null;
}

const MAX_H2_SOURCE_GENERATION = 18_446_744_073_709_551_615n;

const NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const STATE_SNAPSHOT_HOST_H2_AUTHORITY_ISSUER = Symbol.for(
  "tmux-worktree.relay-v2.state-snapshot-host-h2-authority-issuer",
);
const STATE_SNAPSHOT_HOST_H2_AUTHORITY_CAPTURE = Symbol.for(
  "tmux-worktree.relay-v2.state-snapshot-host-h2-authority-capture",
);

interface CapturedHostH2Authority {
  readonly runtimeH2: RelayV2MaterializedStateRuntimeH2Port;
  readonly snapshotSpool: RelayV2StateSnapshotHostSpoolPort;
}

function exactAuthorityDataDescriptor(
  owner: object,
  property: PropertyKey,
): PropertyDescriptor | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.configurable !== false
      || descriptor.writable !== false) return null;
    return descriptor;
  } catch {
    return null;
  }
}

/** Private verifier inlined into the composition entry; no split ports escape. */
function captureHostH2Authority(authority: unknown): CapturedHostH2Authority | null {
  if (((typeof authority !== "object" || authority === null)
    && typeof authority !== "function")) return null;
  const issuerDescriptor = exactAuthorityDataDescriptor(
    authority as object,
    STATE_SNAPSHOT_HOST_H2_AUTHORITY_ISSUER,
  );
  if (issuerDescriptor === null
    || ((typeof issuerDescriptor.value !== "object" || issuerDescriptor.value === null)
      && typeof issuerDescriptor.value !== "function")) return null;
  const issuer = issuerDescriptor.value as object;
  const captureDescriptor = exactAuthorityDataDescriptor(
    issuer,
    STATE_SNAPSHOT_HOST_H2_AUTHORITY_CAPTURE,
  );
  if (captureDescriptor === null || typeof captureDescriptor.value !== "function") return null;
  try {
    const binding = Reflect.apply(captureDescriptor.value, issuer, [authority]);
    if (!binding || typeof binding !== "object") return null;
    return binding as CapturedHostH2Authority;
  } catch {
    return null;
  }
}

function exactOwnDataDescriptors(
  value: unknown,
  keys: readonly string[],
): Record<string, PropertyDescriptor> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Reflect.ownKeys(descriptors);
    if (actualKeys.length !== keys.length
      || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function decodeH2ReadinessIssue(
  value: unknown,
): Readonly<{
  receipt: unknown;
  binding: Readonly<RelayV2StateSnapshotReadinessReceiptBinding>;
}> | null {
  const issue = exactOwnDataDescriptors(value, ["receipt", "binding"]);
  if (issue === null) return null;
  const receipt = issue.receipt!.value as unknown;
  if (((typeof receipt !== "object" && typeof receipt !== "function") || receipt === null)) {
    return null;
  }
  const binding = exactOwnDataDescriptors(issue.binding!.value, [
    "hostId",
    "hostEpoch",
    "hostInstanceId",
    "materializedCutIdentity",
  ]);
  if (binding === null) return null;
  const captured = {
    hostId: binding.hostId!.value,
    hostEpoch: binding.hostEpoch!.value,
    hostInstanceId: binding.hostInstanceId!.value,
    materializedCutIdentity: binding.materializedCutIdentity!.value,
  };
  if (Object.values(captured).some((field) => typeof field !== "string" || field.length === 0)) {
    return null;
  }
  return Object.freeze({
    receipt,
    binding: Object.freeze(captured) as RelayV2StateSnapshotReadinessReceiptBinding,
  });
}

function isActivationLease(value: unknown): value is RelayV2StateSnapshotActivationLease {
  return ((typeof value === "object" && value !== null) || typeof value === "function");
}

export function createRelayV2HostH2ReadinessActivation(
  options: RelayV2HostH2ReadinessActivationOptions,
): RelayV2HostH2ReadinessActivation {
  const hostId = options.hostId;
  const hostEpoch = options.hostEpoch;
  const hostInstanceId = options.hostInstanceId;
  const readinessSink = options.readinessSink;
  const authority = captureHostH2Authority(options.authority);
  if (authority === null) {
    throw new Error("invalid Relay v2 bound H2 snapshot authority");
  }
  const runtimeH2 = authority.runtimeH2;
  const snapshotSpool = authority.snapshotSpool;

  let disposed = false;
  let activationAuthorityFailed = false;
  let mutationEpoch = 0n;
  let currentAttempt: H2MutationAttempt | null = null;
  let synchronousMutationDepth = 0;
  let sourceGeneration = 0n;
  let sourceWithdrawn = false;
  let active: H2ActivationRecord | null = null;

  const withSynchronousMutation = <Result>(operation: () => Result): Result => {
    synchronousMutationDepth += 1;
    try {
      return operation();
    } finally {
      synchronousMutationDepth -= 1;
    }
  };

  const claimAttempt = (): H2MutationAttempt => {
    mutationEpoch += 1n;
    const attempt = Object.freeze({ epoch: mutationEpoch });
    currentAttempt = attempt;
    return attempt;
  };

  const invalidateAttempt = (): void => {
    mutationEpoch += 1n;
    currentAttempt = null;
  };

  const isCurrentAttempt = (attempt: H2MutationAttempt): boolean => (
    !disposed
    && !activationAuthorityFailed
    && currentAttempt === attempt
    && attempt.epoch === mutationEpoch
  );

  const finishAttempt = (attempt: H2MutationAttempt): false => {
    if (currentAttempt === attempt) currentAttempt = null;
    return false;
  };

  function releaseActivation(record: H2ActivationRecord): void {
    record.active = false;
    record.retired = true;
    if (record.lease === null || record.released) return;
    const lease = record.lease;
    record.released = true;
    withSynchronousMutation(() => {
      let result: unknown;
      try {
        result = snapshotSpool.releaseReadinessActivation(lease);
      } catch {
        failClosedActivationAuthority();
        return;
      }
      if (result === undefined) return;
      if (!isPromise(result)) {
        failClosedActivationAuthority();
        return;
      }
      let safeNativePromise = false;
      try {
        safeNativePromise = Object.getPrototypeOf(result) === NATIVE_PROMISE_PROTOTYPE
          && Object.getOwnPropertyDescriptor(result, "constructor") === undefined;
      } catch {
        safeNativePromise = false;
      }
      if (!safeNativePromise) {
        failClosedActivationAuthority();
        return;
      }
      try {
        Reflect.apply(NATIVE_PROMISE_THEN, result, [
          undefined,
          () => {
            try { failClosedActivationAuthority(); } catch {}
          },
        ]);
      } catch {
        failClosedActivationAuthority();
      }
    });
  }

  const withdrawSource = (): void => {
    if (sourceWithdrawn) return;
    sourceWithdrawn = true;
    withSynchronousMutation(() => {
      try { readinessSink.close(); } catch {}
    });
  };

  function failClosedActivationAuthority(): void {
    if (disposed || activationAuthorityFailed) return;
    activationAuthorityFailed = true;
    invalidateAttempt();
    withSynchronousMutation(() => {
      const current = active;
      active = null;
      withdrawSource();
      if (current !== null) releaseActivation(current);
    });
  }

  const retireActive = (record: H2ActivationRecord): void => {
    if (active !== record || record.retired) return;
    invalidateAttempt();
    active = null;
    record.active = false;
    withdrawSource();
    releaseActivation(record);
  };

  const nextGeneration = (): string | null => {
    if (sourceGeneration >= MAX_H2_SOURCE_GENERATION) return null;
    sourceGeneration += 1n;
    return sourceGeneration.toString(10);
  };

  const lifecycle: RelayV2HostH2ReadinessLifecycle = Object.freeze({
    async activate(input: RelayV2StateSnapshotReadinessReceiptIssue): Promise<boolean> {
      // This exact attempt exists before any caller-owned descriptor trap runs.
      const attempt = claimAttempt();
      if (disposed || activationAuthorityFailed || synchronousMutationDepth > 0) {
        return finishAttempt(attempt);
      }
      const issue = decodeH2ReadinessIssue(input);
      if (!isCurrentAttempt(attempt)
        || issue === null
        || issue.binding.hostId !== hostId
        || issue.binding.hostEpoch !== hostEpoch
        || issue.binding.hostInstanceId !== hostInstanceId) return finishAttempt(attempt);

      let verified = false;
      try {
        if (!isCurrentAttempt(attempt)) return finishAttempt(attempt);
        verified = await snapshotSpool.verifyReadinessReceipt(issue.receipt, issue.binding);
      } catch {
        return finishAttempt(attempt);
      }
      if (!isCurrentAttempt(attempt) || verified !== true) return finishAttempt(attempt);

      const record: H2ActivationRecord = {
        attempt,
        active: false,
        retired: false,
        released: false,
        lease: null,
      };
      const sink: RelayV2StateEventSink<RelayV2JsonObject> = Object.freeze({
        enqueue(): boolean {
          return !disposed
            && !record.retired
            && (record.active ? active === record : isCurrentAttempt(record.attempt));
        },
        close(): void {
          if (record.retired) return;
          if (active === record && record.active) {
            retireActive(record);
          } else {
            if (currentAttempt === record.attempt) invalidateAttempt();
            releaseActivation(record);
          }
        },
      });

      let lease: RelayV2StateSnapshotActivationLease;
      try {
        if (!isCurrentAttempt(attempt)) return finishAttempt(attempt);
        lease = await snapshotSpool.activateReadinessReceipt(issue.receipt, sink);
      } catch {
        releaseActivation(record);
        return finishAttempt(attempt);
      }
      if (!isActivationLease(lease)) {
        releaseActivation(record);
        return finishAttempt(attempt);
      }
      record.lease = lease;
      if (record.retired || !isCurrentAttempt(attempt)) {
        releaseActivation(record);
        return finishAttempt(attempt);
      }

      const generation = nextGeneration();
      if (generation === null) {
        withSynchronousMutation(() => {
          const previous = active;
          active = null;
          withdrawSource();
          if (previous !== null) releaseActivation(previous);
          releaseActivation(record);
        });
        return finishAttempt(attempt);
      }

      let publicationAttempted = false;
      let publicationCompleted = false;
      withSynchronousMutation(() => {
        if (!isCurrentAttempt(attempt)) return;
        publicationAttempted = true;
        const previous = active;
        if (previous !== null && previous !== record) {
          active = null;
          // Withdraw the previous generation synchronously before its release
          // callback can reenter. Recovery below uses the already-claimed
          // strictly greater source generation.
          withdrawSource();
          releaseActivation(previous);
          if (!isCurrentAttempt(attempt)) {
            releaseActivation(record);
            return;
          }
        }
        record.active = true;
        active = record;
        sourceWithdrawn = false;
        let accepted = false;
        try {
          accepted = readinessSink.apply({ source: "h2", generation, ready: true }) === true;
        } catch {}
        if (!accepted
          || !isCurrentAttempt(attempt)
          || active !== record
          || record.retired) {
          if (active === record) active = null;
          record.active = false;
          withdrawSource();
          releaseActivation(record);
          return;
        }

        // Both readiness fanout and release are synchronous reentrancy seams.
        if (!isCurrentAttempt(attempt)
          || active !== record
          || !record.active
          || record.retired) {
          if (active === record) active = null;
          record.active = false;
          withdrawSource();
          releaseActivation(record);
          return;
        }
        publicationCompleted = true;
      });
      if (!publicationAttempted) releaseActivation(record);
      if (!publicationCompleted) return finishAttempt(attempt);
      if (!isCurrentAttempt(attempt) || active !== record || record.retired) {
        withSynchronousMutation(() => {
          if (active === record) active = null;
          withdrawSource();
          releaseActivation(record);
        });
        return finishAttempt(attempt);
      }
      currentAttempt = null;
      return true;
    },
    close(): void {
      if (disposed) return;
      invalidateAttempt();
      withSynchronousMutation(() => {
        const current = active;
        active = null;
        withdrawSource();
        if (current !== null) releaseActivation(current);
      });
    },
  });

  return Object.freeze({
    runtimeH2,
    snapshotSpool,
    lifecycle,
    dispose(): void {
      if (disposed) return;
      invalidateAttempt();
      disposed = true;
      withSynchronousMutation(() => {
        const current = active;
        active = null;
        withdrawSource();
        if (current !== null) releaseActivation(current);
      });
    },
  });
}
