import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import {
  createServer as createNodeHttpsServer,
  type Server as NodeHttpsServer,
} from "node:https";
import type { Socket } from "node:net";
import { types as nodeUtilTypes } from "node:util";

import {
  createActivatedRelayV2BrokerServerRuntime,
  createRelayV2BrokerProductionComposition,
} from "./brokerServerRuntime.js";
import {
  startRelayV2BrokerPublicHttpsServerLifecycle,
  type RelayV2BrokerPublicHttpsServerHandle,
} from "./brokerPublicHttpsServer.js";
import {
  RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS,
  type RelayV2BrokerCredentialAuthority,
  type RelayV2BrokerCredentialAuthorityGenesis,
} from "./brokerCredentialAuthority.js";
import type { RelayV2LiveAuthorizationFencePort } from "./brokerCore.js";
import type { RelayV2IssuerKeyring } from "./issuer.js";
import type {
  RelayV2ExternalContinuityAuthorityAttemptProvider,
  RelayV2ExternalContinuityAuthorityConfig,
} from "./externalContinuityAuthorityConfig.js";
import { isRelayV2AuthIdentifier } from "./token.js";
import {
  type RelayV2BrokerCredentialStateStoreNativeLoader,
} from "./brokerCredentialStateStoreLoader.js";
import type { RelayV2BrokerTransportCloseDeadlineScheduler } from "./brokerTransportCloseCoordinator.js";
import type {
  RelayV2BrokerServerAgentCapabilityReadinessReceipt,
  RelayV2BrokerServerComposition,
} from "../broker/server.js";

/**
 * Explicit, default-off Relay v2 broker shipping root.
 *
 * Production profiles carry only non-sensitive references (listen address,
 * public issuer root and exact client relay endpoint, TLS/E0 reference
 * identifiers, trustedHome). Sensitive TLS/keyring material enters only
 * through the injected narrow privileged resolver; E0 auth/trust material
 * stays behind the injected attempt provider. The one alternate profile shape
 * is the exact non-production single-node policy below, which may inject a
 * canonical credential-authority opener but cannot inject native/E0 inputs.
 * This root never exposes the admin seam on the public route. Omission of the
 * narrow optional Agent readiness receipt remains
 * default-off; when explicitly injected, the receipt can affect only that
 * extension and cannot complete base-v2 readiness. Listener success is not
 * Relay v2 production readiness; native `qualifiedRecords=[]` and qualified
 * E0/TLS deployment evidence still gate production availability.
 */

export interface RelayV2BrokerShippingTlsReferences {
  readonly keyReference: string;
  readonly certificateReference: string;
  readonly trustReference?: string;
}

interface RelayV2BrokerShippingProfileBase {
  readonly configVersion: 1;
  readonly listen: Readonly<{ host: string; port: number }>;
  readonly issuerUrl: string;
  readonly relayUrl: string;
  readonly trustedHome: string;
  readonly tls: RelayV2BrokerShippingTlsReferences;
  readonly issuerKeyringReference: string;
}

export const RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY =
  "non-production-single-node-co-located-sqlite-v1" as const;

export type RelayV2BrokerShippingProfile = RelayV2BrokerShippingProfileBase & (
  | {
      readonly externalContinuity: RelayV2ExternalContinuityAuthorityConfig;
      readonly nonProductionCredentialPolicy?: never;
    }
  | {
      readonly externalContinuity?: never;
      readonly nonProductionCredentialPolicy:
        typeof RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY;
    }
);

export interface RelayV2BrokerShippingTlsMaterial {
  readonly key: string | Buffer | Uint8Array;
  readonly cert: string | Buffer | Uint8Array;
  readonly ca?: string | Buffer | Uint8Array | readonly (string | Buffer | Uint8Array)[];
  dispose(): void;
}

/** Narrow synchronous privileged port; async returns are never assimilated. */
export interface RelayV2BrokerShippingPrivilegedResolver {
  resolveTlsMaterial(
    references: RelayV2BrokerShippingTlsReferences,
  ): RelayV2BrokerShippingTlsMaterial;
  resolveIssuerKeyring(reference: string): RelayV2IssuerKeyring;
}

interface RelayV2BrokerShippingDeploymentInputsBase {
  readonly privilegedResolver: RelayV2BrokerShippingPrivilegedResolver;
  /** Omission keeps agent.transcript-lifecycle.v1 default-off. */
  readonly agentTranscriptLifecycleReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  /** Omission keeps agent.chat.v2 default-off. */
  readonly agentChatReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  /** Omission keeps lark.bindings.v2 default-off. */
  readonly larkBindingsReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  readonly closeDeadlineScheduler?: RelayV2BrokerTransportCloseDeadlineScheduler;
  readonly createHttpsServer?: (options: Readonly<{
    key: string | Buffer | Uint8Array;
    cert: string | Buffer | Uint8Array;
    ca?: string | Buffer | Uint8Array | readonly (string | Buffer | Uint8Array)[];
  }>) => NodeHttpsServer;
}

export type RelayV2BrokerShippingDeploymentInputs =
  RelayV2BrokerShippingDeploymentInputsBase & (
    | {
        readonly externalContinuityAttemptProvider:
          RelayV2ExternalContinuityAuthorityAttemptProvider;
        readonly nativeLoader: RelayV2BrokerCredentialStateStoreNativeLoader;
        readonly nonProductionCredentialAuthorityOpener?: never;
      }
    | {
        readonly externalContinuityAttemptProvider?: never;
        readonly nativeLoader?: never;
        readonly nonProductionCredentialAuthorityOpener:
          RelayV2BrokerShippingNonProductionCredentialAuthorityOpener;
      }
  );

export type RelayV2BrokerShippingNonProductionCredentialAuthorityOpener = (
  input: Readonly<{
    liveAuthorizationFence: RelayV2LiveAuthorizationFencePort;
    genesis: RelayV2BrokerCredentialAuthorityGenesis;
  }>,
) => Promise<RelayV2BrokerCredentialAuthority>;

/** Caller-owned restricted delivery target (for example a 0600 file write). */
export type RelayV2BrokerAdminSecretSink = (secret: string) => void;

export interface RelayV2BrokerLocalAdminPort {
  createHostBootstrap(
    input: Readonly<{ expiresInMs?: number }>,
    sink: RelayV2BrokerAdminSecretSink,
  ): Promise<Readonly<{ expiresAtMs: number }>>;
  publishHostBootstrap(
    input: Readonly<{ correlation: string; expiresInMs?: number }>,
    sink: RelayV2BrokerAdminSecretSink,
  ): Promise<Readonly<{
    expiresAtMs: number;
    alreadyAcknowledged: boolean;
  }>>;
  rotateIssuerKey(
    input: Readonly<{ kid: string; secretBase64url?: string }>,
  ): Promise<Readonly<{ kid: string }>>;
  removeIssuerKey(
    input: Readonly<{ kid: string; emergency?: boolean }>,
  ): Promise<Readonly<{ kid: string }>>;
  rotateReplayKey(
    input: Readonly<{ rotationId: string }>,
  ): Promise<Readonly<{ rotationId: string; replayKeyId: string }>>;
}

export interface RelayV2BrokerShippingRootHandle {
  readonly host: string;
  readonly port: number;
  readonly issuerUrl: string;
  readonly relayUrl: string;
  /** Local in-process admin only; never attached to any listener or route. */
  readonly admin: RelayV2BrokerLocalAdminPort;
  shutdown(): Promise<void>;
}

const PROFILE_INVALID = "Relay v2 broker shipping profile is invalid";
const PROFILE_UNAVAILABLE = "Relay v2 broker shipping profile is unavailable";
const PROFILE_UNSUPPORTED = "Relay v2 broker shipping profile is unsupported on this platform";
const INPUTS_INVALID = "Relay v2 broker shipping deployment inputs are invalid";
const INPUTS_UNAVAILABLE = "Relay v2 broker shipping deployment inputs are unavailable";
const TLS_MATERIAL_FAILED = "Relay v2 broker shipping TLS material resolution failed";
const TLS_MATERIAL_CLEANUP_FAILED = "Relay v2 broker shipping TLS material cleanup failed";
const KEYRING_FAILED = "Relay v2 broker shipping issuer keyring resolution failed";
const TLS_SERVER_FAILED = "Relay v2 broker shipping TLS listener creation failed";
const ADMIN_INPUT_INVALID = "Relay v2 broker shipping admin input is invalid";
const ADMIN_UNAVAILABLE = "Relay v2 broker shipping admin is unavailable";
const ADMIN_SINK_FAILED = "Relay v2 broker shipping admin secret sink failed";
const ADMIN_SURFACE_MISSING = "Relay v2 broker credential authority admin surface is unavailable";
const PROFILE_FILE_MAX_BYTES = 16_384;

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

function captureOwnDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  const allowed: readonly string[] = [...required, ...optional];
  if (
    keys.some((key) => typeof key !== "string")
    || (keys as string[]).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))
  ) return null;
  const captured: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      !Object.hasOwn(descriptor, "value")
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) return null;
    captured[key] = descriptor.value;
  }
  return captured;
}

function boundedReference(value: unknown, maxBytes = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !value.includes("\0");
}

function captureEndpointUrl(
  value: unknown,
  protocol: "https:" | "wss:",
  pathname: "/" | "/client",
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== protocol
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname !== pathname
  ) return null;
  return parsed.toString();
}

function isThenable(value: unknown): boolean {
  if (value instanceof Promise) return true;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return Object.hasOwn(value, "then");
}

type CapturedProfile = Readonly<{
  configVersion: 1;
  listen: Readonly<{ host: string; port: number }>;
  issuerUrl: string;
  relayUrl: string;
  trustedHome: string;
  tls: RelayV2BrokerShippingTlsReferences;
  issuerKeyringReference: string;
} & (
  | {
      externalContinuity: RelayV2ExternalContinuityAuthorityConfig;
      nonProductionCredentialPolicy?: never;
    }
  | {
      externalContinuity?: never;
      nonProductionCredentialPolicy:
        typeof RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY;
    }
)>;

function captureProfile(value: unknown): CapturedProfile {
  const record = captureOwnDataRecord(value, [
    "configVersion",
    "listen",
    "issuerUrl",
    "relayUrl",
    "trustedHome",
    "tls",
    "issuerKeyringReference",
  ], ["externalContinuity", "nonProductionCredentialPolicy"]);
  if (record === null || record.configVersion !== 1) throw new TypeError(PROFILE_INVALID);
  const listen = captureOwnDataRecord(record.listen, ["host", "port"]);
  const issuerUrl = captureEndpointUrl(record.issuerUrl, "https:", "/");
  const relayUrl = captureEndpointUrl(record.relayUrl, "wss:", "/client");
  const tls = captureOwnDataRecord(record.tls, [
    "keyReference",
    "certificateReference",
  ], ["trustReference"]);
  if (
    listen === null
    || !boundedReference(listen.host, 255)
    || !Number.isInteger(listen.port)
    || (listen.port as number) < 0
    || (listen.port as number) > 65_535
    || issuerUrl === null
    || relayUrl === null
    || tls === null
    || !boundedReference(tls.keyReference)
    || !boundedReference(tls.certificateReference)
    || (tls.trustReference !== undefined && !boundedReference(tls.trustReference))
    || typeof record.trustedHome !== "string"
    || record.trustedHome.length === 0
    || !record.trustedHome.startsWith("/")
    || record.trustedHome.includes("\0")
    || !boundedReference(record.issuerKeyringReference)
  ) throw new TypeError(PROFILE_INVALID);
  const productionExternalContinuity = record.externalContinuity !== undefined
    && record.externalContinuity !== null
    && typeof record.externalContinuity === "object"
    && !rejectedProxy(record.externalContinuity)
    && record.nonProductionCredentialPolicy === undefined;
  const nonProductionSingleNode =
    record.externalContinuity === undefined
    && record.nonProductionCredentialPolicy
      === RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY;
  if (!productionExternalContinuity && !nonProductionSingleNode) {
    throw new TypeError(PROFILE_INVALID);
  }
  return Object.freeze({
    configVersion: 1,
    listen: Object.freeze({ host: listen.host, port: listen.port as number }),
    issuerUrl,
    relayUrl,
    trustedHome: record.trustedHome,
    tls: Object.freeze(tls.trustReference === undefined
      ? {
          keyReference: tls.keyReference,
          certificateReference: tls.certificateReference,
        }
      : {
          keyReference: tls.keyReference,
          certificateReference: tls.certificateReference,
          trustReference: tls.trustReference,
        }),
    issuerKeyringReference: record.issuerKeyringReference,
    ...(productionExternalContinuity
      ? {
          externalContinuity:
            record.externalContinuity as RelayV2ExternalContinuityAuthorityConfig,
        }
      : {
          nonProductionCredentialPolicy:
            RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY,
        }),
  } as CapturedProfile);
}

type CapturedDeploymentInputs = Readonly<{
  resolverReceiver: object;
  resolveTlsMaterial: RelayV2BrokerShippingPrivilegedResolver["resolveTlsMaterial"];
  resolveIssuerKeyring: RelayV2BrokerShippingPrivilegedResolver["resolveIssuerKeyring"];
  externalContinuityAttemptProvider?: RelayV2ExternalContinuityAuthorityAttemptProvider;
  nativeLoader?: RelayV2BrokerCredentialStateStoreNativeLoader;
  agentTranscriptLifecycleReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  agentChatReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  larkBindingsReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  nonProductionCredentialAuthorityOpener?:
    RelayV2BrokerShippingNonProductionCredentialAuthorityOpener;
  closeDeadlineScheduler?: RelayV2BrokerTransportCloseDeadlineScheduler;
  createHttpsServer: NonNullable<RelayV2BrokerShippingDeploymentInputs["createHttpsServer"]>;
}>;

/**
 * Captures the two privileged methods as own-data callables while keeping the
 * resolver itself as their original receiver; a deployment resolver may carry
 * its own state on sibling properties, so extra own keys are left untouched.
 */
function capturePrivilegedResolver(value: unknown): Readonly<{
  receiver: object;
  resolveTlsMaterial: RelayV2BrokerShippingPrivilegedResolver["resolveTlsMaterial"];
  resolveIssuerKeyring: RelayV2BrokerShippingPrivilegedResolver["resolveIssuerKeyring"];
}> {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) {
    throw new TypeError(INPUTS_INVALID);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(INPUTS_INVALID);
  }
  for (const name of ["resolveTlsMaterial", "resolveIssuerKeyring"] as const) {
    const descriptor = descriptors[name];
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function"
      || rejectedProxy(descriptor.value)
    ) throw new TypeError(INPUTS_INVALID);
  }
  return Object.freeze({
    receiver: value,
    resolveTlsMaterial: descriptors.resolveTlsMaterial.value as RelayV2BrokerShippingPrivilegedResolver["resolveTlsMaterial"],
    resolveIssuerKeyring: descriptors.resolveIssuerKeyring.value as RelayV2BrokerShippingPrivilegedResolver["resolveIssuerKeyring"],
  });
}

/**
 * Snapshots the exact two-field receipt before any listener can start while
 * retaining the deployment owner's receiver for its one-way loss subscription.
 * The canonical Broker runtime remains the only consumer and capability owner.
 */
function captureAgentTranscriptLifecycleReadiness(
  value: unknown,
): RelayV2BrokerServerAgentCapabilityReadinessReceipt {
  const record = captureOwnDataRecord(value, ["status", "subscribeLoss"]);
  if (
    record === null
    || record.status !== "ready"
    || typeof record.subscribeLoss !== "function"
    || rejectedProxy(record.subscribeLoss)
  ) throw new TypeError(INPUTS_INVALID);
  const receiver = value as object;
  const subscribeLoss = record.subscribeLoss;
  return Object.freeze({
    status: "ready" as const,
    subscribeLoss(onLoss: () => void): () => void {
      return Reflect.apply(subscribeLoss, receiver, [onLoss]) as () => void;
    },
  });
}

function captureDeploymentInputs(
  value: unknown,
  nonProduction: boolean,
): CapturedDeploymentInputs {
  const record = captureOwnDataRecord(value, [
    "privilegedResolver",
  ], [
    "externalContinuityAttemptProvider",
    "nativeLoader",
    "nonProductionCredentialAuthorityOpener",
    "agentTranscriptLifecycleReadiness",
    "agentChatReadiness",
    "larkBindingsReadiness",
    "closeDeadlineScheduler",
    "createHttpsServer",
  ]);
  const productionInputs = !nonProduction
    && record?.externalContinuityAttemptProvider !== null
    && typeof record?.externalContinuityAttemptProvider === "object"
    && !rejectedProxy(record.externalContinuityAttemptProvider)
    && record.nativeLoader !== null
    && typeof record.nativeLoader === "object"
    && !rejectedProxy(record.nativeLoader)
    && record.nonProductionCredentialAuthorityOpener === undefined;
  const nonProductionInputs = nonProduction
    && record?.externalContinuityAttemptProvider === undefined
    && record?.nativeLoader === undefined
    && typeof record?.nonProductionCredentialAuthorityOpener === "function"
    && !rejectedProxy(record.nonProductionCredentialAuthorityOpener);
  if (
    record === null
    || (!productionInputs && !nonProductionInputs)
    || (record.closeDeadlineScheduler !== undefined && (record.closeDeadlineScheduler === null
      || typeof record.closeDeadlineScheduler !== "object"
      || rejectedProxy(record.closeDeadlineScheduler)))
    || (record.createHttpsServer !== undefined
      && (typeof record.createHttpsServer !== "function"
        || rejectedProxy(record.createHttpsServer)))
  ) throw new TypeError(INPUTS_INVALID);
  const resolver = capturePrivilegedResolver(record.privilegedResolver);
  const agentTranscriptLifecycleReadiness =
    record.agentTranscriptLifecycleReadiness === undefined
      ? undefined
      : captureAgentTranscriptLifecycleReadiness(
          record.agentTranscriptLifecycleReadiness,
        );
  const agentChatReadiness =
    record.agentChatReadiness === undefined
      ? undefined
      : captureAgentTranscriptLifecycleReadiness(
          record.agentChatReadiness,
        );
  const larkBindingsReadiness =
    record.larkBindingsReadiness === undefined
      ? undefined
      : captureAgentTranscriptLifecycleReadiness(
          record.larkBindingsReadiness,
        );
  const createHttpsServer = (record.createHttpsServer ?? ((options: Readonly<{
    key: string | Buffer | Uint8Array;
    cert: string | Buffer | Uint8Array;
    ca?: string | Buffer | Uint8Array | readonly (string | Buffer | Uint8Array)[];
  }>) => createNodeHttpsServer(options))) as CapturedDeploymentInputs["createHttpsServer"];
  return Object.freeze({
    resolverReceiver: resolver.receiver,
    resolveTlsMaterial: resolver.resolveTlsMaterial,
    resolveIssuerKeyring: resolver.resolveIssuerKeyring,
    ...(productionInputs
      ? {
          externalContinuityAttemptProvider:
            record.externalContinuityAttemptProvider as
              RelayV2ExternalContinuityAuthorityAttemptProvider,
          nativeLoader:
            record.nativeLoader as RelayV2BrokerCredentialStateStoreNativeLoader,
        }
      : {
          nonProductionCredentialAuthorityOpener:
            record.nonProductionCredentialAuthorityOpener as
              RelayV2BrokerShippingNonProductionCredentialAuthorityOpener,
        }),
    ...(record.closeDeadlineScheduler === undefined
      ? {}
      : { closeDeadlineScheduler: record.closeDeadlineScheduler as RelayV2BrokerTransportCloseDeadlineScheduler }),
    ...(agentTranscriptLifecycleReadiness === undefined
      ? {}
      : { agentTranscriptLifecycleReadiness }),
    ...(agentChatReadiness === undefined
      ? {}
      : { agentChatReadiness }),
    ...(larkBindingsReadiness === undefined
      ? {}
      : { larkBindingsReadiness }),
    createHttpsServer,
  });
}

function isKeyMaterial(value: unknown): value is string | Buffer | Uint8Array {
  return typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array;
}

/**
 * Captures only the material's own-data `dispose` callable plus the original
 * receiver, before any field is inspected. A thenable, foreign, proxied, or
 * accessor-shaped material fails closed without reading getters or running
 * unknown code, mirroring the E0 discard-capture policy.
 */
function captureTlsMaterialDisposal(value: unknown): Readonly<{
  receiver: object;
  dispose: () => void;
}> {
  if (isThenable(value) || value === null || typeof value !== "object" || rejectedProxy(value)) {
    throw new Error(TLS_MATERIAL_FAILED);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "dispose");
  } catch {
    descriptor = undefined;
  }
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "function"
    || rejectedProxy(descriptor.value)
  ) throw new Error(TLS_MATERIAL_FAILED);
  return Object.freeze({ receiver: value, dispose: descriptor.value as () => void });
}

function captureTlsMaterialFields(value: object): Readonly<{
  key: string | Buffer | Uint8Array;
  cert: string | Buffer | Uint8Array;
  ca?: RelayV2BrokerShippingTlsMaterial["ca"];
}> {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(TLS_MATERIAL_FAILED);
  }
  const key = descriptors.key;
  const cert = descriptors.cert;
  const ca = descriptors.ca;
  if (
    key === undefined
    || !Object.hasOwn(key, "value")
    || !isKeyMaterial(key.value)
    || cert === undefined
    || !Object.hasOwn(cert, "value")
    || !isKeyMaterial(cert.value)
  ) throw new Error(TLS_MATERIAL_FAILED);
  if (
    ca !== undefined
    && (!Object.hasOwn(ca, "value")
      || !(isKeyMaterial(ca.value)
        || (Array.isArray(ca.value) && ca.value.every(isKeyMaterial))))
  ) throw new Error(TLS_MATERIAL_FAILED);
  return Object.freeze({
    key: key.value,
    cert: cert.value,
    ...(ca === undefined ? {} : { ca: ca.value as RelayV2BrokerShippingTlsMaterial["ca"] }),
  });
}

function resolveHttpSourceKey(socket: Socket): string {
  const address = socket?.remoteAddress;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("Relay v2 broker shipping socket source is unavailable");
  }
  return address;
}

function hasAdminSurface(authority: unknown): authority is RelayV2BrokerCredentialAuthority {
  if (authority === null || typeof authority !== "object" || rejectedProxy(authority)) {
    return false;
  }
  const candidate = authority as Record<string, unknown>;
  return [
    "adminCreateHostBootstrap",
    "adminClaimHostBootstrapPublication",
    "adminAcknowledgeHostBootstrapPublication",
    "adminRotateIssuerKey",
    "adminRemoveIssuerKey",
    "adminRotateReplayKey",
  ].every((name) => typeof candidate[name] === "function");
}

function captureBootstrapInput(value: unknown): { expiresInMs?: number } {
  const record = captureOwnDataRecord(value ?? {}, [], ["expiresInMs"]);
  if (
    record === null
    || (record.expiresInMs !== undefined
      && (!Number.isSafeInteger(record.expiresInMs)
        || (record.expiresInMs as number) <= 0
        || (record.expiresInMs as number) > RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS))
  ) throw new TypeError(ADMIN_INPUT_INVALID);
  return Object.freeze(record.expiresInMs === undefined
    ? {}
    : { expiresInMs: record.expiresInMs as number });
}

function captureBootstrapPublicationInput(
  value: unknown,
): { correlation: string; expiresInMs?: number } {
  const record = captureOwnDataRecord(value, ["correlation"], ["expiresInMs"]);
  if (
    record === null
    || !isRelayV2AuthIdentifier(record.correlation)
    || (record.expiresInMs !== undefined
      && (!Number.isSafeInteger(record.expiresInMs)
        || (record.expiresInMs as number) <= 0
        || (record.expiresInMs as number)
          > RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS))
  ) throw new TypeError(ADMIN_INPUT_INVALID);
  return Object.freeze({
    correlation: record.correlation,
    ...(record.expiresInMs === undefined
      ? {}
      : { expiresInMs: record.expiresInMs as number }),
  });
}

function captureSecretSink(value: unknown): RelayV2BrokerAdminSecretSink {
  if (typeof value !== "function" || rejectedProxy(value)) {
    throw new TypeError(ADMIN_INPUT_INVALID);
  }
  return value as RelayV2BrokerAdminSecretSink;
}

function captureRotateIssuerKeyInput(
  value: unknown,
): { kid: string; secretBase64url?: string } {
  const record = captureOwnDataRecord(value, ["kid"], ["secretBase64url"]);
  if (
    record === null
    || !boundedReference(record.kid, 128)
    || (record.secretBase64url !== undefined
      && !boundedReference(record.secretBase64url, 1_024))
  ) throw new TypeError(ADMIN_INPUT_INVALID);
  return Object.freeze(record.secretBase64url === undefined
    ? { kid: record.kid }
    : { kid: record.kid, secretBase64url: record.secretBase64url });
}

function captureRemoveIssuerKeyInput(value: unknown): { kid: string; emergency?: boolean } {
  const record = captureOwnDataRecord(value, ["kid"], ["emergency"]);
  if (
    record === null
    || !boundedReference(record.kid, 128)
    || (record.emergency !== undefined && typeof record.emergency !== "boolean")
  ) throw new TypeError(ADMIN_INPUT_INVALID);
  return Object.freeze(record.emergency === undefined
    ? { kid: record.kid }
    : { kid: record.kid, emergency: record.emergency as boolean });
}

function captureRotationIdInput(value: unknown): { rotationId: string } {
  const record = captureOwnDataRecord(value, ["rotationId"]);
  if (record === null || !boundedReference(record.rotationId, 128)) {
    throw new TypeError(ADMIN_INPUT_INVALID);
  }
  return Object.freeze({ rotationId: record.rotationId });
}

/**
 * Start the shipping root from a reference-only profile and injected
 * deployment inputs. The selected production native/E0 chain or the one
 * explicit non-production authority opener fully opens before the listener
 * binds through the existing public HTTPS lifecycle root; startup failure
 * rolls back in reverse order and fails closed.
 */
export async function startRelayV2BrokerShippingRoot(
  profileInput: unknown,
  deploymentInputs: unknown,
): Promise<RelayV2BrokerShippingRootHandle> {
  const profile = captureProfile(profileInput);
  const nonProduction =
    profile.nonProductionCredentialPolicy
      === RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY;
  const inputs = captureDeploymentInputs(deploymentInputs, nonProduction);

  let keyring: unknown;
  try {
    keyring = Reflect.apply(inputs.resolveIssuerKeyring, inputs.resolverReceiver, [
      profile.issuerKeyringReference,
    ]);
  } catch {
    throw new Error(KEYRING_FAILED);
  }
  if (isThenable(keyring) || keyring === null || typeof keyring !== "object") {
    throw new Error(KEYRING_FAILED);
  }

  const genesis = Object.freeze({
    issuerKeyring: keyring as RelayV2IssuerKeyring,
    issuerUrl: profile.issuerUrl,
    relayUrl: profile.relayUrl,
  });
  // Production stays on the frozen E0/native opener. The only alternate
  // policy is the explicit non-production single-node lane, whose opener gets
  // the exact resolved keyring/genesis and live-fence input but never an E0
  // label, provider, or production qualification path.
  const composition: RelayV2BrokerServerComposition = nonProduction
    ? Object.freeze({
        openCredentialAuthority: (input: Readonly<{
          liveAuthorizationFence: RelayV2LiveAuthorizationFencePort;
        }>) =>
          inputs.nonProductionCredentialAuthorityOpener!(
            Object.freeze({
              liveAuthorizationFence: input.liveAuthorizationFence,
              genesis,
            }),
          ),
        resolveHttpSourceKey,
        ...(inputs.closeDeadlineScheduler === undefined
          ? {}
          : { closeDeadlineScheduler: inputs.closeDeadlineScheduler }),
        ...(inputs.agentTranscriptLifecycleReadiness === undefined
          ? {}
          : {
              agentTranscriptLifecycleReadiness:
                inputs.agentTranscriptLifecycleReadiness,
            }),
        ...(inputs.agentChatReadiness === undefined
          ? {}
          : {
              agentChatReadiness:
                inputs.agentChatReadiness,
            }),
        ...(inputs.larkBindingsReadiness === undefined
          ? {}
          : {
              larkBindingsReadiness:
                inputs.larkBindingsReadiness,
            }),
      })
    : createRelayV2BrokerProductionComposition({
        trustedHome: profile.trustedHome,
        nativeLoader: inputs.nativeLoader!,
        externalContinuityConfig: profile.externalContinuity!,
        externalContinuityAttemptProvider:
          inputs.externalContinuityAttemptProvider!,
        genesis,
        resolveHttpSourceKey,
        ...(inputs.closeDeadlineScheduler === undefined
          ? {}
          : { closeDeadlineScheduler: inputs.closeDeadlineScheduler }),
        ...(inputs.agentTranscriptLifecycleReadiness === undefined
          ? {}
          : {
              agentTranscriptLifecycleReadiness:
                inputs.agentTranscriptLifecycleReadiness,
            }),
        ...(inputs.agentChatReadiness === undefined
          ? {}
          : {
              agentChatReadiness:
                inputs.agentChatReadiness,
            }),
        ...(inputs.larkBindingsReadiness === undefined
          ? {}
          : {
              larkBindingsReadiness:
                inputs.larkBindingsReadiness,
            }),
      });

  let acquiredTlsMaterial: unknown;
  try {
    acquiredTlsMaterial = Reflect.apply(inputs.resolveTlsMaterial, inputs.resolverReceiver, [
      profile.tls,
    ]);
  } catch {
    throw new Error(TLS_MATERIAL_FAILED);
  }
  // Capture a safely callable dispose (with the original receiver) before any
  // key/cert/ca validation, so every later failure path can release exactly
  // once; a disposal failure surfaces only as a fixed redacted cleanup error.
  const tlsDisposal = captureTlsMaterialDisposal(acquiredTlsMaterial);
  let materialDisposed = false;
  const disposeMaterial = (): void => {
    if (materialDisposed) return;
    materialDisposed = true;
    try {
      Reflect.apply(tlsDisposal.dispose, tlsDisposal.receiver, []);
    } catch {
      throw new Error(TLS_MATERIAL_CLEANUP_FAILED);
    }
  };

  let tlsFields: Readonly<{
    key: string | Buffer | Uint8Array;
    cert: string | Buffer | Uint8Array;
    ca?: RelayV2BrokerShippingTlsMaterial["ca"];
  }>;
  try {
    tlsFields = captureTlsMaterialFields(tlsDisposal.receiver);
  } catch {
    disposeMaterial();
    throw new Error(TLS_MATERIAL_FAILED);
  }

  let server: NodeHttpsServer;
  try {
    server = Reflect.apply(inputs.createHttpsServer, undefined, [{
      key: tlsFields.key,
      cert: tlsFields.cert,
      ...(tlsFields.ca === undefined ? {} : { ca: tlsFields.ca }),
    }]);
  } catch {
    disposeMaterial();
    throw new Error(TLS_SERVER_FAILED);
  }
  // node:https copies the key/cert into the SecureContext at construction, so
  // the JS-held material is released exactly once immediately afterwards.
  disposeMaterial();

  let capturedAuthority: RelayV2BrokerCredentialAuthority | null = null;
  let closing = false;
  const inFlightAdmin = new Set<Promise<unknown>>();

  const wrappedComposition: RelayV2BrokerServerComposition = Object.freeze({
    openCredentialAuthority: async (input) => {
      const authority = await composition.openCredentialAuthority(input);
      if (!hasAdminSurface(authority)) {
        try {
          await authority.close();
        } catch {
          // The activation failure below stays the surfaced outcome.
        }
        throw new Error(ADMIN_SURFACE_MISSING);
      }
      capturedAuthority = authority;
      return authority;
    },
    resolveHttpSourceKey: (socket) => composition.resolveHttpSourceKey(socket),
    ...(composition.closeDeadlineScheduler === undefined
      ? {}
      : { closeDeadlineScheduler: composition.closeDeadlineScheduler }),
    ...(composition.agentTranscriptLifecycleReadiness === undefined
      ? {}
      : {
          agentTranscriptLifecycleReadiness:
            composition.agentTranscriptLifecycleReadiness,
        }),
    ...(composition.agentChatReadiness === undefined
      ? {}
      : {
          agentChatReadiness:
            composition.agentChatReadiness,
        }),
    ...(composition.larkBindingsReadiness === undefined
      ? {}
      : {
          larkBindingsReadiness:
            composition.larkBindingsReadiness,
        }),
  });

  let serverHandle: RelayV2BrokerPublicHttpsServerHandle;
  try {
    serverHandle = await startRelayV2BrokerPublicHttpsServerLifecycle(
      server,
      { host: profile.listen.host, port: profile.listen.port },
      () => createActivatedRelayV2BrokerServerRuntime(wrappedComposition),
    );
  } catch (error) {
    closing = true;
    capturedAuthority = null;
    throw error;
  }

  const requireAuthority = (): RelayV2BrokerCredentialAuthority => {
    if (closing || capturedAuthority === null) throw new Error(ADMIN_UNAVAILABLE);
    return capturedAuthority;
  };

  const runAdmin = async <T>(
    operation: (authority: RelayV2BrokerCredentialAuthority) => Promise<T>,
  ): Promise<T> => {
    const authority = requireAuthority();
    const tracked = operation(authority);
    inFlightAdmin.add(tracked);
    try {
      return await tracked;
    } finally {
      inFlightAdmin.delete(tracked);
    }
  };

  const admin: RelayV2BrokerLocalAdminPort = Object.freeze({
    async createHostBootstrap(input, sink) {
      const capturedInput = captureBootstrapInput(input);
      const capturedSink = captureSecretSink(sink);
      const created = await runAdmin((authority) => authority.adminCreateHostBootstrap(
        capturedInput,
      ));
      const token = created?.bootstrapToken;
      const expiresAtMs = created?.expiresAtMs;
      if (typeof token !== "string" || !Number.isSafeInteger(expiresAtMs)) {
        throw new Error(ADMIN_UNAVAILABLE);
      }
      try {
        const delivered: unknown = Reflect.apply(capturedSink, undefined, [token]);
        if (isThenable(delivered)) throw new Error("sink must deliver synchronously");
      } catch {
        throw new Error(ADMIN_SINK_FAILED);
      }
      return Object.freeze({ expiresAtMs: expiresAtMs as number });
    },
    async publishHostBootstrap(input, sink) {
      const capturedInput = captureBootstrapPublicationInput(input);
      const capturedSink = captureSecretSink(sink);
      return runAdmin(async (authority) => {
        const claim = await authority.adminClaimHostBootstrapPublication(
          capturedInput,
        );
        if (
          claim?.status === "acknowledged"
          && Number.isSafeInteger(claim.expiresAtMs)
        ) {
          return Object.freeze({
            expiresAtMs: claim.expiresAtMs,
            alreadyAcknowledged: true,
          });
        }
        if (
          claim?.status !== "pending"
          || typeof claim.bootstrapToken !== "string"
          || !Number.isSafeInteger(claim.expiresAtMs)
          || claim.receipt === null
          || typeof claim.receipt !== "object"
        ) throw new Error(ADMIN_UNAVAILABLE);
        try {
          const delivered: unknown = Reflect.apply(
            capturedSink,
            undefined,
            [claim.bootstrapToken],
          );
          if (isThenable(delivered)) {
            throw new Error("sink must deliver synchronously");
          }
        } catch {
          throw new Error(ADMIN_SINK_FAILED);
        }
        const acknowledged =
          await authority.adminAcknowledgeHostBootstrapPublication(
            claim.receipt,
          );
        if (acknowledged?.expiresAtMs !== claim.expiresAtMs) {
          throw new Error(ADMIN_UNAVAILABLE);
        }
        return Object.freeze({
          expiresAtMs: claim.expiresAtMs,
          alreadyAcknowledged: false,
        });
      });
    },
    rotateIssuerKey: (input) => runAdmin((authority) => authority.adminRotateIssuerKey(
      captureRotateIssuerKeyInput(input),
    )),
    removeIssuerKey: (input) => runAdmin((authority) => authority.adminRemoveIssuerKey(
      captureRemoveIssuerKeyInput(input),
    )),
    rotateReplayKey: (input) => runAdmin((authority) => authority.adminRotateReplayKey(
      captureRotationIdInput(input),
    )),
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    // Synchronously fence public HTTP/Upgrade admission first, then admin
    // admission; only afterwards does any drain or close begin.
    serverHandle.beginShutdown();
    closing = true;
    capturedAuthority = null;
    shutdownPromise = (async () => {
      // Drain in-flight admin mutations before the credential store may close,
      // then let the public lifecycle root drain public HTTP/WSS in-flight and
      // close the runtime, credential store, and listener.
      await Promise.allSettled([...inFlightAdmin]);
      await serverHandle.shutdown();
    })();
    return shutdownPromise;
  };

  return Object.freeze({
    host: serverHandle.host,
    port: serverHandle.port,
    issuerUrl: profile.issuerUrl,
    relayUrl: profile.relayUrl,
    admin,
    shutdown,
  });
}

/**
 * Narrow profile reader for the single trusted deployment source owner: reads
 * and validates the reference-only shipping profile file without resolving any
 * material. It shares the exact private reader used by the profile-file entry.
 */
export function readRelayV2BrokerShippingProfile(
  profilePath: string,
): RelayV2BrokerShippingProfile {
  return readRelayV2BrokerShippingProfileFile(profilePath);
}

function profileReaderEuid(): bigint {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
    || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(PROFILE_UNSUPPORTED);
  }
  return BigInt(process.geteuid());
}

function assertProfileFile(information: BigIntStats, euid: bigint): void {
  if (!information.isFile()
    || information.isSymbolicLink()
    || information.uid !== euid
    || Number(information.mode & 0o7777n) !== 0o600
    || information.nlink !== 1n
    || information.size <= 0n
    || information.size > BigInt(PROFILE_FILE_MAX_BYTES)) {
    throw new Error(PROFILE_UNAVAILABLE);
  }
}

/**
 * Fd-bound reader for the endpoint/reference-binding profile: platform gate,
 * lstat ownership checks, O_RDONLY|O_NOFOLLOW open, fstat re-check plus
 * dev/ino/size identity against the lstat, an exact-size bounded read, a
 * post-read fstat recheck, and an explicit main close (a close failure is
 * surfaced as unavailable, never swallowed). Every stat/IO/ownership failure
 * maps to the fixed redacted unavailable message; no path or errno leaks.
 */
function readRelayV2BrokerShippingProfileFile(profilePath: string): CapturedProfile {
  const euid = profileReaderEuid();
  if (!boundedReference(profilePath, 4_096)) throw new Error(PROFILE_UNAVAILABLE);
  let text: string;
  let descriptor = -1;
  try {
    const before = lstatSync(profilePath, { bigint: true });
    assertProfileFile(before, euid);
    descriptor = openSync(profilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertProfileFile(opened, euid);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(PROFILE_UNAVAILABLE);
    }
    const size = Number(opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read <= 0) throw new Error(PROFILE_UNAVAILABLE);
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(PROFILE_UNAVAILABLE);
    }
    closeSync(descriptor);
    descriptor = -1;
    text = bytes.toString("utf8");
  } catch {
    throw new Error(PROFILE_UNAVAILABLE);
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
  if (Buffer.byteLength(text, "utf8") > PROFILE_FILE_MAX_BYTES) {
    throw new Error(PROFILE_UNAVAILABLE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(PROFILE_INVALID);
  }
  return captureProfile(parsed);
}

/**
 * Deployment-injected entry: reads and validates the reference-only profile
 * file, then requires caller-provided inputs. Without injected inputs this
 * fails closed before any listener. The CLI
 * does not call this entry; its explicit `--v2-profile` selection activates
 * only the single trusted deployment source owner.
 */
export async function startRelayV2BrokerShippingFromProfileFile(
  profilePath: string,
  deploymentInputs?: RelayV2BrokerShippingDeploymentInputs,
): Promise<RelayV2BrokerShippingRootHandle> {
  const profile = readRelayV2BrokerShippingProfileFile(profilePath);
  if (deploymentInputs === undefined) {
    throw new Error(INPUTS_UNAVAILABLE);
  }
  return startRelayV2BrokerShippingRoot(profile, deploymentInputs);
}
