import { randomUUID } from "node:crypto";

import { RELAY_V2_HOST_SUPERSEDED_EXIT_CODE } from "./hostCarrier.js";
import {
  RELAY_V2_HOST_CONNECTOR_MONITOR_INTERVAL_MS,
  RELAY_V2_HOST_RECONNECT_INITIAL_DELAY_MS,
  RELAY_V2_HOST_RECONNECT_MAXIMUM_DELAY_MS,
  nextRelayV2HostReconnectDelayMs,
  waitForRelayV2HostReconnectDelay,
} from "./hostReconnectBackoff.js";
import type { RelayV2HostManagedConnectorInspection } from "./hostRuntimeComposition.js";
import type { RelayV2HostShippingRootHandle } from "./hostShippingRoot.js";

export interface RelayV2HostShippingProcessLifecycleOptions {
  readonly signal?: AbortSignal;
  readonly requestIdFactory?: () => string;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly monitorIntervalMs?: number;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaximumDelayMs?: number;
}

export type RelayV2HostShippingProcessLifecycleResult =
  | Readonly<{
      status: "stopped_by_signal";
      exitCode: 0;
    }>
  | Readonly<{
      status: "superseded";
      exitCode: typeof RELAY_V2_HOST_SUPERSEDED_EXIT_CODE;
    }>;

export type RelayV2HostShippingProcessLifecycleErrorCode =
  | "LIFECYCLE_FAILED"
  | "CLEANUP_FAILED";

export class RelayV2HostShippingProcessLifecycleError extends Error {
  constructor(readonly code: RelayV2HostShippingProcessLifecycleErrorCode) {
    super(code === "CLEANUP_FAILED"
      ? "Relay v2 Host process lifecycle cleanup failed"
      : "Relay v2 Host process lifecycle failed");
    this.name = "RelayV2HostShippingProcessLifecycleError";
  }
}

/**
 * Installs the explicit-v2 process signal fence before trusted activation
 * begins. The same signal is handed through startup and connector lifetime;
 * close only removes this owner's process listeners after every owned drain
 * has settled.
 */
export class RelayV2HostShippingProcessSignalOwner {
  readonly #controller = new AbortController();
  readonly #stop = () => this.#controller.abort();
  #closed = false;

  constructor() {
    process.once("SIGINT", this.#stop);
    process.once("SIGTERM", this.#stop);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    process.off("SIGINT", this.#stop);
    process.off("SIGTERM", this.#stop);
  }
}

function positiveDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RelayV2HostShippingProcessLifecycleError("LIFECYCLE_FAILED");
  }
  return value;
}

function connectorId(
  inspection: RelayV2HostManagedConnectorInspection,
): string | null {
  switch (inspection.status) {
    case "stopped":
    case "starting":
      return null;
    case "registered_incomplete":
    case "failed":
    case "superseded":
      return inspection.connectorId;
  }
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object"
    ? Reflect.get(error, "code")
    : undefined;
}

/**
 * The sole explicit-v2 process lifecycle owner above the shipping root.
 *
 * It retains one shipping handle for the process lifetime, drives the first
 * connector attempt, and retries only an exact retryable offline cut with a
 * capped backoff. Because every attempt goes through that same handle, the
 * canonical Host composition retains its one hostInstanceId. SUPERSEDED is a
 * permanent terminal state. Process stop and all failures explicitly drain
 * the current connector before closing the root.
 */
export class RelayV2HostShippingProcessLifecycleOwner {
  readonly #handle: RelayV2HostShippingRootHandle;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #requestIdFactory: () => string;
  readonly #wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #monitorIntervalMs: number;
  readonly #reconnectInitialDelayMs: number;
  readonly #reconnectMaximumDelayMs: number;
  #runPromise: Promise<RelayV2HostShippingProcessLifecycleResult> | null = null;

  constructor(
    handle: RelayV2HostShippingRootHandle,
    options: RelayV2HostShippingProcessLifecycleOptions = {},
  ) {
    this.#handle = handle;
    this.#externalSignal = options.signal;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.#wait = options.wait ?? waitForRelayV2HostReconnectDelay;
    this.#monitorIntervalMs = positiveDelay(
      options.monitorIntervalMs,
      RELAY_V2_HOST_CONNECTOR_MONITOR_INTERVAL_MS,
    );
    this.#reconnectInitialDelayMs = positiveDelay(
      options.reconnectInitialDelayMs,
      RELAY_V2_HOST_RECONNECT_INITIAL_DELAY_MS,
    );
    this.#reconnectMaximumDelayMs = positiveDelay(
      options.reconnectMaximumDelayMs,
      RELAY_V2_HOST_RECONNECT_MAXIMUM_DELAY_MS,
    );
    if (this.#reconnectInitialDelayMs > this.#reconnectMaximumDelayMs) {
      throw new RelayV2HostShippingProcessLifecycleError("LIFECYCLE_FAILED");
    }
  }

  run(): Promise<RelayV2HostShippingProcessLifecycleResult> {
    if (this.#runPromise !== null) return this.#runPromise;
    this.#runPromise = this.#runOwned();
    void this.#runPromise.catch(() => undefined);
    return this.#runPromise;
  }

  async #runOwned(): Promise<RelayV2HostShippingProcessLifecycleResult> {
    const processStop = new AbortController();
    const stop = () => processStop.abort();
    const externalStop = () => processStop.abort();
    const ownsProcessSignals = this.#externalSignal === undefined;
    if (ownsProcessSignals) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    } else if (this.#externalSignal!.aborted) {
      processStop.abort();
    } else {
      this.#externalSignal!.addEventListener("abort", externalStop, { once: true });
    }

    let result: RelayV2HostShippingProcessLifecycleResult | null = null;
    let lifecycleError: unknown = null;
    try {
      result = await this.#drive(processStop.signal);
    } catch (error) {
      lifecycleError = error;
    } finally {
      if (ownsProcessSignals) {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      } else {
        this.#externalSignal!.removeEventListener("abort", externalStop);
      }
    }

    let cleanupFailed = false;
    let finalInspection: RelayV2HostManagedConnectorInspection | null = null;
    try {
      finalInspection = this.#handle.inspect();
    } catch {
      cleanupFailed = true;
    }
    if (finalInspection !== null && finalInspection.status !== "stopped") {
      try {
        await this.#handle.stopAndDrain(Object.freeze({
          requestId: this.#requestIdFactory(),
          controllerGeneration: finalInspection.controllerGeneration,
          connectorId: connectorId(finalInspection),
          signal: new AbortController().signal,
        }));
      } catch (error) {
        if (errorCode(error) !== "SUPERSEDED") {
          cleanupFailed = true;
        }
      }
    }
    try {
      await this.#handle.closeAndDrain();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new RelayV2HostShippingProcessLifecycleError("CLEANUP_FAILED");
    }
    if (lifecycleError !== null) throw lifecycleError;
    if (result === null) {
      throw new RelayV2HostShippingProcessLifecycleError("LIFECYCLE_FAILED");
    }
    return result;
  }

  async #drive(signal: AbortSignal): Promise<RelayV2HostShippingProcessLifecycleResult> {
    let reconnectDelayMs = this.#reconnectInitialDelayMs;
    while (!signal.aborted) {
      try {
        await this.#handle.start(Object.freeze({
          requestId: this.#requestIdFactory(),
          signal,
        }));
        reconnectDelayMs = this.#reconnectInitialDelayMs;
      } catch (error) {
        const inspection = this.#handle.inspect();
        if (inspection.status === "superseded" || errorCode(error) === "SUPERSEDED") {
          return Object.freeze({
            status: "superseded",
            exitCode: RELAY_V2_HOST_SUPERSEDED_EXIT_CODE,
          });
        }
        if (signal.aborted) break;
        if (inspection.status !== "failed" || inspection.retryable !== true) {
          throw error;
        }
      }

      while (!signal.aborted) {
        const inspection = this.#handle.inspect();
        if (inspection.status === "superseded") {
          return Object.freeze({
            status: "superseded",
            exitCode: RELAY_V2_HOST_SUPERSEDED_EXIT_CODE,
          });
        }
        if (inspection.status === "failed") {
          if (!inspection.retryable) {
            throw new RelayV2HostShippingProcessLifecycleError("LIFECYCLE_FAILED");
          }
          break;
        }
        if (inspection.status === "stopped") {
          throw new RelayV2HostShippingProcessLifecycleError("LIFECYCLE_FAILED");
        }
        await this.#wait(this.#monitorIntervalMs, signal);
      }
      if (signal.aborted) break;
      await this.#wait(reconnectDelayMs, signal);
      reconnectDelayMs = nextRelayV2HostReconnectDelayMs(
        reconnectDelayMs,
        this.#reconnectMaximumDelayMs,
      );
    }
    return Object.freeze({ status: "stopped_by_signal", exitCode: 0 });
  }
}

export function runRelayV2HostShippingProcessLifecycle(
  handle: RelayV2HostShippingRootHandle,
  options: RelayV2HostShippingProcessLifecycleOptions = {},
): Promise<RelayV2HostShippingProcessLifecycleResult> {
  return new RelayV2HostShippingProcessLifecycleOwner(handle, options).run();
}
