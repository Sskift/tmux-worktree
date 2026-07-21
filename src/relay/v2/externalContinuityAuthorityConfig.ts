import { types as nodeUtilTypes } from "node:util";

import {
  RELAY_V2_CONTINUITY_MAX_OPERATION_TIMEOUT_MS,
  RELAY_V2_CONTINUITY_MAX_PENDING_OPERATIONS,
  type RelayV2ContinuityAnchorOptions,
  type RelayV2ContinuityAnchorCasRequest,
  type RelayV2ContinuityAnchorReadRequest,
  type RelayV2MonotonicCasAuthority,
} from "./continuityAnchor.js";
import {
  RelayV2ExternalContinuityAuthorityHttpsAdapter,
  RelayV2ExternalContinuityHttpsAdapterError,
  type RelayV2ExternalContinuityHttpsTransport,
  type RelayV2ExternalContinuityHttpsTransportExchange,
  type RelayV2ExternalContinuityHttpsTransportRequest,
  type RelayV2ExternalContinuityNamespace,
} from "./externalContinuityAuthorityHttpsAdapter.js";

const CONFIG_VERSION = 1 as const;
const MAX_ENDPOINT_BYTES = 2_048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const CONFIG_KEYS = [
  "configVersion",
  "endpoint",
  "securityDomainId",
  "authenticationMode",
  "credentialReference",
  "tlsTrustReference",
  "operationTimeoutMs",
  "maxPendingOperations",
  "namespaceBindings",
] as const;
const NAMESPACE_BINDING_KEYS = ["namespace", "ownerBinding", "anchorId"] as const;
const PROVIDER_KEYS = ["resolveAttempt"] as const;
const RESOLVED_ATTEMPT_KEYS = ["authenticationHeaders", "transport"] as const;
const TRANSPORT_KEYS = ["start", "discard"] as const;
const RESOLUTION_REQUEST_KEYS = [
  "endpoint",
  "authenticationMode",
  "credentialReference",
  "tlsTrustReference",
] as const;

export type RelayV2ExternalContinuityAuthenticationMode =
  | "mutual_tls"
  | "workload_identity";

export interface RelayV2ExternalContinuityAuthorityNamespaceConfig {
  readonly namespace: RelayV2ExternalContinuityNamespace;
  readonly ownerBinding: string;
  readonly anchorId: string;
}

export interface RelayV2ExternalContinuityAuthorityConfig {
  readonly configVersion: typeof CONFIG_VERSION;
  readonly endpoint: string;
  readonly securityDomainId: string;
  readonly authenticationMode: RelayV2ExternalContinuityAuthenticationMode;
  readonly credentialReference: string;
  readonly tlsTrustReference: string;
  readonly operationTimeoutMs: number;
  readonly maxPendingOperations: number;
  readonly namespaceBindings: readonly RelayV2ExternalContinuityAuthorityNamespaceConfig[];
}

export interface RelayV2ExternalContinuityAuthorityAttemptResolutionRequest {
  readonly endpoint: string;
  readonly authenticationMode: RelayV2ExternalContinuityAuthenticationMode;
  readonly credentialReference: string;
  readonly tlsTrustReference: string;
}

export interface RelayV2ExternalContinuityAuthorityResolvedAttempt {
  /** Auth material is not persisted or public and is passed only to the adapter for this attempt. */
  readonly authenticationHeaders: () => Readonly<Record<string, string>>;
  /** Already bound by the provider to the exact endpoint identity and trust reference above. */
  readonly transport: RelayV2ExternalContinuityAuthorityResolvedTransport;
}

export interface RelayV2ExternalContinuityAuthorityResolvedTransport
extends RelayV2ExternalContinuityHttpsTransport {
  /** Releases a resolved secret/trust-bound transport that was not started. */
  discard(): void;
}

export interface RelayV2ExternalContinuityAuthorityAttemptProvider {
  resolveAttempt(
    request: RelayV2ExternalContinuityAuthorityAttemptResolutionRequest,
  ): RelayV2ExternalContinuityAuthorityResolvedAttempt;
}

export interface RelayV2ExternalContinuityAuthorityBoundNamespace {
  readonly namespace: RelayV2ExternalContinuityNamespace;
  /** Local provisioning identity. It is never passed to the HTTPS adapter. */
  readonly ownerBinding: string;
  readonly anchorId: string;
  readonly continuityAnchorOptions: Readonly<RelayV2ContinuityAnchorOptions>;
}

export interface RelayV2ExternalContinuityAuthorityConfigBinding {
  readonly namespaceBindings: readonly RelayV2ExternalContinuityAuthorityBoundNamespace[];
}

function failure(): TypeError {
  return new TypeError("Relay v2 external continuity authority config binding is invalid");
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

function isClosedCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function" && !rejectedProxy(value);
}

function captureExactDataRecord(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
    ) return null;
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of exactKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureExactDataArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== value.length + 1
      || keys.some((key) => {
        if (key === "length") return false;
        return typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= value.length;
      })
    ) return null;
    const captured: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 128
    && IDENTIFIER.test(value);
}

function validateEndpoint(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_ENDPOINT_BYTES
    || value.includes("?")
    || value.includes("#")
  ) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:"
      && endpoint.hostname.length > 0
      && endpoint.username.length === 0
      && endpoint.password.length === 0
      && endpoint.search.length === 0
      && endpoint.hash.length === 0;
  } catch {
    return false;
  }
}

function isNamespace(value: unknown): value is RelayV2ExternalContinuityNamespace {
  return value === "broker-credential.v1"
    || value === "agent-transcript-lifecycle.v1";
}

function isAuthenticationMode(
  value: unknown,
): value is RelayV2ExternalContinuityAuthenticationMode {
  return value === "mutual_tls" || value === "workload_identity";
}

function captureConfig(value: unknown): Readonly<RelayV2ExternalContinuityAuthorityConfig> {
  const captured = captureExactDataRecord(value, CONFIG_KEYS);
  if (
    captured === null
    || captured.configVersion !== CONFIG_VERSION
    || !validateEndpoint(captured.endpoint)
    || !isIdentifier(captured.securityDomainId)
    || !isAuthenticationMode(captured.authenticationMode)
    || !isIdentifier(captured.credentialReference)
    || !isIdentifier(captured.tlsTrustReference)
    || !Number.isSafeInteger(captured.operationTimeoutMs)
    || (captured.operationTimeoutMs as number) < 1
    || (captured.operationTimeoutMs as number) > RELAY_V2_CONTINUITY_MAX_OPERATION_TIMEOUT_MS
    || !Number.isSafeInteger(captured.maxPendingOperations)
    || (captured.maxPendingOperations as number) < 1
    || (captured.maxPendingOperations as number) > RELAY_V2_CONTINUITY_MAX_PENDING_OPERATIONS
  ) throw failure();

  const rawBindings = captureExactDataArray(captured.namespaceBindings);
  if (rawBindings === null || rawBindings.length < 1 || rawBindings.length > 2) throw failure();
  const namespaces = new Set<RelayV2ExternalContinuityNamespace>();
  const anchorIds = new Set<string>();
  const namespaceBindings: RelayV2ExternalContinuityAuthorityNamespaceConfig[] = [];
  for (const rawBinding of rawBindings) {
    const binding = captureExactDataRecord(rawBinding, NAMESPACE_BINDING_KEYS);
    if (
      binding === null
      || !isNamespace(binding.namespace)
      || !isIdentifier(binding.ownerBinding)
      || !isIdentifier(binding.anchorId)
      || namespaces.has(binding.namespace)
      || anchorIds.has(binding.anchorId)
    ) throw failure();
    namespaces.add(binding.namespace);
    anchorIds.add(binding.anchorId);
    namespaceBindings.push(Object.freeze(Object.assign(Object.create(null), {
      namespace: binding.namespace,
      ownerBinding: binding.ownerBinding,
      anchorId: binding.anchorId,
    })) as RelayV2ExternalContinuityAuthorityNamespaceConfig);
  }

  return Object.freeze(Object.assign(Object.create(null), {
    configVersion: CONFIG_VERSION,
    endpoint: captured.endpoint,
    securityDomainId: captured.securityDomainId,
    authenticationMode: captured.authenticationMode,
    credentialReference: captured.credentialReference,
    tlsTrustReference: captured.tlsTrustReference,
    operationTimeoutMs: captured.operationTimeoutMs,
    maxPendingOperations: captured.maxPendingOperations,
    namespaceBindings: Object.freeze(namespaceBindings),
  })) as Readonly<RelayV2ExternalContinuityAuthorityConfig>;
}

function captureProvider(
  value: unknown,
): {
  readonly receiver: RelayV2ExternalContinuityAuthorityAttemptProvider;
  readonly resolveAttempt: RelayV2ExternalContinuityAuthorityAttemptProvider["resolveAttempt"];
} {
  const captured = captureExactDataRecord(value, PROVIDER_KEYS);
  if (
    captured === null
    || !Object.isFrozen(value)
    || !isClosedCallable(captured.resolveAttempt)
  ) throw failure();
  return Object.freeze({
    receiver: value as RelayV2ExternalContinuityAuthorityAttemptProvider,
    resolveAttempt: captured.resolveAttempt as
      RelayV2ExternalContinuityAuthorityAttemptProvider["resolveAttempt"],
  });
}

function captureResolvedAttempt(value: unknown): {
  readonly receiver: RelayV2ExternalContinuityAuthorityResolvedAttempt;
  readonly authenticationHeaders: () => Readonly<Record<string, string>>;
  readonly transportReceiver: RelayV2ExternalContinuityAuthorityResolvedTransport;
  readonly start: RelayV2ExternalContinuityHttpsTransport["start"];
  readonly discard: RelayV2ExternalContinuityAuthorityResolvedTransport["discard"];
} | null {
  let discardReceiver: RelayV2ExternalContinuityAuthorityResolvedTransport | null = null;
  let safelyCapturedDiscard:
    RelayV2ExternalContinuityAuthorityResolvedTransport["discard"] | null = null;
  try {
    if (
      value !== null
      && (typeof value === "object" || typeof value === "function")
      && !rejectedProxy(value)
    ) {
      const outerDescriptors = Object.getOwnPropertyDescriptors(value);
      const transportDescriptor = outerDescriptors.transport;
      if (transportDescriptor && Object.hasOwn(transportDescriptor, "value")) {
        const rawTransport = transportDescriptor.value;
        if (
          rawTransport !== null
          && (typeof rawTransport === "object" || typeof rawTransport === "function")
          && !rejectedProxy(rawTransport)
        ) {
          const transportDescriptors = Object.getOwnPropertyDescriptors(rawTransport);
          const discardDescriptor = transportDescriptors.discard;
          if (
            discardDescriptor
            && Object.hasOwn(discardDescriptor, "value")
            && isClosedCallable(discardDescriptor.value)
          ) {
            discardReceiver = rawTransport as
              RelayV2ExternalContinuityAuthorityResolvedTransport;
            safelyCapturedDiscard = discardDescriptor.value as
              RelayV2ExternalContinuityAuthorityResolvedTransport["discard"];
          }
        }
      }
    }
  } catch {}
  let discardInvoked = false;
  const reject = (): null => {
    if (!discardInvoked && discardReceiver !== null && safelyCapturedDiscard !== null) {
      discardInvoked = true;
      try { Reflect.apply(safelyCapturedDiscard, discardReceiver, []); } catch {}
    }
    return null;
  };

  const captured = captureExactDataRecord(value, RESOLVED_ATTEMPT_KEYS);
  if (captured === null) return reject();
  const transport = captureExactDataRecord(captured.transport, TRANSPORT_KEYS);
  if (
    transport === null
    || discardReceiver === null
    || safelyCapturedDiscard === null
    || captured.transport !== discardReceiver
    || transport.discard !== safelyCapturedDiscard
    || !Object.isFrozen(value)
    || !Object.isFrozen(captured.transport)
    || !isClosedCallable(captured.authenticationHeaders)
    || !isClosedCallable(transport.start)
    || !isClosedCallable(transport.discard)
  ) return reject();
  const transportReceiver = captured.transport as
    RelayV2ExternalContinuityAuthorityResolvedTransport;
  return Object.freeze({
    receiver: value as RelayV2ExternalContinuityAuthorityResolvedAttempt,
    authenticationHeaders: captured.authenticationHeaders as
      () => Readonly<Record<string, string>>,
    transportReceiver,
    start: transport.start as RelayV2ExternalContinuityHttpsTransport["start"],
    discard: safelyCapturedDiscard,
  });
}

function createResolutionRequest(
  config: Readonly<RelayV2ExternalContinuityAuthorityConfig>,
): RelayV2ExternalContinuityAuthorityAttemptResolutionRequest {
  return Object.freeze(Object.assign(Object.create(null), {
    endpoint: config.endpoint,
    authenticationMode: config.authenticationMode,
    credentialReference: config.credentialReference,
    tlsTrustReference: config.tlsTrustReference,
  })) as RelayV2ExternalContinuityAuthorityAttemptResolutionRequest;
}

function createBoundAuthority(
  config: Readonly<RelayV2ExternalContinuityAuthorityConfig>,
  namespaceBinding: RelayV2ExternalContinuityAuthorityNamespaceConfig,
  provider: ReturnType<typeof captureProvider>,
): RelayV2MonotonicCasAuthority {
  type AttemptOwner = Readonly<{
    start(request: RelayV2ExternalContinuityHttpsTransportRequest):
      RelayV2ExternalContinuityHttpsTransportExchange;
    discard(): void;
  }>;
  let pendingAttempt: AttemptOwner | null = null;

  const authenticationHeaders = (): Readonly<Record<string, string>> => {
    if (pendingAttempt !== null) {
      try { pendingAttempt.discard(); } catch {}
      throw failure();
    }
    let raw: unknown;
    try {
      raw = Reflect.apply(provider.resolveAttempt, provider.receiver, [
        createResolutionRequest(config),
      ]);
    } catch {
      throw failure();
    }
    const resolved = captureResolvedAttempt(raw);
    if (resolved === null) throw failure();

    let state: "pending" | "started" | "discarded" = "pending";
    let owner: AttemptOwner;
    const settle = (): void => {
      if (pendingAttempt === owner) pendingAttempt = null;
    };
    owner = Object.freeze({
      start(request): RelayV2ExternalContinuityHttpsTransportExchange {
        if (state !== "pending") throw failure();
        state = "started";
        settle();
        return Reflect.apply(resolved.start, resolved.transportReceiver, [request]);
      },
      discard(): void {
        if (state !== "pending") return;
        state = "discarded";
        settle();
        Reflect.apply(resolved.discard, resolved.transportReceiver, []);
      },
    });
    pendingAttempt = owner;
    try {
      return Reflect.apply(resolved.authenticationHeaders, resolved.receiver, []);
    } catch {
      throw failure();
    }
  };

  let transportBridge: RelayV2ExternalContinuityHttpsTransport;
  const start = function start(
    this: unknown,
    request: RelayV2ExternalContinuityHttpsTransportRequest,
  ): RelayV2ExternalContinuityHttpsTransportExchange {
    if (this !== transportBridge) throw failure();
    const attempt = pendingAttempt;
    if (attempt === null) throw failure();
    return attempt.start(request);
  };
  transportBridge = Object.freeze(Object.assign(Object.create(null), { start })) as
    RelayV2ExternalContinuityHttpsTransport;

  const adapter = new RelayV2ExternalContinuityAuthorityHttpsAdapter({
    endpoint: config.endpoint,
    securityDomainId: config.securityDomainId,
    namespace: namespaceBinding.namespace,
    anchorId: namespaceBinding.anchorId,
    authenticationHeaders,
    discardUnstartedAttempt: () => {
      const attempt = pendingAttempt;
      if (attempt !== null) attempt.discard();
    },
    transport: transportBridge,
  });

  let authority: RelayV2MonotonicCasAuthority;
  const read = function read(
    this: unknown,
    request: RelayV2ContinuityAnchorReadRequest,
  ): Promise<unknown> {
    if (this !== authority) {
      return Promise.reject(new RelayV2ExternalContinuityHttpsAdapterError("ANCHOR_UNAVAILABLE"));
    }
    return adapter.read(request);
  };
  const compareAndSwap = function compareAndSwap(
    this: unknown,
    request: RelayV2ContinuityAnchorCasRequest,
  ): Promise<unknown> {
    if (this !== authority) {
      return Promise.reject(
        new RelayV2ExternalContinuityHttpsAdapterError("ANCHOR_COMMIT_UNCERTAIN"),
      );
    }
    return adapter.compareAndSwap(request);
  };
  authority = Object.freeze(Object.assign(Object.create(null), { read, compareAndSwap })) as
    RelayV2MonotonicCasAuthority;
  return authority;
}

/**
 * Captures a frozen future-E0 configuration and binds each namespace to the
 * existing HTTPS adapter. Construction is inert: auth/trust resolution and
 * transport creation occur only inside an admitted read/CAS attempt.
 */
export function bindRelayV2ExternalContinuityAuthorityConfig(
  config: RelayV2ExternalContinuityAuthorityConfig,
  attemptProvider: RelayV2ExternalContinuityAuthorityAttemptProvider,
): RelayV2ExternalContinuityAuthorityConfigBinding {
  const capturedConfig = captureConfig(config);
  const capturedProvider = captureProvider(attemptProvider);
  const namespaceBindings = capturedConfig.namespaceBindings.map((namespaceBinding) => {
    const authority = createBoundAuthority(capturedConfig, namespaceBinding, capturedProvider);
    const continuityAnchorOptions = Object.freeze(Object.assign(Object.create(null), {
      anchorId: namespaceBinding.anchorId,
      authority,
      operationTimeoutMs: capturedConfig.operationTimeoutMs,
      maxPendingOperations: capturedConfig.maxPendingOperations,
    })) as Readonly<RelayV2ContinuityAnchorOptions>;
    return Object.freeze(Object.assign(Object.create(null), {
      namespace: namespaceBinding.namespace,
      ownerBinding: namespaceBinding.ownerBinding,
      anchorId: namespaceBinding.anchorId,
      continuityAnchorOptions,
    })) as RelayV2ExternalContinuityAuthorityBoundNamespace;
  });
  return Object.freeze(Object.assign(Object.create(null), {
    namespaceBindings: Object.freeze(namespaceBindings),
  })) as RelayV2ExternalContinuityAuthorityConfigBinding;
}
