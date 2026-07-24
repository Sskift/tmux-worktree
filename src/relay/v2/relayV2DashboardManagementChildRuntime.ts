import { types as nodeUtilTypes } from "node:util";

import {
  startRelayV2HostShippingRoot,
  type RelayV2HostShippingRootOptions,
} from "./hostShippingRoot.js";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE,
  RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE,
  createRelayV2DashboardManagementUnavailableStdioSession,
  relayV2DashboardManagementProcessStdio,
  type RelayV2DashboardManagementStdioIo,
} from "./relayV2DashboardManagementStdio.js";

/**
 * Trusted deployment injections accepted by the hidden child. The real
 * session is reachable only through the existing Host shipping root with
 * these qualified inputs; this owner never constructs credentials, native
 * sources, discovery, listeners, worktree/tmux, retry, or a v1 fallback.
 */
export interface RelayV2DashboardManagementChildShippingOptions {
  /** Test isolation only; production omission selects the canonical account home. */
  readonly trustedHome?: string;
  readonly deployment: RelayV2HostShippingRootOptions["deployment"];
  readonly runtime: RelayV2HostShippingRootOptions["runtime"];
}

/** The narrow lifecycle the child consumes from the Host shipping root handle. */
export interface RelayV2DashboardManagementChildHostHandle {
  readonly runDashboardManagement?: () => Promise<number>;
  closeAndDrain(): Promise<void>;
}

/**
 * Narrow factory port for the qualified Host owner. The production wrapper
 * binds the canonical `startRelayV2HostShippingRoot`; nothing else may
 * supply a Host owner to this child.
 */
export type RelayV2DashboardManagementChildHostFactory = (
  options: RelayV2HostShippingRootOptions,
) => Promise<RelayV2DashboardManagementChildHostHandle>;

export interface RelayV2DashboardManagementChildStdioOptions {
  readonly runtimeVersion: string;
  /** Test seam; omission selects the process stdin/stdout channel. */
  readonly io?: RelayV2DashboardManagementStdioIo;
  /** Default-off. Omission selects the typed UNAVAILABLE session. */
  readonly shipping?: RelayV2DashboardManagementChildShippingOptions;
}

interface CapturedOptions {
  readonly runtimeVersion: string;
  readonly io: RelayV2DashboardManagementStdioIo;
  readonly shipping: RelayV2DashboardManagementChildShippingOptions | null;
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function captureRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const allowed = [...required, ...optional];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return null;
  if (required.some((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined || !Object.hasOwn(descriptor, "value");
  })) return null;
  for (const key of optional) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && !Object.hasOwn(descriptor, "value")) return null;
  }
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && descriptor.value !== undefined) {
      result[key] = descriptor.value;
    }
  }
  return result;
}

function captureIo(value: unknown): RelayV2DashboardManagementStdioIo | null {
  const io = captureRecord(value, ["input", "writeFrame"]);
  if (io === null
    || io.input === null
    || typeof io.input !== "object"
    || rejectedProxy(io.input)
    || typeof io.writeFrame !== "function"
    || rejectedProxy(io.writeFrame)) return null;
  return Object.freeze({
    input: io.input as AsyncIterable<Uint8Array>,
    writeFrame: io.writeFrame as (frame: string) => Promise<void>,
  });
}

function captureOptions(value: unknown): CapturedOptions | null {
  const fields = captureRecord(value, ["runtimeVersion"], ["io", "shipping"]);
  if (fields === null || typeof fields.runtimeVersion !== "string") return null;
  let io: RelayV2DashboardManagementStdioIo;
  if (fields.io === undefined) {
    io = relayV2DashboardManagementProcessStdio();
  } else {
    const capturedIo = captureIo(fields.io);
    if (capturedIo === null) return null;
    io = capturedIo;
  }
  let shipping: RelayV2DashboardManagementChildShippingOptions | null = null;
  if (fields.shipping !== undefined) {
    const captured = captureRecord(fields.shipping, ["deployment", "runtime"], ["trustedHome"]);
    if (captured === null
      || (captured.trustedHome !== undefined && typeof captured.trustedHome !== "string")
      || captured.deployment === null
      || typeof captured.deployment !== "object"
      || captured.runtime === null
      || typeof captured.runtime !== "object") return null;
    shipping = Object.freeze({
      ...(captured.trustedHome === undefined
        ? {}
        : { trustedHome: captured.trustedHome as string }),
      deployment: captured.deployment as RelayV2HostShippingRootOptions["deployment"],
      runtime: captured.runtime as RelayV2HostShippingRootOptions["runtime"],
    });
  }
  return Object.freeze({
    runtimeVersion: fields.runtimeVersion as string,
    io,
    shipping,
  });
}

const HANDLE_ALLOWED_KEYS = Object.freeze([
  "inspect",
  "start",
  "stopAndDrain",
  "runDashboardManagement",
  "closeAndDrain",
] as const);

interface CapturedHandle {
  readonly runDashboardManagement: (() => Promise<number>) | null;
  readonly closeAndDrain: () => Promise<void>;
}

/**
 * Capture the exact management lifecycle from a published owner handle in one
 * own-data pass. Accessors, Proxies, unknown keys, a missing close, or a
 * non-function method make the handle untrusted: its owner can no longer be
 * proven drainable, so the caller must fail ordinary instead of falling back.
 */
function captureHandle(value: unknown): CapturedHandle | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"
    || !HANDLE_ALLOWED_KEYS.includes(key as typeof HANDLE_ALLOWED_KEYS[number]))) {
    return null;
  }
  let runDashboardManagement: (() => Promise<number>) | null = null;
  let closeAndDrain: (() => Promise<void>) | null = null;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function") return null;
    if (key === "runDashboardManagement") {
      runDashboardManagement = descriptor.value as () => Promise<number>;
    }
    if (key === "closeAndDrain") closeAndDrain = descriptor.value as () => Promise<void>;
  }
  if (closeAndDrain === null) return null;
  return Object.freeze({ runDashboardManagement, closeAndDrain });
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  if (!(value instanceof Promise) || rejectedProxy(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Promise.prototype;
  } catch {
    return false;
  }
}

function legalExitCode(value: unknown): number | null {
  return value === 0
    || value === RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE
    || value === RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE
    ? value as number
    : null;
}

/**
 * A published management method may already have written frames, so its
 * outcome is only trusted when it returns a verifiable native Promise that
 * resolves to a legal exit code. A synchronous return, a foreign thenable, a
 * reject, or any other resolution converges to ordinary failure and never to
 * the UNAVAILABLE session.
 */
async function runVerified(
  runDashboardManagement: () => Promise<number>,
  receiver: object,
): Promise<number> {
  let returned: unknown;
  try {
    returned = Reflect.apply(runDashboardManagement, receiver, []);
  } catch {
    return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  }
  if (!isNativePromise(returned)) return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  let resolved: unknown;
  try {
    resolved = await returned;
  } catch {
    return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  }
  return legalExitCode(resolved) ?? RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
}

/** A clean close is exactly a verifiable native Promise resolving undefined. */
async function closeVerified(
  closeAndDrain: () => Promise<void>,
  receiver: object,
): Promise<boolean> {
  let returned: unknown;
  try {
    returned = Reflect.apply(closeAndDrain, receiver, []);
  } catch {
    return false;
  }
  if (!isNativePromise(returned)) return false;
  try {
    return (await returned) === undefined;
  } catch {
    return false;
  }
}

/**
 * Run the qualified real session through the injected Host factory. Null is
 * returned only when the factory declined before publishing a handle, or a
 * trusted handle explicitly has no management session and closed cleanly —
 * both before any frame could be written. Method existence and method result
 * are judged independently: a published management method must return a
 * verifiable native Promise resolving a legal exit code, and the close must
 * return a verifiable native Promise resolving undefined. An untrusted
 * handle, an illegal run resolution, or a close uncertainty all converge to
 * the ordinary failure exit code, never to a second session on the channel.
 */
async function runQualifiedSession(
  openHostRoot: RelayV2DashboardManagementChildHostFactory,
  captured: CapturedOptions & { shipping: RelayV2DashboardManagementChildShippingOptions },
): Promise<number | null> {
  const abort = new AbortController();
  let rawHandle: unknown;
  try {
    rawHandle = await openHostRoot(Object.freeze({
      ...(captured.shipping.trustedHome === undefined
        ? {}
        : { trustedHome: captured.shipping.trustedHome }),
      deployment: captured.shipping.deployment,
      runtime: captured.shipping.runtime,
      dashboardManagement: Object.freeze({
        clock: () => Date.now(),
        runtimeVersion: captured.runtimeVersion,
        signal: abort.signal,
        io: captured.io,
      }),
    }));
  } catch {
    return null;
  }
  const handle = captureHandle(rawHandle);
  if (handle === null) return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  const hasManagement = handle.runDashboardManagement !== null;
  let result: number | null = null;
  if (hasManagement) {
    result = await runVerified(handle.runDashboardManagement, rawHandle as object);
  }
  try {
    abort.abort();
  } catch {
    // The native controller never throws here; keep the close path total.
  }
  if (!(await closeVerified(handle.closeAndDrain, rawHandle as object))) {
    return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  }
  return hasManagement ? result : null;
}

function captureFactory(
  value: unknown,
): RelayV2DashboardManagementChildHostFactory | null {
  if (typeof value !== "function" || rejectedProxy(value)) return null;
  return value as RelayV2DashboardManagementChildHostFactory;
}

/**
 * Injectable runner for the hidden child's selection entry. The factory is
 * captured once; the returned runner never rejects.
 */
export function createRelayV2DashboardManagementChildStdioRunner(
  openHostRoot: RelayV2DashboardManagementChildHostFactory,
): (options: RelayV2DashboardManagementChildStdioOptions) => Promise<number> {
  const factory = captureFactory(openHostRoot);
  return async (options) => {
    const captured = captureOptions(options);
    if (captured === null || factory === null) {
      return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
    }
    if (captured.shipping !== null) {
      const qualified = await runQualifiedSession(factory, {
        ...captured,
        shipping: captured.shipping,
      });
      if (qualified !== null) return qualified;
    }
    return createRelayV2DashboardManagementUnavailableStdioSession({
      runtimeVersion: captured.runtimeVersion,
      io: captured.io,
    }).run();
  };
}

/**
 * The hidden child's single selection entry. It never rejects: qualified
 * injected Host shipping inputs run the real same-lineage protocol-v2
 * management session owned by the canonical Host shipping root; every
 * qualification gap converges to the typed UNAVAILABLE session. The
 * production CLI passes no shipping inputs, so the shipping behavior stays
 * fail-closed unavailable with no Relay v1 fallback.
 */
export function runRelayV2DashboardManagementChildStdio(
  options: RelayV2DashboardManagementChildStdioOptions,
): Promise<number> {
  return createRelayV2DashboardManagementChildStdioRunner(startRelayV2HostShippingRoot)(options);
}
