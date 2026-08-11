import { isAbsolute } from "node:path";
import { types as nodeTypes } from "node:util";

import type { Config } from "../../config.js";
import {
  issueRelayV2CanonicalCreateTargetExecutionPairV1,
  type RelayV2CanonicalCreateTargetExecutionPairV1,
} from "./canonicalCreateTargetAdmissionAdapter.js";
import {
  RelayV2CanonicalTwRpcChildProcessRunner,
  RelayV2CanonicalTwRpcQueryTransportError,
  createRelayV2CanonicalTwRpcConfigSnapshotFoundation,
  type RelayV2CanonicalTwRpcCompoundProcessRunner,
  type RelayV2CanonicalTwRpcQueryProcessRunner,
} from "./canonicalTwRpcQueryTransportAdapter.js";
import type { RelayV2ResourceDiscovery } from "./resourceState.js";
import {
  captureRelayV2LocalExactCompoundChannelFactoryV1,
  preflightRelayV2ExactCompoundTargetsV1,
  type RelayV2ExactCompoundProcessTargetV1,
  type RelayV2RemoteExactCompoundChannelFactoryV1,
} from "./remoteExactTerminalControlCompoundV1.js";

declare const canonicalHostRuntimeBundleBrand: unique symbol;

/**
 * One-shot, fieldless ticket for the default-off canonical Host runtime
 * foundation. Its private record binds one config generation owner, one
 * child runner, and the process-owner-prepared local terminal-control
 * authority.
 */
export interface RelayV2CanonicalHostRuntimeBundleV1 {
  readonly [canonicalHostRuntimeBundleBrand]: void;
}

export interface RelayV2CanonicalHostRuntimeBundleOpenedV1 {
  readonly discovery: RelayV2ResourceDiscovery;
  readonly localProcessTarget: RelayV2ExactCompoundProcessTargetV1 & { kind: "local" };
  readonly remoteCompoundChannels: RelayV2RemoteExactCompoundChannelFactoryV1;
  readonly createTargetExecutionPair: RelayV2CanonicalCreateTargetExecutionPairV1;
}

export interface RelayV2CanonicalHostRuntimeBundleOwnerV1 {
  readonly bundle: RelayV2CanonicalHostRuntimeBundleV1;
  reconfigure(): Promise<void>;
  closeAndDrain(): Promise<void>;
}

type CanonicalRunner =
  & RelayV2CanonicalTwRpcQueryProcessRunner
  & RelayV2CanonicalTwRpcCompoundProcessRunner;

export interface RelayV2CanonicalHostRuntimeBundleOptionsV1 {
  /**
   * Exact local same-version CLI entry selected by a future composition root.
   * An entrypoint is an absolute bundled cli.cjs used with the executable.
   */
  localCliTarget: Readonly<{
    executable: string;
    entrypoint?: string;
    /** Exact local-development home; production construction omits it. */
    home?: string;
  }>;
  /** Exact ready primary terminal-control daemon socket; this owner never starts it. */
  terminalControlDaemonSocketPath: string;
  /** Fixed trust store for every configured SSH Host. */
  knownHostsFile: string;
  /** Fixed SSH executable; only explicitly configured Host aliases are eligible. */
  sshExecutable: string;
  /** Explicit owner seams; trusted production construction omits these fields. */
  configLoader?: () => Pick<Config, "hosts"> | null;
  runner?: CanonicalRunner;
  queryTimeoutMs?: number;
}

interface BundleRecord {
  live: boolean;
  readonly opened: RelayV2CanonicalHostRuntimeBundleOpenedV1;
}

const canonicalHostRuntimeBundles = new WeakMap<object, BundleRecord>();

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || !isAbsolute(value)) {
    throw new TypeError(`canonical Host runtime ${label} must be an absolute path`);
  }
  return value;
}

function captureOptions(
  value: RelayV2CanonicalHostRuntimeBundleOptionsV1,
): RelayV2CanonicalHostRuntimeBundleOptionsV1 {
  if (!plainRecord(value) || !plainRecord(value.localCliTarget)) {
    throw new TypeError("canonical Host runtime bundle options are malformed");
  }
  const allowed = new Set([
    "localCliTarget",
    "terminalControlDaemonSocketPath",
    "knownHostsFile",
    "sshExecutable",
    "configLoader",
    "runner",
    "queryTimeoutMs",
  ]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || !keys.includes("localCliTarget")
    || !keys.includes("terminalControlDaemonSocketPath")
    || !keys.includes("knownHostsFile")
    || !keys.includes("sshExecutable")) {
    throw new TypeError("canonical Host runtime bundle options are malformed");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("canonical Host runtime bundle options are malformed");
    }
  }
  const localKeys = Reflect.ownKeys(value.localCliTarget);
  if (localKeys.some((key) => (
    key !== "executable" && key !== "entrypoint" && key !== "home"
  ))
    || !localKeys.includes("executable")) {
    throw new TypeError("canonical Host runtime local CLI target is malformed");
  }
  for (const key of localKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value.localCliTarget, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("canonical Host runtime local CLI target is malformed");
    }
  }
  const executable = absolutePath(value.localCliTarget.executable, "local CLI executable");
  const entrypoint = value.localCliTarget.entrypoint === undefined
    ? undefined
    : absolutePath(value.localCliTarget.entrypoint, "local CLI entrypoint");
  const home = value.localCliTarget.home === undefined
    ? undefined
    : absolutePath(value.localCliTarget.home, "local CLI home");
  const terminalControlDaemonSocketPath = absolutePath(
    value.terminalControlDaemonSocketPath,
    "terminal-control daemon socket",
  );
  const knownHostsFile = absolutePath(value.knownHostsFile, "known_hosts");
  const sshExecutable = absolutePath(value.sshExecutable, "SSH executable");
  if (value.configLoader !== undefined && typeof value.configLoader !== "function") {
    throw new TypeError("canonical Host runtime config loader is malformed");
  }
  if (value.runner !== undefined
    && (!plainRecord(value.runner)
      || typeof value.runner.spawn !== "function"
      || typeof value.runner.spawnCompound !== "function")) {
    throw new TypeError("canonical Host runtime child runner is malformed");
  }
  if (value.queryTimeoutMs !== undefined
    && (!Number.isSafeInteger(value.queryTimeoutMs) || value.queryTimeoutMs < 1)) {
    throw new TypeError("canonical Host runtime query timeout is malformed");
  }
  return Object.freeze({
    localCliTarget: Object.freeze({
      executable,
      ...(entrypoint === undefined ? {} : { entrypoint }),
      ...(home === undefined ? {} : { home }),
    }),
    terminalControlDaemonSocketPath,
    knownHostsFile,
    sshExecutable,
    ...(value.configLoader === undefined ? {} : { configLoader: value.configLoader }),
    ...(value.runner === undefined ? {} : { runner: value.runner }),
    ...(value.queryTimeoutMs === undefined ? {} : { queryTimeoutMs: value.queryTimeoutMs }),
  });
}

/**
 * Consumes an issued runtime bundle exactly once. The result intentionally
 * contains only the four future activation lanes: no runner, queryPort,
 * config loader/writer, daemon starter, or process manager is reachable.
 */
export function consumeRelayV2CanonicalHostRuntimeBundleV1(
  bundle: RelayV2CanonicalHostRuntimeBundleV1,
): RelayV2CanonicalHostRuntimeBundleOpenedV1 {
  if (bundle === null || typeof bundle !== "object") {
    throw new TypeError("canonical Host runtime bundle is malformed");
  }
  const record = canonicalHostRuntimeBundles.get(bundle as object);
  if (record === undefined) {
    throw new TypeError("canonical Host runtime bundle is foreign or already consumed");
  }
  canonicalHostRuntimeBundles.delete(bundle as object);
  if (!record.live) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
  }
  return record.opened;
}

/**
 * Creates the default-off canonical Host runtime bundle owner. Construction
 * reads only the explicit Host config and preflights the local exact
 * terminal-control sibling ingress already made ready by its process owner.
 * The bundle itself does not start a daemon, connector, WSS, CLI shipping
 * root, or advertise any capability.
 */
export async function createRelayV2CanonicalHostRuntimeBundleOwnerV1(
  rawOptions: RelayV2CanonicalHostRuntimeBundleOptionsV1,
): Promise<RelayV2CanonicalHostRuntimeBundleOwnerV1> {
  const options = captureOptions(rawOptions);
  const runner = options.runner ?? new RelayV2CanonicalTwRpcChildProcessRunner();
  const foundation = createRelayV2CanonicalTwRpcConfigSnapshotFoundation({
    configLoader: options.configLoader,
    localTarget: {
      kind: "local",
      targetId: "bundled-same-version-tw",
      executable: options.localCliTarget.executable,
      argvPrefix: options.localCliTarget.entrypoint === undefined
        ? []
        : [options.localCliTarget.entrypoint],
      ...(options.localCliTarget.home === undefined
        ? {}
        : { home: options.localCliTarget.home }),
    },
    knownHostsFile: options.knownHostsFile,
    sshExecutable: options.sshExecutable,
    runner,
    queryTimeoutMs: options.queryTimeoutMs,
  });
  try {
    const localChannels = captureRelayV2LocalExactCompoundChannelFactoryV1({
      daemonSocketPath: options.terminalControlDaemonSocketPath,
      processTarget: foundation.localProcessTarget,
    });
    await preflightRelayV2ExactCompoundTargetsV1(localChannels, [
      foundation.localProcessTarget,
    ]);
    const remoteCompoundChannels = foundation.queryPort
      .captureRemoteExactCompoundChannelFactory(runner);
    const createTargetExecutionPair = issueRelayV2CanonicalCreateTargetExecutionPairV1({
      owner: foundation.queryPort,
      runner,
      inner: foundation.structuredProcess,
    });
    const localProcessTarget = Object.freeze({
      kind: "local" as const,
      targetId: foundation.localProcessTarget.targetId,
    });
    const discovery = Object.freeze(Object.assign(Object.create(null), {
      scan: () => foundation.discovery.scan(),
    })) as RelayV2ResourceDiscovery;
    const opened = Object.freeze(Object.assign(Object.create(null), {
      discovery,
      localProcessTarget,
      remoteCompoundChannels,
      createTargetExecutionPair,
    })) as RelayV2CanonicalHostRuntimeBundleOpenedV1;
    const bundle = Object.freeze(Object.create(null)) as RelayV2CanonicalHostRuntimeBundleV1;
    const record: BundleRecord = { live: true, opened };
    canonicalHostRuntimeBundles.set(bundle as object, record);

    let closed = false;
    let closeBarrier: Promise<void> | null = null;
    const owner = Object.assign(Object.create(null), {
      bundle,
      reconfigure(): Promise<void> {
        if (closed) {
          return Promise.reject(
            new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE"),
          );
        }
        // foundation.reconfigure() retires the sole target generation in its
        // synchronous call prefix before returning the queued transition.
        return foundation.reconfigure();
      },
      closeAndDrain(): Promise<void> {
        if (closeBarrier !== null) return closeBarrier;
        closed = true;
        record.live = false;
        // The foundation invalidates every queued request generation and
        // synchronously closes the sole query target owner.
        closeBarrier = foundation.closeAndDrain();
        return closeBarrier;
      },
    });
    return Object.freeze(owner) as RelayV2CanonicalHostRuntimeBundleOwnerV1;
  } catch (error) {
    await foundation.closeAndDrain().catch(() => undefined);
    throw error;
  }
}
