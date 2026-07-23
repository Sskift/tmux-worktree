import { types as nodeTypes } from "node:util";

import {
  createRelayV2HostBootstrapSecretHandoffAuthority,
  type RelayV2HostBootstrapSecretHandoffAuthority,
} from "./hostBootstrapSecretHandoff.js";
import {
  createRelayV2HostBootstrapSecretSource,
  type RelayV2HostBootstrapSecretByteSource,
  type RelayV2HostBootstrapSecretSourceHandle,
} from "./hostBootstrapSecretSource.js";
import {
  openRelayV2HostCanonicalProductionComposition,
  type RelayV2HostCanonicalProductionComposition,
  type RelayV2HostCanonicalProductionCompositionOptions,
} from "./hostCanonicalProductionComposition.js";
import { RelayV2HostCredentialAuthority } from "./hostCredentialAuthority.js";
import { RelayV2HostCredentialExchangeCoordinator } from
  "./hostCredentialExchangeCoordinator.js";
import { RelayV2HostCredentialHttpsAdapter } from "./hostCredentialHttpsAdapter.js";
import {
  type RelayV2HostCredentialAtomicByteCell,
  RelayV2HostCredentialVault,
  RelayV2HostCredentialVaultError,
} from "./hostCredentialVault.js";
import {
  readRelayV2HostProductionProfile,
  type RelayV2HostProductionProfile,
} from "./hostProductionProfileStore.js";

export interface RelayV2HostCredentialAtomicByteCellOwner
extends RelayV2HostCredentialAtomicByteCell {
  closeAndDrain(): Promise<void>;
}

type CanonicalDashboardManagement = NonNullable<
RelayV2HostCanonicalProductionCompositionOptions["dashboardManagement"]
>;

export type RelayV2HostPrivilegedProductionDashboardManagementOptions = Omit<
CanonicalDashboardManagement,
"credentialExchangeCoordinator" | "bootstrapSecretReference" | "refreshSecretReference"
>;

export type RelayV2HostPrivilegedProductionCanonicalOptions = Omit<
RelayV2HostCanonicalProductionCompositionOptions,
"credentialAuthority" | "dashboardManagement"
> & Readonly<{
  dashboardManagement?: RelayV2HostPrivilegedProductionDashboardManagementOptions;
}>;

export interface RelayV2HostPrivilegedProductionIntakeCompositionOptions {
  /** Test isolation only; production omission selects the canonical account home. */
  readonly trustedHome?: string;
  /** Ownership transfers to this composition after successful exact capture. */
  readonly credentialCell: RelayV2HostCredentialAtomicByteCellOwner;
  /** An already-owned privileged channel. No source is selected by this owner. */
  readonly bootstrapSecretByteSource?: RelayV2HostBootstrapSecretByteSource;
  readonly canonical: RelayV2HostPrivilegedProductionCanonicalOptions;
}

export interface RelayV2HostPrivilegedProductionIntakeComposition {
  inspect(): ReturnType<RelayV2HostCanonicalProductionComposition["inspect"]>;
  start(
    input: Parameters<RelayV2HostCanonicalProductionComposition["start"]>[0],
  ): ReturnType<RelayV2HostCanonicalProductionComposition["start"]>;
  requestReauthentication(
    input: Parameters<
    RelayV2HostCanonicalProductionComposition["requestReauthentication"]
    >[0],
  ): boolean;
  stopAndDrain(
    input: Parameters<RelayV2HostCanonicalProductionComposition["stopAndDrain"]>[0],
  ): ReturnType<RelayV2HostCanonicalProductionComposition["stopAndDrain"]>;
  runDashboardManagement?(): Promise<number>;
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostPrivilegedProductionIntakeCompositionErrorCode =
  | "PROFILE_UNAVAILABLE"
  | "OWNER_CONSTRUCTION_FAILED"
  | "BOOTSTRAP_PROVISION_FAILED"
  | "BOOTSTRAP_COMMIT_UNCERTAIN"
  | "CANONICAL_OPEN_FAILED"
  | "COMPOSITION_CLOSED"
  | "CLOSE_FAILED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostPrivilegedProductionIntakeCompositionErrorCode,
string
>> = Object.freeze({
  PROFILE_UNAVAILABLE: "Relay v2 Host production profile is unavailable",
  OWNER_CONSTRUCTION_FAILED: "Relay v2 Host privileged intake owner construction failed",
  BOOTSTRAP_PROVISION_FAILED: "Relay v2 Host bootstrap provisioning failed",
  BOOTSTRAP_COMMIT_UNCERTAIN: "Relay v2 Host bootstrap commit is uncertain",
  CANONICAL_OPEN_FAILED: "Relay v2 Host canonical production composition failed",
  COMPOSITION_CLOSED: "Relay v2 Host privileged intake composition is closed",
  CLOSE_FAILED: "Relay v2 Host privileged intake composition close failed",
});

export class RelayV2HostPrivilegedProductionIntakeCompositionError extends Error {
  constructor(
    readonly code: RelayV2HostPrivilegedProductionIntakeCompositionErrorCode,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostPrivilegedProductionIntakeCompositionError";
  }
}

interface CapturedMethod {
  readonly receiver: object;
  readonly method: Function;
}

interface CapturedCell {
  readonly identity: object;
  readonly port: RelayV2HostCredentialAtomicByteCellOwner;
}

interface CapturedByteSource {
  readonly identity: object;
  readonly port: RelayV2HostBootstrapSecretByteSource;
  readonly cancel: CapturedMethod;
}

interface CapturedCanonicalOptions {
  readonly values: RelayV2HostPrivilegedProductionCanonicalOptions;
  readonly closeSpool: CapturedMethod;
  readonly closeHostState: CapturedMethod;
}

interface CapturedOptions {
  readonly trustedHome: string | undefined;
  readonly cell: CapturedCell;
  readonly sourceOwner: { current: CapturedByteSource | null };
  readonly canonical: CapturedCanonicalOptions;
}

interface OwnedConstruction {
  sourceHandle: RelayV2HostBootstrapSecretSourceHandle | null;
  handoff: RelayV2HostBootstrapSecretHandoffAuthority | null;
  canonical: RelayV2HostCanonicalProductionComposition | null;
  vault: RelayV2HostCredentialVault | null;
}

const CANONICAL_REQUIRED_KEYS = Object.freeze([
  "hostState",
  "recoveredH2Spool",
  "welcome",
  "createTargetAuthority",
  "process",
  "localProcessTarget",
] as const);
const CANONICAL_OPTIONAL_KEYS = Object.freeze([
  "terminalBackend",
  "terminalControl",
  "dashboardManagement",
  "agentTranscriptLifecycle",
] as const);
const DASHBOARD_KEYS = Object.freeze([
  "clock",
  "runtimeVersion",
  "signal",
  "io",
] as const);
const DASHBOARD_IO_KEYS = Object.freeze(["input", "writeFrame"] as const);
const TERMINAL_CONTROL_REQUIRED_KEYS = Object.freeze(["remoteCompoundChannels"] as const);
const TERMINAL_CONTROL_OPTIONAL_KEYS = Object.freeze(["daemonSocketPath"] as const);
const AGENT_ATTACHMENT_KEYS = Object.freeze(["store", "controller"] as const);
const claimedCells = new WeakSet<object>();
const claimedSources = new WeakSet<object>();
const promiseThen = Promise.prototype.then;

function failure(
  code: RelayV2HostPrivilegedProductionIntakeCompositionErrorCode,
): RelayV2HostPrivilegedProductionIntakeCompositionError {
  return new RelayV2HostPrivilegedProductionIntakeCompositionError(code);
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true;
  }
}

function snapshotExactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
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
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && descriptor.value !== undefined) {
      result[key] = descriptor.value;
    }
  }
  return Object.freeze(result);
}

function captureDataMethod(value: unknown, key: PropertyKey): CapturedMethod | null {
  if (value === null
    || (typeof value !== "object" && typeof value !== "function")
    || rejectedProxy(value)) return null;
  const receiver = value as object;
  const seen = new Set<object>();
  let owner: object | null = receiver;
  try {
    while (owner !== null && seen.size < 32) {
      if (seen.has(owner) || rejectedProxy(owner)) return null;
      seen.add(owner);
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, "value")
          || typeof descriptor.value !== "function"
          || rejectedProxy(descriptor.value)) return null;
        return Object.freeze({ receiver, method: descriptor.value });
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

function invoke(captured: CapturedMethod, args: readonly unknown[]): unknown {
  return Reflect.apply(captured.method, captured.receiver, args);
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  if (!(value instanceof Promise) || rejectedProxy(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Promise.prototype;
  } catch {
    return false;
  }
}

async function waitForVoid(value: unknown, allowUndefined = false): Promise<void> {
  if (allowUndefined && value === undefined) return;
  if (!isNativePromise(value)) throw failure("CLOSE_FAILED");
  await Reflect.apply(promiseThen, value, []);
}

function frozenCellPort(
  runExclusive: CapturedMethod,
  closeAndDrain: CapturedMethod,
): RelayV2HostCredentialAtomicByteCellOwner {
  const port = Object.create(null) as RelayV2HostCredentialAtomicByteCellOwner;
  Object.defineProperties(port, {
    runExclusive: {
      enumerable: false,
      value: <T>(operation: Parameters<RelayV2HostCredentialAtomicByteCell["runExclusive"]>[0]) => (
        invoke(runExclusive, [operation]) as T
      ),
    },
    closeAndDrain: {
      enumerable: false,
      value: () => invoke(closeAndDrain, []) as Promise<void>,
    },
  });
  return Object.freeze(port);
}

function captureCell(value: unknown): CapturedCell | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  const runExclusive = captureDataMethod(value, "runExclusive");
  const closeAndDrain = captureDataMethod(value, "closeAndDrain");
  if (runExclusive === null || closeAndDrain === null) return null;
  return Object.freeze({
    identity: value,
    port: frozenCellPort(runExclusive, closeAndDrain),
  });
}

function captureByteSource(value: unknown): CapturedByteSource | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  const openIterator = captureDataMethod(value, Symbol.asyncIterator);
  const cancel = captureDataMethod(value, "cancel");
  if (openIterator === null || cancel === null) return null;
  let port!: RelayV2HostBootstrapSecretByteSource;
  const captured = Object.create(null) as RelayV2HostBootstrapSecretByteSource;
  Object.defineProperties(captured, {
    [Symbol.asyncIterator]: {
      enumerable: false,
      value: function iterator(this: unknown): AsyncIterator<Uint8Array> {
        if (this !== port) throw failure("OWNER_CONSTRUCTION_FAILED");
        return invoke(openIterator, []) as AsyncIterator<Uint8Array>;
      },
    },
    cancel: {
      enumerable: false,
      value: function close(this: unknown): void | Promise<void> {
        if (this !== port) throw failure("OWNER_CONSTRUCTION_FAILED");
        return invoke(cancel, []) as void | Promise<void>;
      },
    },
  });
  port = Object.freeze(captured);
  return Object.freeze({ identity: value, port, cancel });
}

function freezeRecord(values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(values)) result[key] = values[key];
  return Object.freeze(result);
}

function captureCanonicalOptions(value: unknown): CapturedCanonicalOptions | null {
  const fields = snapshotExactDataRecord(
    value,
    CANONICAL_REQUIRED_KEYS,
    CANONICAL_OPTIONAL_KEYS,
  );
  if (fields === null) return null;
  const closeSpool = captureDataMethod(fields.recoveredH2Spool, "close");
  const closeHostState = captureDataMethod(fields.hostState, "close");
  if (closeSpool === null || closeHostState === null) return null;

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of CANONICAL_REQUIRED_KEYS) result[key] = fields[key];

  if (fields.terminalBackend !== undefined) {
    result.terminalBackend = fields.terminalBackend;
  }

  if (fields.terminalControl !== undefined) {
    const terminalControl = snapshotExactDataRecord(
      fields.terminalControl,
      TERMINAL_CONTROL_REQUIRED_KEYS,
      TERMINAL_CONTROL_OPTIONAL_KEYS,
    );
    if (terminalControl === null) return null;
    result.terminalControl = freezeRecord(terminalControl);
  }
  if (fields.dashboardManagement !== undefined) {
    const dashboard = snapshotExactDataRecord(fields.dashboardManagement, DASHBOARD_KEYS);
    if (dashboard === null
      || typeof dashboard.clock !== "function"
      || rejectedProxy(dashboard.clock)
      || typeof dashboard.runtimeVersion !== "string") return null;
    const io = snapshotExactDataRecord(dashboard.io, DASHBOARD_IO_KEYS);
    if (io === null
      || typeof io.writeFrame !== "function"
      || rejectedProxy(io.writeFrame)) return null;
    result.dashboardManagement = freezeRecord({
      ...dashboard,
      io: freezeRecord(io),
    });
  }
  if (fields.agentTranscriptLifecycle !== undefined) {
    const agent = snapshotExactDataRecord(
      fields.agentTranscriptLifecycle,
      AGENT_ATTACHMENT_KEYS,
    );
    if (agent === null) return null;
    result.agentTranscriptLifecycle = freezeRecord(agent);
  }
  return Object.freeze({
    values: freezeRecord(result) as RelayV2HostPrivilegedProductionCanonicalOptions,
    closeSpool,
    closeHostState,
  });
}

function captureOptions(
  value: unknown,
): CapturedOptions | null {
  const fields = snapshotExactDataRecord(value, ["credentialCell", "canonical"], [
    "trustedHome",
    "bootstrapSecretByteSource",
  ]);
  if (fields === null) return null;
  if (fields.trustedHome !== undefined && typeof fields.trustedHome !== "string") return null;
  const cell = captureCell(fields.credentialCell);
  const source = fields.bootstrapSecretByteSource === undefined
    ? null
    : captureByteSource(fields.bootstrapSecretByteSource);
  const canonical = captureCanonicalOptions(fields.canonical);
  if (cell === null || source === null && fields.bootstrapSecretByteSource !== undefined
    || canonical === null) return null;
  return Object.freeze({
    trustedHome: fields.trustedHome as string | undefined,
    cell,
    sourceOwner: { current: source },
    canonical,
  });
}

function readProfile(trustedHome: string | undefined): Readonly<RelayV2HostProductionProfile> {
  return trustedHome === undefined
    ? readRelayV2HostProductionProfile()
    : readRelayV2HostProductionProfile({ trustedHome });
}

function transferSourceOwner(
  captured: CapturedOptions,
  handoff: RelayV2HostBootstrapSecretHandoffAuthority,
): RelayV2HostBootstrapSecretSourceHandle {
  const source = captured.sourceOwner.current;
  if (source === null) throw failure("OWNER_CONSTRUCTION_FAILED");
  const handle = createRelayV2HostBootstrapSecretSource(
    source.port,
    handoff.privilegedIntake,
  );
  // The source adapter now has the only strong reference required for the
  // admitted read/cancel lifecycle. Its own terminal paths clear that state.
  captured.sourceOwner.current = null;
  return handle;
}

async function cancelCapturedSource(source: CapturedByteSource): Promise<void> {
  const result = invoke(source.cancel, []);
  await waitForVoid(result, true);
}

async function closeCapturedOwners(
  captured: CapturedOptions,
  owned: OwnedConstruction,
): Promise<boolean> {
  let failed = false;
  const settle = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch {
      failed = true;
    }
  };

  await settle(async () => {
    if (owned.sourceHandle !== null) {
      await waitForVoid(owned.sourceHandle.closeAndDrain());
    } else if (captured.sourceOwner.current !== null) {
      await cancelCapturedSource(captured.sourceOwner.current);
      captured.sourceOwner.current = null;
    }
  });
  await settle(async () => {
    if (owned.handoff !== null) await waitForVoid(owned.handoff.closeAndDrain());
  });
  await settle(async () => {
    if (owned.canonical !== null) {
      await waitForVoid(owned.canonical.closeAndDrain());
      return;
    }
    // The canonical opener may have crossed its ownership cut and completed
    // this rollback itself before throwing. These two exact owners explicitly
    // make close idempotent: the spool returns its stable close barrier and H0
    // returns immediately once closed. Repeating only those existing closes
    // also covers a throw before the canonical owner claimed them.
    await waitForVoid(invoke(captured.canonical.closeSpool, []), true);
    await waitForVoid(invoke(captured.canonical.closeHostState, []), true);
  });
  await settle(async () => {
    if (owned.vault !== null) await waitForVoid(owned.vault.closeAndDrain());
  });
  await settle(async () => {
    await waitForVoid(captured.cell.port.closeAndDrain());
  });
  return failed;
}

function canonicalOptions(
  captured: CapturedCanonicalOptions,
  profile: Readonly<RelayV2HostProductionProfile>,
  authority: RelayV2HostCredentialAuthority,
  coordinator: RelayV2HostCredentialExchangeCoordinator,
): RelayV2HostCanonicalProductionCompositionOptions {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(captured.values)) {
    if (key !== "dashboardManagement") result[key] = Reflect.get(captured.values, key);
  }
  result.credentialAuthority = authority;
  const dashboard = captured.values.dashboardManagement;
  if (dashboard !== undefined) {
    result.dashboardManagement = freezeRecord({
      credentialExchangeCoordinator: coordinator,
      bootstrapSecretReference: profile.bootstrapSecretReference,
      refreshSecretReference: profile.refreshSecretReference,
      clock: dashboard.clock,
      runtimeVersion: dashboard.runtimeVersion,
      signal: dashboard.signal,
      io: dashboard.io,
    });
  }
  return Object.freeze(result) as unknown as RelayV2HostCanonicalProductionCompositionOptions;
}

function canonicalProfile(
  profile: Readonly<RelayV2HostProductionProfile>,
): Readonly<{ relayUrl: string; hostId: string; credentialReference: string }> {
  return Object.freeze(Object.assign(Object.create(null), {
    relayUrl: profile.relayUrl,
    hostId: profile.hostId,
    credentialReference: profile.credentialReference,
  }));
}

function closedGuard(lifecycle: "open" | "closing" | "closed"): void {
  if (lifecycle !== "open") throw failure("COMPOSITION_CLOSED");
}

function issueFacade(
  captured: CapturedOptions,
  owned: OwnedConstruction,
): RelayV2HostPrivilegedProductionIntakeComposition {
  const canonical = owned.canonical!;
  let lifecycle: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | null = null;
  const closeAndDrain = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    lifecycle = "closing";
    closePromise = (async () => {
      const closeFailed = await closeCapturedOwners(captured, owned);
      lifecycle = "closed";
      if (closeFailed) throw failure("CLOSE_FAILED");
    })();
    void closePromise.catch(() => undefined);
    return closePromise;
  };
  const facade = Object.create(null) as RelayV2HostPrivilegedProductionIntakeComposition;
  Object.defineProperties(facade, {
    inspect: {
      enumerable: true,
      value: () => {
        closedGuard(lifecycle);
        return canonical.inspect();
      },
    },
    start: {
      enumerable: true,
      value: (input: Parameters<RelayV2HostCanonicalProductionComposition["start"]>[0]) => {
        closedGuard(lifecycle);
        return canonical.start(input);
      },
    },
    requestReauthentication: {
      enumerable: true,
      value: (
        input: Parameters<
        RelayV2HostCanonicalProductionComposition["requestReauthentication"]
        >[0],
      ) => {
        closedGuard(lifecycle);
        return canonical.requestReauthentication(input);
      },
    },
    stopAndDrain: {
      enumerable: true,
      value: (
        input: Parameters<RelayV2HostCanonicalProductionComposition["stopAndDrain"]>[0],
      ) => {
        closedGuard(lifecycle);
        return canonical.stopAndDrain(input);
      },
    },
    closeAndDrain: { enumerable: true, value: closeAndDrain },
  });
  if (typeof canonical.runDashboardManagement === "function") {
    Object.defineProperty(facade, "runDashboardManagement", {
      enumerable: true,
      value: () => {
        closedGuard(lifecycle);
        return canonical.runDashboardManagement!();
      },
    });
  }
  return Object.freeze(facade);
}

/**
 * Default-off owner for one existing Host profile's privileged credential
 * intake and canonical Host composition. It selects no secret source, native
 * loader, CLI, environment, management channel, connector start, or fallback.
 */
export async function openRelayV2HostPrivilegedProductionIntakeComposition(
  options: RelayV2HostPrivilegedProductionIntakeCompositionOptions,
): Promise<RelayV2HostPrivilegedProductionIntakeComposition | null> {
  const captured = captureOptions(options);
  const capturedSource = captured?.sourceOwner.current ?? null;
  if (captured === null
    || claimedCells.has(captured.cell.identity)
    || capturedSource !== null && claimedSources.has(capturedSource.identity)) return null;
  claimedCells.add(captured.cell.identity);
  if (capturedSource !== null) claimedSources.add(capturedSource.identity);

  const owned: OwnedConstruction = {
    sourceHandle: null,
    handoff: null,
    canonical: null,
    vault: null,
  };
  let stage: RelayV2HostPrivilegedProductionIntakeCompositionErrorCode =
    "PROFILE_UNAVAILABLE";
  try {
    const profile = readProfile(captured.trustedHome);
    stage = "OWNER_CONSTRUCTION_FAILED";
    const handoff = createRelayV2HostBootstrapSecretHandoffAuthority();
    owned.handoff = handoff;
    const vault = new RelayV2HostCredentialVault({
      hostId: profile.hostId,
      credentialReference: profile.credentialReference,
      bootstrapSecretReference: profile.bootstrapSecretReference,
      refreshSecretReference: profile.refreshSecretReference,
      cell: captured.cell.port,
      bootstrapSecretHandoff: handoff.handoff,
    });
    owned.vault = vault;
    const authority = new RelayV2HostCredentialAuthority({
      storage: vault,
      secretResolver: vault,
    });
    // A read-only recovery pass validates the complete existing envelope even
    // when no privileged source was supplied.
    const recoveredCredential = authority.inspect(profile.credentialReference);
    if (captured.sourceOwner.current === null && recoveredCredential === null) {
      // The Vault is the only envelope decoder. A successful resolve proves
      // the permitted durable bootstrap-only intermediate state; discard the
      // returned secret immediately and never retain it in this composition.
      void vault.resolve(profile.bootstrapSecretReference);
    }
    const httpsAdapter = new RelayV2HostCredentialHttpsAdapter({
      issuerUrl: profile.credentialIssuerUrl,
    });
    const coordinator = new RelayV2HostCredentialExchangeCoordinator({
      authority,
      httpsAdapter,
    });

    if (captured.sourceOwner.current !== null) {
      stage = "BOOTSTRAP_PROVISION_FAILED";
      const sourceHandle = transferSourceOwner(captured, handoff);
      owned.sourceHandle = sourceHandle;
      const candidate = await sourceHandle.readCandidate();
      vault.provisionBootstrap(candidate);
    }

    stage = "CANONICAL_OPEN_FAILED";
    const canonical = await openRelayV2HostCanonicalProductionComposition(
      canonicalProfile(profile),
      canonicalOptions(captured.canonical, profile, authority, coordinator),
    );
    if (canonical === null) throw failure("CANONICAL_OPEN_FAILED");
    owned.canonical = canonical;
    return issueFacade(captured, owned);
  } catch (error) {
    await closeCapturedOwners(captured, owned);
    if (error instanceof RelayV2HostCredentialVaultError
      && error.code === "RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN") {
      throw failure("BOOTSTRAP_COMMIT_UNCERTAIN");
    }
    if (error instanceof RelayV2HostPrivilegedProductionIntakeCompositionError) {
      throw error;
    }
    throw failure(stage);
  }
}
