import { types as nodeUtilTypes } from "node:util";

/**
 * setTimeout's signed-32-bit delay ceiling; anything wider can never be armed
 * honestly, so the closed configuration rejects it instead of clamping.
 */
export const RELAY_V2_MATERIALIZED_RECONCILE_LIFECYCLE_MAX_SCAN_INTERVAL_MS = 2_147_483_647;

/**
 * Closed outcome of one scheduled reconcile pass. "reconciled" means the
 * materialized foundation applied its own fail-closed semantics (a partial or
 * unreachable scan is still a successful pass that never deletes unobserved
 * resources); "failed" means the foundation rejected the pass and applied its
 * own withdrawal/fence internally; "closed" means this owner refused or
 * drained the trigger without starting a scan.
 */
export type RelayV2MaterializedReconcileLifecycleScanOutcome =
  | "reconciled"
  | "failed"
  | "closed";

/**
 * Narrow boundary to the existing materialized authority. Production wiring
 * must bind exactly `RelayV2MaterializedStateFoundation.reconcile`; this owner
 * never performs discovery, SSH/tmux/git access, or state mutation of its own.
 */
export interface RelayV2MaterializedReconcilePort {
  reconcile(): Promise<unknown>;
}

/**
 * Optional caller-owned discovery/config swap boundary (for example the
 * canonical config-snapshot foundation's reconfigure). It runs only after the
 * in-flight old-configuration scan has fully drained, so a late
 * old-generation result can never be written into new-generation materialized
 * state. A throw rejects reconfigure() after the fail-closed follow-up scan
 * has still been scheduled.
 */
export interface RelayV2MaterializedReconfigurationPort {
  apply(): unknown | Promise<unknown>;
}

/**
 * Strictly closed owner configuration. It is snapshotted synchronously at
 * call time; the owner never re-reads the caller's object after an await.
 */
export interface RelayV2MaterializedReconcileLifecycleConfiguration {
  readonly scanIntervalMs: number;
}

export interface RelayV2MaterializedReconcileLifecycleOwnerOptions {
  readonly reconcilePort: RelayV2MaterializedReconcilePort;
  readonly applyReconfiguration?: RelayV2MaterializedReconfigurationPort;
  readonly scanIntervalMs: number;
}

type ScanOutcome = RelayV2MaterializedReconcileLifecycleScanOutcome;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface CapturedMethodPort {
  receiver: object;
  method: (...args: unknown[]) => unknown;
}

interface ActiveScan {
  settle: Promise<ScanOutcome>;
  outcome: Deferred<ScanOutcome>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

/**
 * Reads an exact own-data record with the given required and optional keys.
 * Proxies, non-plain prototypes, accessors, symbols, non-enumerable extras
 * and any other key are rejected. Every accepted value is copied out
 * synchronously, so callers cannot mutate the owner's view after the fact.
 */
function readExactOwnDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value) || isRejectedProxy(value)) {
    throw new TypeError(`invalid ${label}`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`invalid ${label}`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => descriptors[key] === undefined)
      || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
      throw new TypeError(`${label} is not a closed record`);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label} must carry only own data properties`);
      }
      snapshot[key as string] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`invalid ${label}`);
  }
}

/**
 * Validates the strictly closed configuration shape and copies its single
 * scalar into an owner-private frozen record before any asynchronous work.
 */
function snapshotLifecycleConfiguration(
  value: unknown,
): RelayV2MaterializedReconcileLifecycleConfiguration {
  const snapshot = readExactOwnDataRecord(
    value,
    ["scanIntervalMs"],
    [],
    "Relay v2 materialized reconcile lifecycle configuration",
  );
  const scanIntervalMs = snapshot.scanIntervalMs;
  if (!Number.isSafeInteger(scanIntervalMs)
    || (scanIntervalMs as number) < 1
    || (scanIntervalMs as number)
      > RELAY_V2_MATERIALIZED_RECONCILE_LIFECYCLE_MAX_SCAN_INTERVAL_MS) {
    throw new TypeError("invalid Relay v2 materialized reconcile scan interval");
  }
  return Object.freeze({ scanIntervalMs: scanIntervalMs as number });
}

function captureMethodPort(
  value: unknown,
  method: string,
  label: string,
): CapturedMethodPort {
  if (!isRecord(value) || isRejectedProxy(value)) {
    throw new TypeError(`invalid ${label}`);
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, method);
    if (descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function") {
      throw new TypeError(`invalid ${label}`);
    }
    return { receiver: value, method: descriptor.value as (...args: unknown[]) => unknown };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`invalid ${label}`);
  }
}

/**
 * Default-off, single-responsibility lifecycle owner for continuous
 * discovery/materialized reconciliation. It owns only scheduling: one
 * immediate scan on start(), a self-re-arming periodic trigger, explicit
 * signal triggers, generation-fenced reconfigure(), and close() drain.
 *
 * It never overlaps scans inside itself. Triggers that arrive while a scan
 * (or a reconfiguration barrier) is active coalesce into at most one
 * successor scan; every caller of the same batch shares that batch's single
 * outcome promise, so no per-caller queue can grow without bound.
 *
 * All scan semantics — partial/unreachable fail-closed handling, authority
 * conflicts, readiness withdrawal — remain with the injected materialized
 * foundation; this owner adds no retry, backoff, cache, second state machine,
 * capability, or production wiring of its own. Constructing it has no side
 * effects.
 */
export class RelayV2MaterializedReconcileLifecycleOwner {
  private readonly reconcilePort: CapturedMethodPort;

  private readonly reconfigurationPort: CapturedMethodPort | null;

  private scanIntervalMs: number;

  private started = false;

  private closed = false;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private activeScan: ActiveScan | null = null;

  /** Shared outcome owner of the single coalesced successor batch. */
  private nextScan: Deferred<ScanOutcome> | null = null;

  private reconfiguration: Deferred<void> | null = null;

  private closeBarrier: Promise<void> | null = null;

  constructor(options: RelayV2MaterializedReconcileLifecycleOwnerOptions) {
    const snapshot = readExactOwnDataRecord(
      options,
      ["reconcilePort", "scanIntervalMs"],
      ["applyReconfiguration"],
      "Relay v2 materialized reconcile lifecycle options",
    );
    this.reconcilePort = captureMethodPort(
      snapshot.reconcilePort,
      "reconcile",
      "Relay v2 materialized reconcile port",
    );
    this.reconfigurationPort = snapshot.applyReconfiguration === undefined
      ? null
      : captureMethodPort(
        snapshot.applyReconfiguration,
        "apply",
        "Relay v2 materialized reconfiguration port",
      );
    this.scanIntervalMs = snapshotLifecycleConfiguration({
      scanIntervalMs: snapshot.scanIntervalMs,
    }).scanIntervalMs;
  }

  /**
   * One-shot activation: schedules the immediate startup scan and resolves
   * with its outcome. The periodic trigger re-arms only after each scan
   * settles, so a slow scan can never be overlapped by its own timer.
   */
  start(): Promise<ScanOutcome> {
    if (this.started || this.closed) {
      throw new Error("Relay v2 materialized reconcile lifecycle owner is unavailable");
    }
    this.started = true;
    return this.requestScan();
  }

  /**
   * Explicit signal trigger; coalesces with any active scan or barrier into
   * the shared successor outcome. Calling it before start() is a sequencing
   * error and fails closed without any scan; after close() it resolves
   * "closed" so late signal sources stay harmless.
   */
  triggerScan(): Promise<ScanOutcome> {
    if (!this.started && !this.closed) {
      throw new Error("Relay v2 materialized reconcile lifecycle owner is unavailable");
    }
    return this.requestScan();
  }

  /**
   * Generation-fenced reconfiguration. The closed input is snapshotted
   * synchronously; the in-flight old-generation scan is then fully drained
   * before the caller-owned swap runs, and exactly one new-generation scan
   * carries every trigger that coalesced during the barrier. A failing swap
   * rejects this promise while the fail-closed follow-up scan still runs.
   */
  async reconfigure(
    configuration: RelayV2MaterializedReconcileLifecycleConfiguration,
  ): Promise<ScanOutcome> {
    if (!this.started || this.closed) {
      throw new Error("Relay v2 materialized reconcile lifecycle owner is unavailable");
    }
    if (this.reconfiguration !== null) {
      throw new TypeError("Relay v2 materialized reconcile reconfiguration is already active");
    }
    const snapshot = snapshotLifecycleConfiguration(configuration);
    const barrier = deferred<void>();
    this.reconfiguration = barrier;
    this.clearTimer();
    let applyError: unknown;
    let applyFailed = false;
    try {
      if (this.activeScan !== null) {
        await this.activeScan.settle;
      }
      if (!this.closed) {
        this.scanIntervalMs = snapshot.scanIntervalMs;
        if (this.reconfigurationPort !== null) {
          try {
            await Reflect.apply(
              this.reconfigurationPort.method,
              this.reconfigurationPort.receiver,
              [],
            );
          } catch (error) {
            applyError = error;
            applyFailed = true;
          }
        }
      }
    } finally {
      if (this.reconfiguration === barrier) this.reconfiguration = null;
      barrier.resolve();
    }
    if (this.closed) {
      this.flushNextScan("closed");
      if (applyFailed) throw applyError;
      return "closed";
    }
    const batch = this.nextScan ?? deferred<ScanOutcome>();
    this.nextScan = null;
    this.startScan(batch);
    if (applyFailed) throw applyError;
    return batch.promise;
  }

  /**
   * Stops the timer, refuses new triggers, and drains the started scan (and
   * any active reconfiguration barrier) before resolving. No timer or scan
   * continuation schedules further work after close.
   */
  close(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.closed = true;
    this.clearTimer();
    this.closeBarrier = (async () => {
      if (this.reconfiguration !== null) {
        await this.reconfiguration.promise;
      }
      if (this.activeScan !== null) {
        await this.activeScan.settle;
      }
    })();
    return this.closeBarrier;
  }

  private requestScan(): Promise<ScanOutcome> {
    if (this.closed || !this.started) return Promise.resolve("closed");
    if (this.activeScan !== null || this.reconfiguration !== null) {
      this.nextScan ??= deferred<ScanOutcome>();
      return this.nextScan.promise;
    }
    const batch = deferred<ScanOutcome>();
    this.startScan(batch);
    return batch.promise;
  }

  private startScan(outcome: Deferred<ScanOutcome>): void {
    let raw: unknown;
    try {
      raw = Reflect.apply(this.reconcilePort.method, this.reconcilePort.receiver, []);
    } catch {
      raw = Promise.reject(new Error("Relay v2 materialized reconcile port rejected"));
    }
    const settle = Promise.resolve(raw).then<ScanOutcome>(
      () => "reconciled",
      () => "failed",
    );
    const scan: ActiveScan = { settle, outcome };
    this.activeScan = scan;
    void settle.then((scanOutcome) => {
      if (this.activeScan === scan) this.settleScan(scanOutcome);
    });
  }

  private settleScan(outcome: ScanOutcome): void {
    const scan = this.activeScan;
    this.activeScan = null;
    scan?.outcome.resolve(outcome);
    if (this.closed) {
      this.flushNextScan("closed");
      return;
    }
    if (this.reconfiguration !== null) {
      // The barrier owner resumes after this drain point and starts the
      // single new-generation scan carrying the shared successor batch.
      return;
    }
    if (this.nextScan !== null) {
      const batch = this.nextScan;
      this.nextScan = null;
      this.startScan(batch);
      return;
    }
    this.armTimer();
  }

  private flushNextScan(outcome: ScanOutcome): void {
    const batch = this.nextScan;
    this.nextScan = null;
    batch?.resolve(outcome);
  }

  private armTimer(): void {
    this.clearTimer();
    if (!this.started || this.closed || this.reconfiguration !== null) return;
    const timer = setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      void this.requestScan();
    }, this.scanIntervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  private clearTimer(): void {
    const timer = this.timer;
    this.timer = null;
    if (timer !== null) clearTimeout(timer);
  }
}
