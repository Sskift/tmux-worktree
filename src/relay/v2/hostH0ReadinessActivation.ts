import type {
  RelayV2HostCapabilityReadinessSourceSink,
} from "./hostCapabilityReadiness.js";
import type {
  RelayV2HostH0ReadinessLease,
  RelayV2HostH0ReadinessPort,
  RelayV2HostH0ReadinessReceiptIssue,
  RelayV2HostStateSnapshot,
} from "./hostState.js";

type HostStateH0CaptureModule = Pick<
  typeof import("./hostState.js"),
  "captureRelayV2HostH0ReadinessPort"
>;

// Root ESM entries are independently bundled. Keep this dynamic import
// external so activation consults the same hostState entry instance that
// registered the caller's port, rather than a duplicated bundle-local map.
const HOST_STATE_ENTRY_URL = new URL("./hostState.js", import.meta.url).href;
const hostStateH0CaptureModule = await import(HOST_STATE_ENTRY_URL) as
  HostStateH0CaptureModule;
const captureRegisteredH0Port =
  hostStateH0CaptureModule.captureRelayV2HostH0ReadinessPort;
if (typeof captureRegisteredH0Port !== "function") {
  throw new Error("Relay v2 H0 owner capture seam is unavailable");
}

export interface RelayV2HostH0ReadinessLifecycle {
  /** Performs a new durable no-op proof; no prior success is reusable. */
  activate(): Promise<boolean>;
  /** Withdraws H0 and releases the current proof without disposing the owner. */
  close(): void;
}

export interface RelayV2HostH0ReadinessActivationOptions {
  hostEpoch: string;
  hostInstanceId: string;
  h0Port: RelayV2HostH0ReadinessPort;
  readinessSink: RelayV2HostCapabilityReadinessSourceSink<"h0">;
}

export interface RelayV2HostH0ReadinessActivation {
  readonly runtimeH0: Readonly<{
    read(): Promise<RelayV2HostStateSnapshot>;
  }>;
  readonly lifecycle: RelayV2HostH0ReadinessLifecycle;
  dispose(): void;
}

interface H0MutationAttempt {
  readonly epoch: bigint;
}

interface H0ActivationRecord {
  readonly attempt: H0MutationAttempt;
  lease: RelayV2HostH0ReadinessLease | null;
  active: boolean;
  retired: boolean;
  releaseAttempted: boolean;
  ownerInvalidated: boolean;
  cleanupError: unknown | null;
}

const MAX_H0_SOURCE_GENERATION = 18_446_744_073_709_551_615n;

function captureH0Port(value: unknown): RelayV2HostH0ReadinessPort | null {
  try {
    const captured = captureRegisteredH0Port(value);
    return captured === value ? captured : null;
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
      if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function decodeReceiptIssue(value: unknown): RelayV2HostH0ReadinessReceiptIssue | null {
  const issue = exactOwnDataDescriptors(value, ["receipt", "binding"]);
  if (issue === null) return null;
  const receipt = issue.receipt!.value;
  if (((typeof receipt !== "object" && typeof receipt !== "function") || receipt === null)) {
    return null;
  }
  const binding = exactOwnDataDescriptors(issue.binding!.value, [
    "hostEpoch",
    "hostInstanceId",
    "commitSeq",
    "proofGeneration",
  ]);
  if (binding === null) return null;
  const captured = {
    hostEpoch: binding.hostEpoch!.value,
    hostInstanceId: binding.hostInstanceId!.value,
    commitSeq: binding.commitSeq!.value,
    proofGeneration: binding.proofGeneration!.value,
  };
  if (typeof captured.hostEpoch !== "string" || captured.hostEpoch.length === 0
    || typeof captured.hostInstanceId !== "string" || captured.hostInstanceId.length === 0
    || typeof captured.commitSeq !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(captured.commitSeq)
    || typeof captured.proofGeneration !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(captured.proofGeneration)) return null;
  return Object.freeze({
    receipt,
    binding: Object.freeze(captured),
  }) as RelayV2HostH0ReadinessReceiptIssue;
}

function isLease(value: unknown): value is RelayV2HostH0ReadinessLease {
  return ((typeof value === "object" && value !== null) || typeof value === "function");
}

function observeThenable(value: unknown): void {
  if (((typeof value !== "object" || value === null) && typeof value !== "function")) return;
  try {
    if (typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
    }
  } catch {}
}

export function createRelayV2HostH0ReadinessActivation(
  options: RelayV2HostH0ReadinessActivationOptions,
): RelayV2HostH0ReadinessActivation {
  const hostEpoch = options.hostEpoch;
  const hostInstanceId = options.hostInstanceId;
  const readinessSink = options.readinessSink;
  const h0 = captureH0Port(options.h0Port);
  if (h0 === null) throw new Error("invalid Relay v2 H0 readiness port");

  let disposed = false;
  let mutationEpoch = 0n;
  let currentAttempt: H0MutationAttempt | null = null;
  let synchronousMutationDepth = 0;
  let sourceGeneration = 0n;
  let sourceWithdrawn = false;
  let active: H0ActivationRecord | null = null;

  const withSynchronousMutation = <Result>(operation: () => Result): Result => {
    synchronousMutationDepth += 1;
    try {
      return operation();
    } finally {
      synchronousMutationDepth -= 1;
    }
  };

  const claimAttempt = (): H0MutationAttempt => {
    mutationEpoch += 1n;
    const attempt = Object.freeze({ epoch: mutationEpoch });
    currentAttempt = attempt;
    return attempt;
  };

  const invalidateAttempt = (): void => {
    mutationEpoch += 1n;
    currentAttempt = null;
  };

  const isCurrentAttempt = (attempt: H0MutationAttempt): boolean => (
    !disposed && currentAttempt === attempt && attempt.epoch === mutationEpoch
  );

  const finishAttempt = (attempt: H0MutationAttempt): false => {
    if (currentAttempt === attempt) currentAttempt = null;
    return false;
  };

  const withdrawSource = (): unknown | null => {
    if (sourceWithdrawn) return null;
    sourceWithdrawn = true;
    try {
      readinessSink.close();
      return null;
    } catch (error) {
      return error;
    }
  };

  const releaseRecord = (record: H0ActivationRecord): unknown | null => {
    if (record.lease === null || record.releaseAttempted) return null;
    record.releaseAttempted = true;
    try {
      const released = h0.releaseReadinessLease(record.lease);
      if (released === true || record.ownerInvalidated) return null;
      return new Error("Relay v2 H0 readiness lease release was rejected");
    } catch (error) {
      return error;
    }
  };

  const retireRecord = (record: H0ActivationRecord): unknown | null => {
    let withdrawError: unknown | null = null;
    if (!record.retired) {
      record.retired = true;
      record.active = false;
      if (active === record) active = null;
      withdrawError = withdrawSource();
    }
    // consumeReadinessReceipt may synchronously close the sink before it
    // returns its lease. A retired record must still release that late lease.
    const releaseError = releaseRecord(record);
    record.cleanupError ??= withdrawError ?? releaseError;
    return record.cleanupError;
  };

  const failClosed = (primary: unknown | null = null): unknown | null => {
    invalidateAttempt();
    return withSynchronousMutation(() => {
      const current = active;
      const withdrawError = withdrawSource();
      const releaseError = current === null ? null : retireRecord(current);
      return primary ?? withdrawError ?? releaseError;
    });
  };

  const runtimeH0 = Object.freeze({
    async read(): Promise<RelayV2HostStateSnapshot> {
      try {
        if (disposed) throw new Error("Relay v2 H0 readiness activation is disposed");
        const snapshot = await h0.read();
        if (snapshot.hostEpoch !== hostEpoch
          || snapshot.hostInstanceId !== hostInstanceId) {
          throw new Error("Relay v2 H0 runtime lineage changed");
        }
        return snapshot;
      } catch (error) {
        failClosed(error);
        throw error;
      }
    },
  });

  const lifecycle: RelayV2HostH0ReadinessLifecycle = Object.freeze({
    async activate(): Promise<boolean> {
      // Fence the exact attempt before the first owner-controlled await.
      const attempt = claimAttempt();
      if (disposed || synchronousMutationDepth > 0) return finishAttempt(attempt);

      let rawIssue: RelayV2HostH0ReadinessReceiptIssue;
      try {
        rawIssue = await h0.issueReadinessReceipt();
      } catch (error) {
        if (!isCurrentAttempt(attempt)) return finishAttempt(attempt);
        const propagated = failClosed(error);
        throw propagated;
      }

      // Recheck before touching any owner-returned descriptors.
      if (!isCurrentAttempt(attempt)) return finishAttempt(attempt);
      const issue = decodeReceiptIssue(rawIssue);
      if (!isCurrentAttempt(attempt)) return finishAttempt(attempt);
      if (issue === null
        || issue.binding.hostEpoch !== hostEpoch
        || issue.binding.hostInstanceId !== hostInstanceId) {
        if (issue !== null) {
          try { h0.discardReadinessReceipt(issue.receipt); } catch {}
        }
        const cleanupError = failClosed();
        if (cleanupError !== null) throw cleanupError;
        return false;
      }

      const record: H0ActivationRecord = {
        attempt,
        lease: null,
        active: false,
        retired: false,
        releaseAttempted: false,
        ownerInvalidated: false,
        cleanupError: null,
      };
      const leaseSink = Object.freeze({
        close(): void {
          if (record.retired) return;
          record.ownerInvalidated = true;
          if (currentAttempt === record.attempt) invalidateAttempt();
          withSynchronousMutation(() => { retireRecord(record); });
        },
      });

      try {
        // This synchronous consume is intentionally before any later await.
        record.lease = h0.consumeReadinessReceipt(
          issue.receipt,
          issue.binding,
          leaseSink,
        );
      } catch (error) {
        const propagated = failClosed(error);
        throw propagated;
      }
      if (!isLease(record.lease)) {
        const cleanupError = failClosed();
        if (cleanupError !== null) throw cleanupError;
        return finishAttempt(attempt);
      }
      if (!isCurrentAttempt(attempt) || record.retired) {
        const cleanupError = withSynchronousMutation(() => retireRecord(record));
        if (cleanupError !== null) throw cleanupError;
        return finishAttempt(attempt);
      }
      if (sourceGeneration >= MAX_H0_SOURCE_GENERATION) {
        const cleanupError = withSynchronousMutation(() => retireRecord(record));
        if (cleanupError !== null) throw cleanupError;
        return finishAttempt(attempt);
      }

      sourceGeneration += 1n;
      let accepted = false;
      let publicationError: unknown | null = null;
      withSynchronousMutation(() => {
        if (!isCurrentAttempt(attempt)) return;
        record.active = true;
        active = record;
        sourceWithdrawn = false;
        try {
          const result = readinessSink.apply(Object.freeze({
            source: "h0",
            generation: sourceGeneration.toString(10),
            ready: true,
          }));
          accepted = result === true;
          if (!accepted) observeThenable(result);
        } catch (error) {
          publicationError = error;
        }
        if (!accepted
          || publicationError !== null
          || !isCurrentAttempt(attempt)
          || active !== record
          || record.retired) {
          const cleanupError = retireRecord(record);
          publicationError ??= cleanupError;
        }
      });
      if (publicationError !== null) throw publicationError;
      if (!accepted
        || !isCurrentAttempt(attempt)
        || active !== record
        || record.retired) return finishAttempt(attempt);

      currentAttempt = null;
      return true;
    },
    close(): void {
      if (disposed) return;
      invalidateAttempt();
      const cleanupError = withSynchronousMutation(() => {
        const current = active;
        const withdrawError = withdrawSource();
        const releaseError = current === null ? null : retireRecord(current);
        return withdrawError ?? releaseError;
      });
      if (cleanupError !== null) throw cleanupError;
    },
  });

  return Object.freeze({
    runtimeH0,
    lifecycle,
    dispose(): void {
      if (disposed) return;
      invalidateAttempt();
      disposed = true;
      withSynchronousMutation(() => {
        const current = active;
        withdrawSource();
        if (current !== null) retireRecord(current);
      });
    },
  });
}
