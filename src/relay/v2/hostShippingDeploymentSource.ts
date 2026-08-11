import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { types as nodeTypes } from "node:util";

import type { Config } from "../../config.js";
import { requestTerminalControl } from "../../terminalControl/client.js";
import {
  defaultTerminalControlSocketPath,
  defaultTerminalControlStatePath,
} from "../../terminalControl/store.js";
import {
  createRelayV2CanonicalHostRuntimeBundleOwnerV1,
  type RelayV2CanonicalHostRuntimeBundleOwnerV1,
  type RelayV2CanonicalHostRuntimeBundleV1,
} from "./canonicalHostRuntimeBundle.js";
import { relayV2RemoteExactCompoundSocketPathV1 } from
  "./remoteExactTerminalControlCompoundV1.js";
import {
  createRelayV2HostCredentialNativeModuleSelfHostedDarwinArm64Loader,
  relayV2HostCredentialNativeModuleTrustedLoader,
} from "./hostCredentialNativeLoader.js";
import {
  issueRelayV2HostSelfHostedDarwinArm64AdmissionPolicy,
} from "./hostSelfHostedDarwinArm64AdmissionPolicy.js";
import {
  createRelayV2HostCredentialNativeModuleSource,
  type RelayV2HostCredentialNativeModuleSource,
} from "./hostCredentialNativeModuleSource.js";
import {
  loadOrCreateRelayV2HostProductionProfile,
  readRelayV2HostProductionProfile,
  readRelayV2HostProductionProfileProvisioningInput,
  requireRelayV2HostProductionProfileSnapshot,
  type RelayV2HostProductionProfile,
} from "./hostProductionProfileStore.js";
import {
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_LIMITS,
  type RelayV2HostBootstrapSecretByteSource,
} from "./hostBootstrapSecretSource.js";
import {
  createRelayV2HostBootstrapSecretNodeReadableByteSource,
} from "./hostBootstrapSecretNodeReadableByteSource.js";
import {
  RelayV2HostShippingProcessSignalOwner,
  runRelayV2HostShippingProcessLifecycle,
} from "./hostShippingProcessLifecycle.js";
import type {
  RelayV2HostCredentialAtomicByteCellOwner,
  RelayV2HostPrivilegedProductionDashboardManagementOptions,
} from "./hostPrivilegedProductionIntakeComposition.js";
import {
  createRelayV2HostLocalDevelopmentCredentialCell,
} from "./hostLocalDevelopmentCredentialCell.js";
import {
  createRelayV2HostCredentialFileCell,
} from "./hostCredentialFileCell.js";
import type { RelayV2HostShippingRootHandle } from "./hostShippingRoot.js";
import {
  captureRelayV2HostTlsCaTrustCut,
  captureRelayV2HostSystemTlsTrustCut,
  RELAY_V2_HOST_TLS_CA_MAX_ENTRY_BYTES,
  type RelayV2HostTlsCaTrustCut,
} from "./hostTlsTrustMaterial.js";

declare const relayV2HostTrustedDeploymentActivationBrand: unique symbol;

/**
 * Fieldless process-local ticket. Only this source can issue one, and the
 * canonical Host shipping root consumes its private record exactly once.
 */
export interface RelayV2HostTrustedDeploymentActivation {
  readonly [relayV2HostTrustedDeploymentActivationBrand]: void;
}

declare const relayV2HostLocalDevelopmentActivationBrand: unique symbol;

/** Fieldless ticket issued only for the explicit loopback development lane. */
export interface RelayV2HostLocalDevelopmentActivation {
  readonly [relayV2HostLocalDevelopmentActivationBrand]: void;
}

declare const relayV2HostSelfHostedDarwinArm64ActivationBrand: unique symbol;

/** Fieldless ticket for the explicit non-production account-home lane. */
export interface RelayV2HostSelfHostedDarwinArm64Activation {
  readonly [relayV2HostSelfHostedDarwinArm64ActivationBrand]: void;
}

/**
 * Exact credential intake for one trusted/self-hosted activation record.
 * Either the native module source (durable native cell) or the one-shot
 * takeCredentialCell accessor (non-native in-memory cell) is present,
 * depending on whether the fixed native artifact resolved at activation.
 */
export type RelayV2HostTrustedCredentialIntake =
  | Readonly<{
      nativeModuleSource: RelayV2HostCredentialNativeModuleSource;
    }>
  | Readonly<{
      takeCredentialCell(): RelayV2HostCredentialAtomicByteCellOwner;
    }>;

export interface RelayV2HostTrustedDeploymentActivationRecord {
  readonly trustedHome: string;
  readonly profileSnapshot: Readonly<RelayV2HostProductionProfile>;
  readonly credentialIntake: RelayV2HostTrustedCredentialIntake;
  readonly runtimeBundle: RelayV2CanonicalHostRuntimeBundleV1;
  readonly terminalControlDaemonSocketPath: string;
  readonly credentialHttpsTlsTrustCut: RelayV2HostTlsCaTrustCut;
  readonly carrierWssTlsTrustCut: RelayV2HostTlsCaTrustCut;
  readonly bootstrapSecretByteSource?: RelayV2HostBootstrapSecretByteSource;
  readonly startupSignal?: AbortSignal;
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostSelfHostedDarwinArm64ActivationRecord =
  RelayV2HostTrustedDeploymentActivationRecord & Readonly<{
    replacePendingBootstrap?: true;
  }>;

export interface RelayV2HostLocalDevelopmentActivationRecord {
  readonly trustedHome: string;
  readonly profileSnapshot: Readonly<RelayV2HostProductionProfile>;
  readonly runtimeBundle: RelayV2CanonicalHostRuntimeBundleV1;
  readonly terminalControlDaemonSocketPath: string;
  readonly credentialHttpsTlsTrustCut: RelayV2HostTlsCaTrustCut;
  readonly carrierWssTlsTrustCut: RelayV2HostTlsCaTrustCut;
  readonly bootstrapSecretByteSource?: RelayV2HostBootstrapSecretByteSource;
  readonly startupSignal?: AbortSignal;
  takeCredentialCell(): RelayV2HostCredentialAtomicByteCellOwner;
  closeAndDrain(): Promise<void>;
}

export interface RelayV2HostLocalDevelopmentShippingOptions {
  readonly trustedHome: string;
  readonly credentialHttpsCaInputPath: string;
  readonly carrierWssCaInputPath: string;
  readonly provisionProfileInputPath?: string;
  readonly bootstrapSecretInputPath?: string;
}

export interface RelayV2HostSelfHostedDarwinArm64ShippingOptions {
  readonly credentialHttpsCaInputPath: string;
  readonly carrierWssCaInputPath: string;
  readonly provisionProfileInputPath?: string;
  readonly bootstrapSecretInputPath?: string;
  readonly replacePendingBootstrap?: true;
}

export type RelayV2HostShippingDeploymentSourceErrorCode =
  | "ACTIVATION_INVALID"
  | "ACTIVATION_FAILED"
  | "CLEANUP_FAILED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostShippingDeploymentSourceErrorCode,
string
>> = Object.freeze({
  ACTIVATION_INVALID: "Relay v2 Host trusted deployment activation is invalid",
  ACTIVATION_FAILED: "Relay v2 Host trusted deployment activation failed",
  CLEANUP_FAILED: "Relay v2 Host trusted deployment activation cleanup failed",
});

export class RelayV2HostShippingDeploymentSourceError extends Error {
  constructor(readonly code: RelayV2HostShippingDeploymentSourceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostShippingDeploymentSourceError";
  }
}

interface TrustedActivationOwner {
  readonly activation: RelayV2HostTrustedDeploymentActivation;
  closeAndDrain(): Promise<void>;
}

interface LocalDevelopmentActivationOwner {
  readonly activation: RelayV2HostLocalDevelopmentActivation;
  closeAndDrain(): Promise<void>;
}

interface SelfHostedDarwinArm64ActivationOwner {
  readonly activation: RelayV2HostSelfHostedDarwinArm64Activation;
  closeAndDrain(): Promise<void>;
}

const activationRecords =
  new WeakMap<object, RelayV2HostTrustedDeploymentActivationRecord>();
const localDevelopmentActivationRecords =
  new WeakMap<object, RelayV2HostLocalDevelopmentActivationRecord>();
const selfHostedDarwinArm64ActivationRecords =
  new WeakMap<object, RelayV2HostSelfHostedDarwinArm64ActivationRecord>();
const LOCAL_DEVELOPMENT_UNIX_SOCKET_PATH_MAX_BYTES = 100;

function failure(
  code: RelayV2HostShippingDeploymentSourceErrorCode,
): RelayV2HostShippingDeploymentSourceError {
  return new RelayV2HostShippingDeploymentSourceError(code);
}

function requireStartupOpen(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure("ACTIVATION_FAILED");
}

function requireSelfHostedDarwinArm64AccountHome(): string {
  try {
    const accountHome = userInfo().homedir;
    if (typeof accountHome !== "string"
      || accountHome.length === 0
      || accountHome.includes("\0")
      || !isAbsolute(accountHome)) {
      throw failure("ACTIVATION_FAILED");
    }
    const canonicalAccountHome = realpathSync.native(accountHome);
    const inheritedHome = process.env.HOME;
    if (inheritedHome !== undefined) {
      if (inheritedHome.length === 0
        || inheritedHome.includes("\0")
        || !isAbsolute(inheritedHome)
        || realpathSync.native(inheritedHome) !== canonicalAccountHome) {
        throw failure("ACTIVATION_FAILED");
      }
    }
    return canonicalAccountHome;
  } catch {
    throw failure("ACTIVATION_FAILED");
  }
}

function requireLocalDevelopmentTrustedHome(value: string): string {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
    || !isAbsolute(value)
    || value.includes("\0")) {
    throw failure("ACTIVATION_FAILED");
  }
  try {
    const before = lstatSync(value, { bigint: true });
    if (!before.isDirectory()
      || before.isSymbolicLink()
      || before.uid !== BigInt(process.geteuid())
      || (before.mode & 0o7777n) !== 0o700n) {
      throw failure("ACTIVATION_FAILED");
    }
    const canonical = realpathSync.native(value);
    const after = lstatSync(value, { bigint: true });
    if (canonical !== value
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.uid !== before.uid
      || after.mode !== before.mode
      || !after.isDirectory()
      || after.isSymbolicLink()) {
      throw failure("ACTIVATION_FAILED");
    }
    return canonical;
  } catch {
    throw failure("ACTIVATION_FAILED");
  }
}

function localDevelopmentTerminalControlSocketPath(trustedHome: string): string {
  const fits = (socketPath: string): boolean => (
    Buffer.byteLength(socketPath, "utf8") <= LOCAL_DEVELOPMENT_UNIX_SOCKET_PATH_MAX_BYTES
    && Buffer.byteLength(
      relayV2RemoteExactCompoundSocketPathV1(socketPath),
      "utf8",
    ) <= LOCAL_DEVELOPMENT_UNIX_SOCKET_PATH_MAX_BYTES
  );
  const canonicalPreferred = join(
    trustedHome,
    ".tmux-worktree",
    "terminal-control-v1.sock",
  );
  const preferred = defaultTerminalControlSocketPath(trustedHome);
  if (preferred === canonicalPreferred && fits(preferred)) return preferred;
  const candidate = join(trustedHome, ".relay-v2-tc-v1.sock");
  if (!fits(candidate)) throw failure("ACTIVATION_FAILED");
  return candidate;
}

function exactRegularPath(value: string, label: "Node executable" | "CLI entrypoint"): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(value);
    if (!statSync(canonical).isFile()) throw new TypeError(label);
  } catch {
    throw failure("ACTIVATION_FAILED");
  }
  if (canonical.length === 0 || canonical.includes("\0")) {
    throw failure("ACTIVATION_FAILED");
  }
  return canonical;
}

function currentCliTarget(): Readonly<{ executable: string; entrypoint: string }> {
  const executable = exactRegularPath(process.execPath, "Node executable");
  const rawEntrypoint = process.argv[1];
  if (typeof rawEntrypoint !== "string" || rawEntrypoint.length === 0) {
    throw failure("ACTIVATION_FAILED");
  }
  const entrypoint = exactRegularPath(rawEntrypoint, "CLI entrypoint");
  if (basename(entrypoint) !== "cli.cjs" && basename(entrypoint) !== "tw-cli.cjs") {
    throw failure("ACTIVATION_FAILED");
  }
  return Object.freeze({ executable, entrypoint });
}

function openBootstrapSecretByteSource(
  path: string | undefined,
): RelayV2HostBootstrapSecretByteSource | null {
  if (path === undefined) return null;
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || path.length === 0
    || path.includes("\0")
    || typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof process.geteuid !== "function") {
    throw failure("ACTIVATION_FAILED");
  }

  let descriptor = -1;
  let readable: ReturnType<typeof createReadStream> | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.uid !== BigInt(process.geteuid())
      || opened.nlink !== 1n
      || (opened.mode & 0o7777n) !== 0o600n
      || opened.size <= 0n
      || opened.size > BigInt(RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_LIMITS.maxRawBytes)) {
      throw failure("ACTIVATION_FAILED");
    }
    readable = createReadStream(path, {
      fd: descriptor,
      autoClose: true,
      emitClose: true,
      highWaterMark: RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_LIMITS.maxRawBytes,
    });
    descriptor = -1;
    return createRelayV2HostBootstrapSecretNodeReadableByteSource(readable);
  } catch {
    if (readable !== null) {
      try { readable.destroy(); } catch {}
    }
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
    throw failure("ACTIVATION_FAILED");
  }
}

function readLocalDevelopmentTlsCaInput(path: string): Uint8Array {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof path !== "string"
    || path.length === 0
    || path.includes("\0")
    || typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof process.geteuid !== "function") {
    throw failure("ACTIVATION_FAILED");
  }
  let descriptor = -1;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.uid !== BigInt(process.geteuid())
      || opened.nlink !== 1n
      || (opened.mode & 0o7777n) !== 0o600n
      || opened.size <= 0n
      || opened.size > BigInt(RELAY_V2_HOST_TLS_CA_MAX_ENTRY_BYTES)) {
      throw failure("ACTIVATION_FAILED");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count <= 0) throw failure("ACTIVATION_FAILED");
      offset += count;
    }
    return Uint8Array.from(bytes);
  } catch {
    throw failure("ACTIVATION_FAILED");
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {
        throw failure("ACTIVATION_FAILED");
      }
    }
  }
}

function isLoopbackDevelopmentEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost") return true;
    const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    const family = isIP(unwrapped);
    if (family === 6) return unwrapped === "::1";
    if (family !== 4) return false;
    return Number(unwrapped.split(".")[0]) === 127;
  } catch {
    return false;
  }
}

function requireLocalDevelopmentProfile(
  profile: Readonly<RelayV2HostProductionProfile>,
): void {
  if (!isLoopbackDevelopmentEndpoint(profile.relayUrl)
    || !isLoopbackDevelopmentEndpoint(profile.credentialIssuerUrl)) {
    throw failure("ACTIVATION_FAILED");
  }
}

function captureLocalDevelopmentOptions(
  value: unknown,
): Readonly<RelayV2HostLocalDevelopmentShippingOptions> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw failure("ACTIVATION_INVALID");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw failure("ACTIVATION_INVALID");
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure("ACTIVATION_INVALID");
  }
  const required = [
    "trustedHome",
    "credentialHttpsCaInputPath",
    "carrierWssCaInputPath",
  ] as const;
  const optional = ["provisionProfileInputPath", "bootstrapSecretInputPath"] as const;
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(descriptors[key] ?? {}, "value"))) {
    throw failure("ACTIVATION_INVALID");
  }
  const result = Object.create(null) as Record<string, string>;
  for (const key of [...required, ...optional]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string"
      || descriptor.value.length === 0
      || descriptor.value.includes("\0")) throw failure("ACTIVATION_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result) as unknown as
    Readonly<RelayV2HostLocalDevelopmentShippingOptions>;
}

function captureSelfHostedDarwinArm64Options(
  value: unknown,
): Readonly<RelayV2HostSelfHostedDarwinArm64ShippingOptions> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw failure("ACTIVATION_INVALID");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw failure("ACTIVATION_INVALID");
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure("ACTIVATION_INVALID");
  }
  const required = [
    "credentialHttpsCaInputPath",
    "carrierWssCaInputPath",
  ] as const;
  const optionalPaths = ["provisionProfileInputPath", "bootstrapSecretInputPath"] as const;
  const allowed = new Set<string>([...required, ...optionalPaths, "replacePendingBootstrap"]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(descriptors[key] ?? {}, "value"))) {
    throw failure("ACTIVATION_INVALID");
  }
  const result = Object.create(null) as Record<string, string | true>;
  for (const key of [...required, ...optionalPaths]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string"
      || descriptor.value.length === 0
      || descriptor.value.includes("\0")
      || !isAbsolute(descriptor.value)) throw failure("ACTIVATION_INVALID");
    result[key] = descriptor.value;
  }
  const replaceDescriptor = descriptors.replacePendingBootstrap;
  if (replaceDescriptor !== undefined) {
    if (!Object.hasOwn(replaceDescriptor, "value")
      || replaceDescriptor.value !== true
      || !Object.hasOwn(result, "bootstrapSecretInputPath")) {
      throw failure("ACTIVATION_INVALID");
    }
    result.replacePendingBootstrap = true;
  }
  return Object.freeze(result) as unknown as
    Readonly<RelayV2HostSelfHostedDarwinArm64ShippingOptions>;
}

async function closeOwned(
  bootstrapSecretByteSource: RelayV2HostBootstrapSecretByteSource | null,
  runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1 | null,
  nativeModuleSource: RelayV2HostCredentialNativeModuleSource | null,
  localDevelopmentCredentialCell: RelayV2HostCredentialAtomicByteCellOwner | null = null,
): Promise<boolean> {
  let failed = false;
  if (runtimeOwner !== null) {
    try {
      await runtimeOwner.closeAndDrain();
    } catch {
      failed = true;
    }
  }
  if (nativeModuleSource !== null) {
    try {
      nativeModuleSource.close();
    } catch {
      failed = true;
    }
  }
  if (localDevelopmentCredentialCell !== null) {
    try {
      await localDevelopmentCredentialCell.closeAndDrain();
    } catch {
      failed = true;
    }
  }
  if (bootstrapSecretByteSource !== null) {
    try {
      await bootstrapSecretByteSource.cancel();
    } catch {
      failed = true;
    }
  }
  return failed;
}

const loadLocalOnlyHostConfig = (): Pick<Config, "hosts"> => ({
  hosts: [],
});

async function openCanonicalRuntimeOwner(
  trustedHome: string,
  signal?: AbortSignal,
  lane: Readonly<{
    localDevelopmentIsolation?: Readonly<{
      terminalControlStatePath: string;
    }>;
    configLoader?: () => Pick<Config, "hosts"> | null;
  }> = {},
): Promise<Readonly<{
  terminalControlDaemonSocketPath: string;
  runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1;
}>> {
  const localDevelopmentIsolation = lane.localDevelopmentIsolation;
  const terminalControlDaemonSocketPath = localDevelopmentIsolation === undefined
    ? defaultTerminalControlSocketPath(trustedHome)
    : localDevelopmentTerminalControlSocketPath(trustedHome);
  const localCliTarget = currentCliTarget();
  await requestTerminalControl(
    { type: "ping" },
    {
      socketPath: terminalControlDaemonSocketPath,
      autoStart: true,
      autoStartCliTarget: localDevelopmentIsolation === undefined
        ? localCliTarget
        : Object.freeze({
            ...localCliTarget,
            home: trustedHome,
          }),
      ...(localDevelopmentIsolation === undefined
        ? {}
        : {
            autoStartStatePath:
              localDevelopmentIsolation.terminalControlStatePath,
          }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  requireStartupOpen(signal);
  const runtimeOwner = await createRelayV2CanonicalHostRuntimeBundleOwnerV1({
    localCliTarget: localDevelopmentIsolation === undefined
      ? localCliTarget
      : Object.freeze({
          ...localCliTarget,
          home: trustedHome,
        }),
    terminalControlDaemonSocketPath,
    knownHostsFile: join(trustedHome, ".ssh", "known_hosts"),
    sshExecutable: "/usr/bin/ssh",
    ...(lane.configLoader === undefined
      ? {}
      : { configLoader: lane.configLoader }),
  });
  return Object.freeze({ terminalControlDaemonSocketPath, runtimeOwner });
}

async function createTrustedActivationOwner(
  signal?: AbortSignal,
  bootstrapSecretInputPath?: string,
): Promise<TrustedActivationOwner> {
  let bootstrapSecretByteSource: RelayV2HostBootstrapSecretByteSource | null = null;
  let nativeModuleSource: RelayV2HostCredentialNativeModuleSource | null = null;
  let runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1 | null = null;
  let credentialCell: RelayV2HostCredentialAtomicByteCellOwner | null = null;
  try {
    requireStartupOpen(signal);
    const trustedHome = realpathSync.native(homedir());
    const profileSnapshot = requireRelayV2HostProductionProfileSnapshot(
      readRelayV2HostProductionProfile({ trustedHome }),
    );
    requireStartupOpen(signal);
    bootstrapSecretByteSource = openBootstrapSecretByteSource(
      bootstrapSecretInputPath,
    );
    requireStartupOpen(signal);

    nativeModuleSource = createRelayV2HostCredentialNativeModuleSource({
      platform: process.platform,
      architecture: process.arch,
      napiVersion: Number(process.versions.napi),
    }, relayV2HostCredentialNativeModuleTrustedLoader);
    // Drive the revision-7 trusted factory selection before constructing the
    // runtime bundle. This result is only native interface support; it never
    // becomes readiness, durability qualification, or advertised capability.
    // Only the exact native-artifact-missing outcome degrades to the same
    // non-native process-local credential cell the explicit local-development
    // lane uses; every other unsupported or invalid outcome stays fail-closed.
    const capability = nativeModuleSource.capability();
    if (capability.status !== "supported") {
      if (capability.status !== "unsupported"
        || capability.reason !== "native_artifact_missing") {
        throw failure("ACTIVATION_FAILED");
      }
      credentialCell = createRelayV2HostCredentialFileCell(trustedHome);
    }
    requireStartupOpen(signal);

    const openedRuntime = await openCanonicalRuntimeOwner(trustedHome, signal);
    const terminalControlDaemonSocketPath = openedRuntime.terminalControlDaemonSocketPath;
    runtimeOwner = openedRuntime.runtimeOwner;
    requireStartupOpen(signal);

    // The frozen profile carries no TLS material by contract. Still issue two
    // distinct process-local cuts so HTTPS and WSS cannot share, split, or
    // replace one another's deployment authority; both intentionally select
    // their own Node system-trust lane.
    const credentialHttpsTlsTrustCut = captureRelayV2HostSystemTlsTrustCut();
    const carrierWssTlsTrustCut = captureRelayV2HostSystemTlsTrustCut();
    const ownedBootstrapSource = bootstrapSecretByteSource;
    const ownedRuntime = runtimeOwner;
    const ownedSource = nativeModuleSource;
    const ownedCell = credentialCell;
    let cellTaken = false;
    const takeCredentialCell = (): RelayV2HostCredentialAtomicByteCellOwner => {
      if (ownedCell === null || cellTaken) throw failure("ACTIVATION_INVALID");
      cellTaken = true;
      return ownedCell;
    };
    let closePromise: Promise<void> | null = null;
    const closeAndDrain = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        if (await closeOwned(
          ownedBootstrapSource,
          ownedRuntime,
          ownedSource,
          ownedCell,
        )) {
          throw failure("CLEANUP_FAILED");
        }
      })();
      void closePromise.catch(() => undefined);
      return closePromise;
    };

    const activation =
      Object.freeze(Object.create(null)) as RelayV2HostTrustedDeploymentActivation;
    const record = Object.freeze(Object.assign(Object.create(null), {
      trustedHome,
      profileSnapshot,
      credentialIntake: ownedCell === null
        ? Object.freeze({ nativeModuleSource: ownedSource })
        : Object.freeze({ takeCredentialCell }),
      runtimeBundle: ownedRuntime.bundle,
      terminalControlDaemonSocketPath,
      credentialHttpsTlsTrustCut,
      carrierWssTlsTrustCut,
      ...(ownedBootstrapSource === null
        ? {}
        : { bootstrapSecretByteSource: ownedBootstrapSource }),
      ...(signal === undefined ? {} : { startupSignal: signal }),
      closeAndDrain,
    })) as RelayV2HostTrustedDeploymentActivationRecord;
    activationRecords.set(activation as object, record);
    return Object.freeze({ activation, closeAndDrain });
  } catch {
    const cleanupFailed = await closeOwned(
      bootstrapSecretByteSource,
      runtimeOwner,
      nativeModuleSource,
      credentialCell,
    );
    throw failure(cleanupFailed ? "CLEANUP_FAILED" : "ACTIVATION_FAILED");
  }
}

async function createLocalDevelopmentActivationOwner(
  signal: AbortSignal | undefined,
  options: Readonly<RelayV2HostLocalDevelopmentShippingOptions>,
): Promise<LocalDevelopmentActivationOwner> {
  let bootstrapSecretByteSource: RelayV2HostBootstrapSecretByteSource | null = null;
  let runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1 | null = null;
  let credentialCell: RelayV2HostCredentialAtomicByteCellOwner | null = null;
  try {
    requireStartupOpen(signal);
    const trustedHome = requireLocalDevelopmentTrustedHome(options.trustedHome);
    if (options.provisionProfileInputPath !== undefined) {
      const profile = readRelayV2HostProductionProfileProvisioningInput({
        inputPath: options.provisionProfileInputPath,
      });
      loadOrCreateRelayV2HostProductionProfile({ profile, trustedHome });
    }
    const profileSnapshot = requireRelayV2HostProductionProfileSnapshot(
      readRelayV2HostProductionProfile({ trustedHome }),
    );
    requireLocalDevelopmentProfile(profileSnapshot);
    requireStartupOpen(signal);

    bootstrapSecretByteSource = openBootstrapSecretByteSource(
      options.bootstrapSecretInputPath,
    );
    const credentialHttpsCa = readLocalDevelopmentTlsCaInput(
      options.credentialHttpsCaInputPath,
    );
    const carrierWssCa = readLocalDevelopmentTlsCaInput(
      options.carrierWssCaInputPath,
    );
    credentialCell = createRelayV2HostLocalDevelopmentCredentialCell();
    requireStartupOpen(signal);

    const openedRuntime = await openCanonicalRuntimeOwner(
      trustedHome,
      signal,
      Object.freeze({
        localDevelopmentIsolation: Object.freeze({
          terminalControlStatePath: defaultTerminalControlStatePath(trustedHome),
        }),
        configLoader: loadLocalOnlyHostConfig,
      }),
    );
    const terminalControlDaemonSocketPath = openedRuntime.terminalControlDaemonSocketPath;
    runtimeOwner = openedRuntime.runtimeOwner;
    requireStartupOpen(signal);

    const credentialHttpsTlsTrustCut = captureRelayV2HostTlsCaTrustCut({
      certificateAuthorities: [credentialHttpsCa],
    });
    const carrierWssTlsTrustCut = captureRelayV2HostTlsCaTrustCut({
      certificateAuthorities: [carrierWssCa],
    });
    const ownedBootstrapSource = bootstrapSecretByteSource;
    const ownedRuntime = runtimeOwner;
    const ownedCell = credentialCell;
    let cellTaken = false;
    const takeCredentialCell = (): RelayV2HostCredentialAtomicByteCellOwner => {
      if (cellTaken) throw failure("ACTIVATION_INVALID");
      cellTaken = true;
      return ownedCell;
    };
    let closePromise: Promise<void> | null = null;
    const closeAndDrain = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        if (await closeOwned(ownedBootstrapSource, ownedRuntime, null, ownedCell)) {
          throw failure("CLEANUP_FAILED");
        }
      })();
      void closePromise.catch(() => undefined);
      return closePromise;
    };

    const activation =
      Object.freeze(Object.create(null)) as RelayV2HostLocalDevelopmentActivation;
    const record = Object.freeze(Object.assign(Object.create(null), {
      trustedHome,
      profileSnapshot,
      runtimeBundle: ownedRuntime.bundle,
      terminalControlDaemonSocketPath,
      credentialHttpsTlsTrustCut,
      carrierWssTlsTrustCut,
      takeCredentialCell,
      ...(ownedBootstrapSource === null
        ? {}
        : { bootstrapSecretByteSource: ownedBootstrapSource }),
      ...(signal === undefined ? {} : { startupSignal: signal }),
      closeAndDrain,
    })) as RelayV2HostLocalDevelopmentActivationRecord;
    localDevelopmentActivationRecords.set(activation as object, record);
    return Object.freeze({ activation, closeAndDrain });
  } catch {
    const cleanupFailed = await closeOwned(
      bootstrapSecretByteSource,
      runtimeOwner,
      null,
      credentialCell,
    );
    throw failure(cleanupFailed ? "CLEANUP_FAILED" : "ACTIVATION_FAILED");
  }
}

async function createSelfHostedDarwinArm64ActivationOwner(
  signal: AbortSignal | undefined,
  options: Readonly<RelayV2HostSelfHostedDarwinArm64ShippingOptions>,
): Promise<SelfHostedDarwinArm64ActivationOwner> {
  let bootstrapSecretByteSource: RelayV2HostBootstrapSecretByteSource | null = null;
  let nativeModuleSource: RelayV2HostCredentialNativeModuleSource | null = null;
  let runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1 | null = null;
  let credentialCell: RelayV2HostCredentialAtomicByteCellOwner | null = null;
  try {
    requireStartupOpen(signal);
    // Deliberately use the real account home. Unlike local-development, this
    // lane does not require or synthesize a 0700 replacement home; canonical
    // local and explicitly configured SSH TW discovery plus terminal-control
    // ownership stay on the current Mac account. The canonical config loader
    // is also the only source of remote scopes: SSH config discovery and
    // unconfigured aliases never enter activation. The native producer alone
    // derives its fixed 0700 credential namespace beneath this account home.
    const trustedHome = requireSelfHostedDarwinArm64AccountHome();
    if (options.provisionProfileInputPath !== undefined) {
      const profile = readRelayV2HostProductionProfileProvisioningInput({
        inputPath: options.provisionProfileInputPath,
      });
      loadOrCreateRelayV2HostProductionProfile({ profile, trustedHome });
    }
    const profileSnapshot = requireRelayV2HostProductionProfileSnapshot(
      readRelayV2HostProductionProfile({ trustedHome }),
    );
    bootstrapSecretByteSource = openBootstrapSecretByteSource(
      options.bootstrapSecretInputPath,
    );
    const credentialHttpsCa = readLocalDevelopmentTlsCaInput(
      options.credentialHttpsCaInputPath,
    );
    const carrierWssCa = readLocalDevelopmentTlsCaInput(
      options.carrierWssCaInputPath,
    );
    requireStartupOpen(signal);

    const admissionPolicy =
      issueRelayV2HostSelfHostedDarwinArm64AdmissionPolicy();
    const loader =
      createRelayV2HostCredentialNativeModuleSelfHostedDarwinArm64Loader(
        admissionPolicy,
      );
    nativeModuleSource = createRelayV2HostCredentialNativeModuleSource({
      platform: process.platform,
      architecture: process.arch,
      napiVersion: Number(process.versions.napi),
    }, loader);
    // Only the exact native-artifact-missing outcome degrades to the same
    // non-native process-local credential cell the explicit local-development
    // lane uses; every other unsupported or invalid outcome stays fail-closed.
    const capability = nativeModuleSource.capability();
    if (capability.status !== "supported") {
      if (capability.status !== "unsupported"
        || capability.reason !== "native_artifact_missing") {
        throw failure("ACTIVATION_FAILED");
      }
      credentialCell = createRelayV2HostCredentialFileCell(trustedHome);
    }
    requireStartupOpen(signal);

    const openedRuntime = await openCanonicalRuntimeOwner(trustedHome, signal);
    const terminalControlDaemonSocketPath = openedRuntime.terminalControlDaemonSocketPath;
    runtimeOwner = openedRuntime.runtimeOwner;
    requireStartupOpen(signal);

    const credentialHttpsTlsTrustCut = captureRelayV2HostTlsCaTrustCut({
      certificateAuthorities: [credentialHttpsCa],
    });
    const carrierWssTlsTrustCut = captureRelayV2HostTlsCaTrustCut({
      certificateAuthorities: [carrierWssCa],
    });
    const ownedBootstrapSource = bootstrapSecretByteSource;
    const ownedRuntime = runtimeOwner;
    const ownedSource = nativeModuleSource;
    const ownedCell = credentialCell;
    let cellTaken = false;
    const takeCredentialCell = (): RelayV2HostCredentialAtomicByteCellOwner => {
      if (ownedCell === null || cellTaken) throw failure("ACTIVATION_INVALID");
      cellTaken = true;
      return ownedCell;
    };
    let closePromise: Promise<void> | null = null;
    const closeAndDrain = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        if (await closeOwned(
          ownedBootstrapSource,
          ownedRuntime,
          ownedSource,
          ownedCell,
        )) {
          throw failure("CLEANUP_FAILED");
        }
      })();
      void closePromise.catch(() => undefined);
      return closePromise;
    };

    const activation =
      Object.freeze(Object.create(null)) as RelayV2HostSelfHostedDarwinArm64Activation;
    const record = Object.freeze(Object.assign(Object.create(null), {
      trustedHome,
      profileSnapshot,
      credentialIntake: ownedCell === null
        ? Object.freeze({ nativeModuleSource: ownedSource })
        : Object.freeze({ takeCredentialCell }),
      runtimeBundle: ownedRuntime.bundle,
      terminalControlDaemonSocketPath,
      credentialHttpsTlsTrustCut,
      carrierWssTlsTrustCut,
      ...(ownedBootstrapSource === null
        ? {}
        : { bootstrapSecretByteSource: ownedBootstrapSource }),
      ...(options.replacePendingBootstrap === true
        ? { replacePendingBootstrap: true as const }
        : {}),
      ...(signal === undefined ? {} : { startupSignal: signal }),
      closeAndDrain,
    })) as RelayV2HostSelfHostedDarwinArm64ActivationRecord;
    selfHostedDarwinArm64ActivationRecords.set(activation as object, record);
    return Object.freeze({ activation, closeAndDrain });
  } catch {
    const cleanupFailed = await closeOwned(
      bootstrapSecretByteSource,
      runtimeOwner,
      nativeModuleSource,
      credentialCell,
    );
    throw failure(cleanupFailed ? "CLEANUP_FAILED" : "ACTIVATION_FAILED");
  }
}

/**
 * Canonical root-only one-shot consumer. A copied, forged, replayed, or
 * already-consumed ticket cannot expose any deployment authority.
 */
export function takeRelayV2HostTrustedDeploymentActivation(
  value: unknown,
): RelayV2HostTrustedDeploymentActivationRecord {
  if (value === null || typeof value !== "object") throw failure("ACTIVATION_INVALID");
  const record = activationRecords.get(value as object);
  if (record === undefined) throw failure("ACTIVATION_INVALID");
  activationRecords.delete(value as object);
  return record;
}

/** Root-only one-shot consumer for the isolated local-development ticket. */
export function takeRelayV2HostLocalDevelopmentActivation(
  value: unknown,
): RelayV2HostLocalDevelopmentActivationRecord {
  if (value === null || typeof value !== "object") throw failure("ACTIVATION_INVALID");
  const record = localDevelopmentActivationRecords.get(value as object);
  if (record === undefined) throw failure("ACTIVATION_INVALID");
  localDevelopmentActivationRecords.delete(value as object);
  return record;
}

/** Root-only one-shot consumer for the non-production account-home ticket. */
export function takeRelayV2HostSelfHostedDarwinArm64Activation(
  value: unknown,
): RelayV2HostSelfHostedDarwinArm64ActivationRecord {
  if (value === null || typeof value !== "object") throw failure("ACTIVATION_INVALID");
  const record = selfHostedDarwinArm64ActivationRecords.get(value as object);
  if (record === undefined) throw failure("ACTIVATION_INVALID");
  selfHostedDarwinArm64ActivationRecords.delete(value as object);
  return record;
}

/**
 * The sole default-off Host trusted deployment activation/source. It accepts
 * no caller authority input; the process entry may only add one non-secret
 * bootstrap file path, which this owner opens and captures. The exact existing
 * profile, optional byte source, revision-7 trusted native source, canonical
 * runtime bundle, and the two independent TLS trust cuts are frozen into one
 * opaque one-shot ticket before the shipping root is called. Any failure
 * drains in reverse order and fails closed.
 */
export async function startRelayV2HostShippingFromTrustedDeployment(
): Promise<RelayV2HostShippingRootHandle> {
  if (arguments.length !== 0) throw failure("ACTIVATION_INVALID");
  return openRelayV2HostShippingFromTrustedDeployment();
}

async function openRelayV2HostShippingFromTrustedDeployment(
  signal?: AbortSignal,
  bootstrapSecretInputPath?: string,
  dashboardManagement?: RelayV2HostPrivilegedProductionDashboardManagementOptions,
): Promise<RelayV2HostShippingRootHandle> {
  const owner = await createTrustedActivationOwner(signal, bootstrapSecretInputPath);
  try {
    requireStartupOpen(signal);
    const root = await import("./hostShippingRoot.js");
    requireStartupOpen(signal);
    return await root.startRelayV2HostShippingRootFromTrustedDeployment(
      owner.activation,
      dashboardManagement,
    );
  } catch {
    try {
      await owner.closeAndDrain();
    } catch {
      throw failure("CLEANUP_FAILED");
    }
    throw failure("ACTIVATION_FAILED");
  }
}

async function openRelayV2HostShippingFromLocalDevelopment(
  signal: AbortSignal,
  options: Readonly<RelayV2HostLocalDevelopmentShippingOptions>,
  dashboardManagement?: RelayV2HostPrivilegedProductionDashboardManagementOptions,
): Promise<RelayV2HostShippingRootHandle> {
  const owner = await createLocalDevelopmentActivationOwner(signal, options);
  try {
    requireStartupOpen(signal);
    const root = await import("./hostShippingRoot.js");
    requireStartupOpen(signal);
    return await root.startRelayV2HostShippingRootFromLocalDevelopmentActivation(
      owner.activation,
      dashboardManagement,
    );
  } catch {
    try {
      await owner.closeAndDrain();
    } catch {
      throw failure("CLEANUP_FAILED");
    }
    throw failure("ACTIVATION_FAILED");
  }
}

async function openRelayV2HostShippingFromSelfHostedDarwinArm64(
  signal: AbortSignal,
  options: Readonly<RelayV2HostSelfHostedDarwinArm64ShippingOptions>,
  dashboardManagement: RelayV2HostPrivilegedProductionDashboardManagementOptions,
): Promise<RelayV2HostShippingRootHandle> {
  const owner = await createSelfHostedDarwinArm64ActivationOwner(signal, options);
  try {
    requireStartupOpen(signal);
    const root = await import("./hostShippingRoot.js");
    requireStartupOpen(signal);
    return await root.startRelayV2HostShippingRootFromSelfHostedDarwinArm64Activation(
      owner.activation,
      dashboardManagement,
    );
  } catch {
    try {
      await owner.closeAndDrain();
    } catch {
      throw failure("CLEANUP_FAILED");
    }
    throw failure("ACTIVATION_FAILED");
  }
}

/**
 * Dashboard hidden-child entry for the same trusted Host deployment owner.
 * The caller supplies only its protocol-v2 channel identity; profile,
 * credential, runtime, transport, and native authorities still come from the
 * one trusted activation above. Unlike the relay-host process entry, this
 * opener does not auto-start or retry the connector: the same root's
 * management session exclusively drives start/stop and enrollment.
 */
export async function startRelayV2HostDashboardManagementFromTrustedDeployment(
  dashboardManagement: RelayV2HostPrivilegedProductionDashboardManagementOptions,
): Promise<RelayV2HostShippingRootHandle> {
  if (arguments.length !== 1
    || dashboardManagement === null
    || typeof dashboardManagement !== "object") {
    throw failure("ACTIVATION_INVALID");
  }
  return openRelayV2HostShippingFromTrustedDeployment(
    dashboardManagement.signal,
    undefined,
    dashboardManagement,
  );
}

/**
 * Upper-layer adoption seam for the explicit local-development activation.
 * It opens the same canonical management session as production, but keeps the
 * isolated trustedHome, explicit CA cuts, and in-memory credential cell owned
 * by the one local activation. It deliberately does not adopt the relay-host
 * auto-start/retry process lifecycle.
 */
export async function startRelayV2HostDashboardManagementFromLocalDevelopment(
  options: unknown,
  dashboardManagement: RelayV2HostPrivilegedProductionDashboardManagementOptions,
): Promise<RelayV2HostShippingRootHandle> {
  if (arguments.length !== 2
    || dashboardManagement === null
    || typeof dashboardManagement !== "object") {
    throw failure("ACTIVATION_INVALID");
  }
  const captured = captureLocalDevelopmentOptions(options);
  return openRelayV2HostShippingFromLocalDevelopment(
    dashboardManagement.signal,
    captured,
    dashboardManagement,
  );
}

/**
 * Exact Dashboard adoption seam for the explicit non-production self-hosted
 * Darwin arm64 lane. It uses the real account home/profile, canonical local
 * runtime discovery with an explicit empty Host config, the persistent native
 * cell selected by one policy ticket, and two distinct owner-only CA inputs.
 * It never selects production on failure.
 */
export async function startRelayV2HostDashboardManagementFromSelfHostedDarwinArm64(
  options: unknown,
  dashboardManagement: RelayV2HostPrivilegedProductionDashboardManagementOptions,
): Promise<RelayV2HostShippingRootHandle> {
  if (arguments.length !== 2
    || dashboardManagement === null
    || typeof dashboardManagement !== "object") {
    throw failure("ACTIVATION_INVALID");
  }
  const captured = captureSelfHostedDarwinArm64Options(options);
  return openRelayV2HostShippingFromSelfHostedDarwinArm64(
    dashboardManagement.signal,
    captured,
    dashboardManagement,
  );
}

/**
 * The process entry for the explicit v2 Host lane. Its signal owner is
 * installed before trusted activation and threads one fence through startup.
 * The trusted source opens exactly one shipping root, then the connector
 * lifecycle retains and drives that same handle until signal, failure, or
 * permanent supersession.
 */
export async function runRelayV2HostShippingFromTrustedDeployment(
  bootstrapSecretInputPath?: string,
): Promise<number> {
  if (arguments.length > 1
    || (bootstrapSecretInputPath !== undefined
      && (typeof bootstrapSecretInputPath !== "string"
        || bootstrapSecretInputPath.length === 0
        || bootstrapSecretInputPath.includes("\0")))) {
    throw failure("ACTIVATION_INVALID");
  }
  const processSignals = new RelayV2HostShippingProcessSignalOwner();
  try {
    try {
    const handle = await openRelayV2HostShippingFromTrustedDeployment(
      processSignals.signal,
      bootstrapSecretInputPath,
      undefined,
    );
      const result = await runRelayV2HostShippingProcessLifecycle(handle, {
        signal: processSignals.signal,
      });
      return result.exitCode;
    } catch (error) {
      if (processSignals.signal.aborted
        && error instanceof RelayV2HostShippingDeploymentSourceError
        && error.code === "ACTIVATION_FAILED") {
        return 0;
      }
      throw error;
    }
  } finally {
    processSignals.close();
  }
}

/**
 * Strictly explicit loopback-only development process entry. It shares the
 * canonical profile/runtime/shipping/process owners with production, but its
 * credential bytes live only in one isolated process-local atomic cell. Both
 * TLS lanes require caller-named CA files and retain normal chain and hostname
 * verification. This entry never reads or changes native qualification.
 */
export async function runRelayV2HostShippingFromLocalDevelopment(
  options: unknown,
): Promise<number> {
  if (arguments.length !== 1) throw failure("ACTIVATION_INVALID");
  const captured = captureLocalDevelopmentOptions(options);
  const processSignals = new RelayV2HostShippingProcessSignalOwner();
  try {
    try {
      const handle = await openRelayV2HostShippingFromLocalDevelopment(
        processSignals.signal,
        captured,
        undefined,
      );
      const result = await runRelayV2HostShippingProcessLifecycle(handle, {
        signal: processSignals.signal,
      });
      return result.exitCode;
    } catch (error) {
      if (processSignals.signal.aborted
        && error instanceof RelayV2HostShippingDeploymentSourceError
        && error.code === "ACTIVATION_FAILED") {
        return 0;
      }
      throw error;
    }
  } finally {
    processSignals.close();
  }
}
