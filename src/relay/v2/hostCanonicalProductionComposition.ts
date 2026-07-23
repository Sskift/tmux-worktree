import { types as nodeTypes } from "node:util";
import { terminalControlSocketPath } from "../../terminalControl/store.js";
import {
  RelayV2CanonicalAgentMessageTerminalExecutionAdapter,
  RelayV2CanonicalCommandTargetAuthorityAdapter,
  type RelayV2CanonicalCreateTargetAuthorityPortV1,
} from "./canonicalCommandTargetAuthorityAdapter.js";
import {
  RelayV2CanonicalCommandExecutorAdapter,
  type RelayV2StructuredProcessPort,
} from "./canonicalCommandExecutorAdapter.js";
import { RelayV2CanonicalTerminalTargetResolverAdapter } from "./canonicalTerminalTargetResolverAdapter.js";
import { RelayV2HostCommandPlane } from "./hostCommandPlane.js";
import {
  openRelayV2HostManagedWssConnectorRuntimeComposition,
  type RelayV2HostManagedConnectorInspection,
  type RelayV2HostManagedConnectorRuntimeComposition,
  type RelayV2HostManagedConnectorStartInput,
  type RelayV2HostManagedConnectorStopInput,
  type RelayV2HostManagedConnectorReauthenticationInput,
} from "./hostRuntimeComposition.js";
import { captureRelayV2HostH0ReadinessPort, type RelayV2HostStateStore } from "./hostState.js";
import {
  isRelayV2HostCredentialAuthority,
  type RelayV2HostCredentialAuthority,
} from "./hostCredentialAuthority.js";
import type { RelayV2HostRuntimeWelcomeSerializer } from "./hostRuntime.js";
import {
  captureRelayV2RecoveredHostH2ProcessAuthority,
  type RelayV2StateSnapshotSpool,
} from "./stateSnapshotSpool.js";
import {
  RelayV2TerminalManager,
  RelayV2TerminalManagerError,
  type RelayV2TerminalByteBackend,
  type RelayV2TerminalOpenResponseLineage,
  type RelayV2TerminalRuntimeBinding,
} from "./terminalManager.js";
import { RelayV2TerminalDurableLineageAuthority } from "./terminalDurableLineage.js";
import { RelayV2TerminalControlAuthorityAdapter } from "./terminalControlAuthorityAdapter.js";
import {
  captureRelayV2LocalExactCompoundChannelFactoryV1,
  preflightRelayV2ExactCompoundTargetsV1,
  RelayV2RemoteExactTerminalControlCompoundAdapterV1,
  type RelayV2ExactCompoundProcessTargetV1,
  type RelayV2RemoteExactCompoundChannelFactoryV1,
} from "./remoteExactTerminalControlCompoundV1.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import type { RelayV2CanonicalResourceResolverPort } from "./resourceState.js";
import {
  isRelayV2HostCredentialExchangeCoordinatorForAuthority,
  type RelayV2HostCredentialExchangeCoordinator,
} from "./hostCredentialExchangeCoordinator.js";
import {
  createRelayV2DashboardManagementProtocolV2CompositionSession,
  type RelayV2DashboardManagementProtocolV2CompositionSession,
} from "./relayV2DashboardManagementProtocolV2CompositionSession.js";
import type { RelayV2DashboardManagementStdioIo } from
  "./relayV2DashboardManagementStdio.js";
import type { CodexAppServerProcessControllerPort } from
  "../extensions/agentTranscriptLifecycle/v1/codexAppServerProcessControllerAuthority.js";
import {
  RelayAgentAuthorityStore,
  type RelayAgentAuthorityStoreOptions,
} from "../extensions/agentTranscriptLifecycle/v1/store.js";
import type { RelayV2HostOptionalExtensionAttachment } from "./hostRuntime.js";

export interface RelayV2HostCanonicalProductionProfile {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly credentialReference: string;
}

export interface RelayV2HostCanonicalProductionCompositionOptions {
  readonly hostState: RelayV2HostStateStore;
  readonly recoveredH2Spool: RelayV2StateSnapshotSpool;
  readonly credentialAuthority: RelayV2HostCredentialAuthority;
  readonly welcome: RelayV2HostRuntimeWelcomeSerializer;
  readonly createTargetAuthority: RelayV2CanonicalCreateTargetAuthorityPortV1;
  readonly process: RelayV2StructuredProcessPort;
  readonly terminalBackend: RelayV2TerminalByteBackend;
  readonly localProcessTarget: Readonly<{ kind: "local"; targetId: string }>;
  readonly terminalControl?: Readonly<{
    daemonSocketPath?: string;
    remoteCompoundChannels: RelayV2RemoteExactCompoundChannelFactoryV1;
  }>;
  /** Default-off. The canonical root supplies the exact Host/credential lineage. */
  readonly dashboardManagement?: Readonly<{
    credentialExchangeCoordinator: RelayV2HostCredentialExchangeCoordinator;
    bootstrapSecretReference: string;
    refreshSecretReference: string;
    clock: () => number;
    runtimeVersion: string;
    signal: AbortSignal;
    io: RelayV2DashboardManagementStdioIo;
  }>;
  /** Default-off. The root supplies the recovered Host lineage itself. */
  readonly agentTranscriptLifecycle?: Readonly<{
    store: Omit<RelayAgentAuthorityStoreOptions, "hostId" | "hostEpoch">;
    controller: CodexAppServerProcessControllerPort;
  }>;
}

export interface RelayV2HostCanonicalProductionComposition {
  inspect(): RelayV2HostManagedConnectorInspection;
  start(input: Readonly<RelayV2HostManagedConnectorStartInput>): ReturnType<
    RelayV2HostManagedConnectorRuntimeComposition["start"]
  >;
  requestReauthentication(
    input: Readonly<RelayV2HostManagedConnectorReauthenticationInput>,
  ): boolean;
  stopAndDrain(input: Readonly<RelayV2HostManagedConnectorStopInput>): ReturnType<
    RelayV2HostManagedConnectorRuntimeComposition["stopAndDrain"]
  >;
  runDashboardManagement?(): Promise<number>;
  closeAndDrain(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPort(value: unknown, methods: readonly string[]): boolean {
  return isRecord(value) && methods.every((method) => typeof value[method] === "function");
}

type CapturedDashboardManagementOptions = NonNullable<
  RelayV2HostCanonicalProductionCompositionOptions["dashboardManagement"]
>;

const DASHBOARD_MANAGEMENT_KEYS = Object.freeze([
  "credentialExchangeCoordinator",
  "bootstrapSecretReference",
  "refreshSecretReference",
  "clock",
  "runtimeVersion",
  "signal",
  "io",
] as const);
const DASHBOARD_MANAGEMENT_IO_KEYS = Object.freeze(["input", "writeFrame"] as const);
const ABORT_SIGNAL_OVERRIDE_KEYS = Object.freeze([
  "aborted", "addEventListener", "removeEventListener",
] as const);
const NATIVE_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

function exactOwnDataValues(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return null;
  if (Array.isArray(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !Object.hasOwn(descriptor, "value");
    })) return null;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function hasDataMethod(value: unknown, key: PropertyKey): boolean {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const seen = new Set<object>();
  let owner: object | null = value;
  for (let depth = 0; owner !== null && depth < 32; depth += 1) {
    if (nodeTypes.isProxy(owner) || seen.has(owner)) return false;
    seen.add(owner);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    } catch {
      return false;
    }
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function";
    }
    try {
      owner = Object.getPrototypeOf(owner) as object | null;
    } catch {
      return false;
    }
  }
  return false;
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)
    || NATIVE_ABORTED_GETTER === undefined) return false;
  try {
    if (Object.getPrototypeOf(value) !== AbortSignal.prototype
      || ABORT_SIGNAL_OVERRIDE_KEYS.some(
        (key) => Object.getOwnPropertyDescriptor(value, key) !== undefined,
      )) return false;
    return typeof Reflect.apply(NATIVE_ABORTED_GETTER, value, []) === "boolean";
  } catch {
    return false;
  }
}

function captureDashboardManagementOptions(
  options: RelayV2HostCanonicalProductionCompositionOptions,
): CapturedDashboardManagementOptions | undefined | null {
  let optionDescriptor: PropertyDescriptor | undefined;
  try {
    optionDescriptor = Object.getOwnPropertyDescriptor(options, "dashboardManagement");
  } catch {
    return null;
  }
  if (optionDescriptor === undefined) return undefined;
  if (!Object.hasOwn(optionDescriptor, "value")) return null;
  const raw = optionDescriptor.value;
  if (raw === undefined) return undefined;
  const fields = exactOwnDataValues(raw, DASHBOARD_MANAGEMENT_KEYS);
  if (fields === null) return null;
  const io = exactOwnDataValues(fields.io, DASHBOARD_MANAGEMENT_IO_KEYS);
  if (io === null
    || !isRelayV2HostCredentialExchangeCoordinatorForAuthority(
      fields.credentialExchangeCoordinator,
      options.credentialAuthority,
    )
    || typeof fields.bootstrapSecretReference !== "string"
    || typeof fields.refreshSecretReference !== "string"
    || typeof fields.clock !== "function"
    || nodeTypes.isProxy(fields.clock)
    || typeof fields.runtimeVersion !== "string"
    || !isNativeAbortSignal(fields.signal)
    || !hasDataMethod(io.input, Symbol.asyncIterator)
    || typeof io.writeFrame !== "function"
    || nodeTypes.isProxy(io.writeFrame)) return null;
  return Object.freeze(Object.assign(Object.create(null), {
    credentialExchangeCoordinator: fields.credentialExchangeCoordinator,
    bootstrapSecretReference: fields.bootstrapSecretReference,
    refreshSecretReference: fields.refreshSecretReference,
    clock: fields.clock,
    runtimeVersion: fields.runtimeVersion,
    signal: fields.signal,
    io: Object.freeze(Object.assign(Object.create(null), {
      input: io.input,
      writeFrame: io.writeFrame,
    })),
  })) as CapturedDashboardManagementOptions;
}

type RelayV2HostAgentAttachmentOpener = (options: Readonly<{
  store: RelayAgentAuthorityStore;
  controller: CodexAppServerProcessControllerPort;
  canonicalResourceResolver: RelayV2CanonicalResourceResolverPort;
}>) => Promise<RelayV2HostOptionalExtensionAttachment>;

async function loadRelayV2HostAgentAttachmentOpener(): Promise<
RelayV2HostAgentAttachmentOpener
> {
  const entryUrl = new URL("./hostAgentTranscriptLifecycleAttachment.js", import.meta.url).href;
  const entry = await import(entryUrl) as unknown;
  if (!isRecord(entry)
    || typeof entry.openRelayV2HostAgentTranscriptLifecycleAttachment !== "function") {
    throw new Error("Relay Agent Host attachment entry is unavailable");
  }
  const opener = entry.openRelayV2HostAgentTranscriptLifecycleAttachment;
  return (options) => Promise.resolve(Reflect.apply(opener, entry, [options]));
}

function terminalControlOptions(
  value: RelayV2HostCanonicalProductionCompositionOptions["terminalControl"],
): {
  daemonSocketPath: string;
  remoteCompoundChannels: RelayV2RemoteExactCompoundChannelFactoryV1;
} | null {
  if (!isRecord(value)
    || (value.daemonSocketPath !== undefined && typeof value.daemonSocketPath !== "string")
    || !validPort(value.remoteCompoundChannels, ["open"])) return null;
  return {
    daemonSocketPath: value.daemonSocketPath ?? terminalControlSocketPath(),
    remoteCompoundChannels: value.remoteCompoundChannels,
  };
}

function validateOptions(
  profile: RelayV2HostCanonicalProductionProfile,
  options: RelayV2HostCanonicalProductionCompositionOptions,
): boolean {
  return isRecord(profile)
    && typeof profile.relayUrl === "string"
    && typeof profile.hostId === "string"
    && typeof profile.credentialReference === "string"
    && isRecord(options)
    && validPort(options.hostState, ["read", "serialize", "close"])
    && validPort(options.recoveredH2Spool, [
      "issueRecoveredHostH2Candidate", "issueFreshInstallHostH2Candidate", "close",
    ])
    && isRelayV2HostCredentialAuthority(options.credentialAuthority)
    && validPort(options.welcome, ["build"])
    && validPort(options.createTargetAuthority, [
      "resolveCreateTarget", "fenceCreateTargetForAdmission",
    ])
    && validPort(options.process, ["execute"])
    && validPort(options.terminalBackend, ["open"])
    && isRecord(options.localProcessTarget)
    && options.localProcessTarget.kind === "local"
    && typeof options.localProcessTarget.targetId === "string"
    && (options.agentTranscriptLifecycle === undefined
      || (isRecord(options.agentTranscriptLifecycle)
        && isRecord(options.agentTranscriptLifecycle.store)
        && validPort(options.agentTranscriptLifecycle.controller, [
          "claimControlledProcess",
        ])));
}

async function settleAll(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  let firstFailure: unknown = null;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (firstFailure === null) firstFailure = error;
    }
  }
  if (firstFailure !== null) throw firstFailure;
}

/**
 * Default-off production owner. Construction recovers existing durable owners
 * but never starts the connector, opens WSS, or advertises a capability.
 */
export async function openRelayV2HostCanonicalProductionComposition(
  profile: RelayV2HostCanonicalProductionProfile,
  options: RelayV2HostCanonicalProductionCompositionOptions,
): Promise<RelayV2HostCanonicalProductionComposition | null> {
  if (!validateOptions(profile, options)) return null;
  const dashboardManagement = captureDashboardManagementOptions(options);
  if (dashboardManagement === null) return null;
  const terminalOptions = terminalControlOptions(
    options.terminalControl,
  );
  if (terminalOptions === null) return null;

  const h0 = captureRelayV2HostH0ReadinessPort(options.hostState.h0ReadinessPort);
  if (h0 === null) return null;
  let exactTargets: RelayV2RemoteExactTerminalControlCompoundAdapterV1 | null = null;
  let terminalManager: RelayV2TerminalManager | null = null;
  let optionalExtension: RelayV2HostOptionalExtensionAttachment | null = null;
  let managed: RelayV2HostManagedConnectorRuntimeComposition | null = null;
  let dashboardManagementSession:
    RelayV2DashboardManagementProtocolV2CompositionSession | null = null;
  let claimedOwners = false;
  try {
    const snapshot = await options.hostState.read();
    // The fresh-install bootstrap is consulted first because it is structurally
    // inert around any recovered authority: it returns null before touching
    // reconcile or the cut source whenever the spool holds any recovered or
    // published cut, reservation, tombstone, or in-flight build, and the
    // recovered port can only issue from exactly such state. Recovered
    // issuance therefore proceeds unchanged whenever it can succeed at all.
    const h2Candidate = await options.recoveredH2Spool.issueFreshInstallHostH2Candidate()
      ?? await options.recoveredH2Spool.issueRecoveredHostH2Candidate();
    if (h2Candidate === null) {
      claimedOwners = true;
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "Recovered H2 authority is unavailable",
      );
    }
    claimedOwners = true;
    const h2 = captureRelayV2RecoveredHostH2ProcessAuthority(
      h2Candidate,
      options.hostState,
    );
    if (h2 === null
      || h2.hostId !== profile.hostId
      || h2.hostEpoch !== snapshot.hostEpoch
      || h2.hostInstanceId !== options.hostState.hostInstanceId) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "Recovered H2 authority crossed the HostState lineage",
      );
    }

    const localCompoundChannels = captureRelayV2LocalExactCompoundChannelFactoryV1({
      daemonSocketPath: terminalOptions.daemonSocketPath,
      processTarget: options.localProcessTarget,
    });
    const compoundChannels: RelayV2RemoteExactCompoundChannelFactoryV1 = Object.freeze({
      open(target: RelayV2ExactCompoundProcessTargetV1) {
        return target.kind === "local"
          ? localCompoundChannels.open(target)
          : terminalOptions.remoteCompoundChannels.open(target);
      },
    });
    const h2ProcessTargets = await h2.captureProcessTargets(snapshot.hostEpoch);
    await preflightRelayV2ExactCompoundTargetsV1(compoundChannels, [
      options.localProcessTarget,
      ...h2ProcessTargets,
    ]);
    const reservationOwner = Object.freeze({
      kind: "relay-v2" as const,
      instanceId: `relay-v2-host-${options.hostState.hostInstanceId}`,
    });
    exactTargets = new RelayV2RemoteExactTerminalControlCompoundAdapterV1({
      channels: compoundChannels,
      owner: reservationOwner,
    });
    const commandTargets = new RelayV2CanonicalCommandTargetAuthorityAdapter({
      resourceResolver: h2.resourceResolver,
      createTargetAuthority: options.createTargetAuthority,
      exactTerminalTarget: exactTargets,
    });
    const commandTerminal = new RelayV2CanonicalAgentMessageTerminalExecutionAdapter(
      exactTargets,
      exactTargets,
    );
    const commandExecutor = new RelayV2CanonicalCommandExecutorAdapter({
      resolver: commandTargets,
      process: options.process,
      terminalControl: commandTerminal,
      terminalOwner: reservationOwner,
    });
    const h1Candidate = await RelayV2HostCommandPlane.openRecoveredAuthority({
      store: options.hostState,
      hostId: profile.hostId,
      executor: commandExecutor,
      resourceMutationOwner: h2.resourceMutationOwner,
    });
    if (h1Candidate === null) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "Recovered H1 authority is unavailable",
      );
    }

    const terminalResolver = new RelayV2CanonicalTerminalTargetResolverAdapter({
      resourceResolver: h2.resourceResolver,
      exactControlTarget: exactTargets,
    });
    const terminalLineage = new RelayV2TerminalDurableLineageAuthority({
      store: options.hostState,
      admissionFence: terminalResolver,
    });
    const terminalControl = new RelayV2TerminalControlAuthorityAdapter(
      exactTargets,
      exactTargets,
    );
    let routeFenced = false;
    const send = async (
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      lineage?: RelayV2TerminalOpenResponseLineage,
    ): Promise<void> => {
      if (routeFenced || managed === null) {
        throw new RelayV2TerminalManagerError(
          "CAPABILITY_UNAVAILABLE",
          "Relay v2 Host terminal route is unavailable",
        );
      }
      await managed.sendTerminalFrame(route, frame, lineage);
    };
    terminalManager = new RelayV2TerminalManager({
      hostId: profile.hostId,
      hostEpoch: snapshot.hostEpoch,
      hostInstanceId: options.hostState.hostInstanceId,
      resolver: terminalResolver,
      lineage: terminalLineage,
      backend: options.terminalBackend,
      terminalControl,
      send,
    });
    const h3Candidate = await terminalLineage.recoverForHostH3(terminalManager);
    if (options.agentTranscriptLifecycle !== undefined) {
      try {
        const openAttachment = await loadRelayV2HostAgentAttachmentOpener();
        const store = await RelayAgentAuthorityStore.open({
          ...options.agentTranscriptLifecycle.store,
          hostId: profile.hostId,
          hostEpoch: snapshot.hostEpoch,
        });
        optionalExtension = await openAttachment({
          store,
          controller: options.agentTranscriptLifecycle.controller,
          canonicalResourceResolver: h2.resourceResolver,
        });
      } catch {
        // The optional owner is an isolation domain. Corrupt/unavailable
        // continuity or source activation cannot withdraw H0-H3 or the route.
        optionalExtension = null;
      }
    }
    managed = await openRelayV2HostManagedWssConnectorRuntimeComposition(Object.freeze({
      runtime: Object.freeze({
        hostId: profile.hostId,
        hostEpoch: snapshot.hostEpoch,
        hostInstanceId: options.hostState.hostInstanceId,
        authorities: Object.freeze({
          h0,
          h1RecoveryCandidate: h1Candidate,
          h2RecoveryCandidate: h2.h2RecoveryCandidate,
          h3RecoveryCandidate: h3Candidate,
        }),
        welcome: options.welcome,
        ...(optionalExtension === null ? {} : { optionalExtension }),
      }),
      connector: Object.freeze({
        credentialAuthority: options.credentialAuthority,
        credentialReference: profile.credentialReference,
        carrier: Object.freeze({}),
        wss: Object.freeze({ relayUrl: profile.relayUrl }),
      }),
    }));
    if (await managed.readiness.h0.activate() !== true) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "Recovered H0 authority could not activate readiness",
      );
    }
    if (managed.readiness.h3.activate() !== true) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "Recovered H3 authority could not activate readiness",
      );
    }
    if (dashboardManagement !== undefined) {
      dashboardManagementSession =
        createRelayV2DashboardManagementProtocolV2CompositionSession(Object.freeze({
          credentialAuthority: options.credentialAuthority,
          credentialExchangeCoordinator:
            dashboardManagement.credentialExchangeCoordinator,
          hostManagementPort: managed.dashboardManagementPort,
          hostId: profile.hostId,
          hostEpoch: snapshot.hostEpoch,
          hostInstanceId: options.hostState.hostInstanceId,
          credentialReference: profile.credentialReference,
          bootstrapSecretReference: dashboardManagement.bootstrapSecretReference,
          refreshSecretReference: dashboardManagement.refreshSecretReference,
          signal: dashboardManagement.signal,
          clock: dashboardManagement.clock,
          runtimeVersion: dashboardManagement.runtimeVersion,
          io: dashboardManagement.io,
        }));
    }

    let closeBarrier: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closeBarrier !== null) return closeBarrier;
      routeFenced = true;
      const closingManaged = managed!;
      const closingExactTargets = exactTargets!;
      // Closing the preparation owner here would revoke an admitted claim
      // while H1/H3 still owns an in-flight frame. Fence only new resolution;
      // the managed owner settles admitted work before remaining claims and
      // the Host-owned compound channels are closed. The daemon authority and
      // its lock remain externally owned throughout.
      closingExactTargets.fenceNewPreparations();
      closeBarrier = settleAll([
        ...(dashboardManagementSession === null
          ? [] : [() => dashboardManagementSession!.closeAndDrain()]),
        () => closingManaged.closeAndDrain(),
        () => closingExactTargets.close(),
        () => options.recoveredH2Spool.close(),
        () => options.hostState.close(),
      ]);
      return closeBarrier;
    };
    const handle = Object.create(null) as RelayV2HostCanonicalProductionComposition;
    Object.defineProperties(handle, {
      inspect: { value: () => managed!.inspect(), enumerable: true },
      start: { value: (input: Readonly<RelayV2HostManagedConnectorStartInput>) => managed!.start(input), enumerable: true },
      requestReauthentication: {
        value: (input: Readonly<RelayV2HostManagedConnectorReauthenticationInput>) => (
          managed!.requestReauthentication(input)
        ),
        enumerable: true,
      },
      stopAndDrain: {
        value: (input: Readonly<RelayV2HostManagedConnectorStopInput>) => managed!.stopAndDrain(input),
        enumerable: true,
      },
      closeAndDrain: { value: close, enumerable: true },
    });
    if (dashboardManagementSession !== null) {
      Object.defineProperty(handle, "runDashboardManagement", {
        value: () => dashboardManagementSession!.run(),
        enumerable: true,
      });
    }
    return Object.freeze(handle);
  } catch (error) {
    // Input and lexical-owner mismatches return null before durable recovery.
    // Once read/recovery has begun, an exception is authoritative corruption,
    // I/O, or recovery failure and must remain distinguishable from NO-GO.
    // Before a candidate is returned the caller still owns H0/the spool, so
    // there is nothing local to roll back and those owners must stay open.
    if (!claimedOwners) throw error;
    exactTargets?.fenceNewPreparations();
    const rollback = [
      ...(dashboardManagementSession === null
        ? [] : [() => dashboardManagementSession!.closeAndDrain()]),
      ...(managed !== null
        ? [() => managed!.closeAndDrain()]
        : terminalManager === null ? [] : [() => terminalManager!.shutdown()]),
      ...(managed === null && optionalExtension !== null
        ? [() => optionalExtension!.closeAndDrain()]
        : []),
      ...(exactTargets === null ? [] : [() => exactTargets!.close()]),
      () => options.recoveredH2Spool.close(),
      () => options.hostState.close(),
    ];
    try {
      await settleAll(rollback);
    } catch {}
    throw error;
  }
}
