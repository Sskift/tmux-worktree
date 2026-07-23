import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2ExternalContinuityAuthenticationMode,
  RelayV2ExternalContinuityAuthorityAttemptProvider,
  RelayV2ExternalContinuityAuthorityAttemptResolutionRequest,
  RelayV2ExternalContinuityAuthorityResolvedAttempt,
  RelayV2ExternalContinuityAuthorityResolvedTransport,
} from "./externalContinuityAuthorityConfig.js";
import {
  createRelayV2SingleExchangeNodeHttpsTransport,
  type RelayV2SingleExchangeHttpsTransport,
  type RelayV2SingleExchangeHttpsTransportExchange,
  type RelayV2SingleExchangeHttpsTransportRequest,
  type RelayV2SingleExchangeHttpsTransportResponse,
  type RelayV2SingleExchangeNodeHttpsRequest,
} from "./singleExchangeHttpsTransport.js";

const MAX_ENDPOINT_BYTES = 2_048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const OPTION_KEYS = ["resolver", "httpsRequest"] as const;
const RESOLVER_KEYS = ["resolveTrust", "resolveCredential"] as const;
const REQUEST_KEYS = [
  "endpoint",
  "authenticationMode",
  "credentialReference",
  "tlsTrustReference",
] as const;
const TRUST_MATERIAL_KEYS = ["certificateAuthorities", "dispose"] as const;
const WORKLOAD_CREDENTIAL_MATERIAL_KEYS = ["authenticationHeaders", "dispose"] as const;
const MUTUAL_TLS_CREDENTIAL_MATERIAL_KEYS = [
  "clientCertificate",
  "clientKey",
  "dispose",
] as const;

// Bounds on resolver output, chosen at the frozen outer-HTTPS magnitude
// (httpsBodyBytes 16384) and the identifier-style 128-byte naming bound: a
// private trust bundle for one exact endpoint holds a small root/chain set,
// workload headers stay a few short names with token-sized values, and
// PEM/DER key material stays well under one request body.
const MAX_CA_ENTRIES = 8;
const MAX_TLS_MATERIAL_BYTES = 16_384;
const MAX_CA_TOTAL_BYTES = 32_768;
const MAX_AUTHENTICATION_HEADER_COUNT = 8;
const MAX_AUTHENTICATION_HEADER_NAME_BYTES = 128;
const MAX_AUTHENTICATION_HEADER_VALUE_BYTES = 4_096;

/**
 * Privileged, deployment-owned resolver port. References are opaque non-secret
 * keys from the validated E0 config; every returned material is single-attempt,
 * exclusively owned by the provider, and released exactly once through its own
 * `dispose()`. This module intentionally defines no concrete enterprise
 * credential API and ships no production resolver.
 */
export interface RelayV2ExternalContinuityAttemptTrustMaterial {
  readonly certificateAuthorities: readonly (string | Uint8Array)[];
  dispose(): void;
}

export interface RelayV2ExternalContinuityAttemptWorkloadCredentialMaterial {
  readonly authenticationHeaders: Readonly<Record<string, string>>;
  dispose(): void;
}

export interface RelayV2ExternalContinuityAttemptMutualTlsCredentialMaterial {
  readonly clientCertificate: string | Uint8Array;
  readonly clientKey: string | Uint8Array;
  dispose(): void;
}

export interface RelayV2ExternalContinuityAttemptMaterialResolver {
  resolveTrust(reference: string): RelayV2ExternalContinuityAttemptTrustMaterial;
  resolveCredential(
    reference: string,
    mode: "workload_identity",
  ): RelayV2ExternalContinuityAttemptWorkloadCredentialMaterial;
  resolveCredential(
    reference: string,
    mode: "mutual_tls",
  ): RelayV2ExternalContinuityAttemptMutualTlsCredentialMaterial;
}

export interface RelayV2ExternalContinuityAuthorityNodeAttemptProviderOptions {
  /**
   * Deployment-owned privileged resolver. Like the attempt-provider object
   * captured by the config binder, it must be frozen so its captured callables
   * cannot be swapped after construction.
   */
  readonly resolver: RelayV2ExternalContinuityAttemptMaterialResolver;
  /** Isolated test seam; production composition uses the system Node stack. */
  readonly httpsRequest?: RelayV2SingleExchangeNodeHttpsRequest;
}

function failure(): TypeError {
  return new TypeError(
    "Relay v2 external continuity Node attempt provider resolution failed",
  );
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

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 128
    && IDENTIFIER.test(value);
}

function isExactHttpsEndpoint(value: unknown): value is string {
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

function isAuthenticationMode(
  value: unknown,
): value is RelayV2ExternalContinuityAuthenticationMode {
  return value === "mutual_tls" || value === "workload_identity";
}

function tlsMaterialBytes(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

function captureTlsMaterialValue(value: unknown): string | Uint8Array | null {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") > MAX_TLS_MATERIAL_BYTES ? null : value;
  }
  if (value instanceof Uint8Array && !rejectedProxy(value)) {
    if (value.byteLength > MAX_TLS_MATERIAL_BYTES) return null;
    // Buffer.prototype.slice shares memory; always copy into an owned array.
    return new Uint8Array(value);
  }
  return null;
}

type CapturedDispose = Readonly<{
  receiver: object;
  dispose: () => void;
}>;

type CapturedMaterialSnapshot = Readonly<{
  /** Own-data snapshot values; meaningful only when `valid` is true. */
  snapshot: Readonly<Record<string, unknown>>;
  /** Cleanup captured from the original material, bound to that original. */
  release: CapturedDispose | null;
  valid: boolean;
}>;

/**
 * Snapshots a raw resolver material exactly once. Every later check reads only
 * this snapshot; no foreign property is read again. A safely captured dispose
 * (own data property, closed callable, non-Proxy) stays bound to the original
 * material object so `this`-dependent cleanup works, and it must be released
 * exactly once even when the remaining shape validation fails.
 */
function captureMaterialSnapshot(
  value: unknown,
  exactKeys: readonly string[],
): CapturedMaterialSnapshot | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  let release: CapturedDispose | null = null;
  const disposeDescriptor = descriptors.dispose;
  if (
    disposeDescriptor !== undefined
    && Object.hasOwn(disposeDescriptor, "value")
    && isClosedCallable(disposeDescriptor.value)
  ) {
    release = Object.freeze({
      receiver: value,
      dispose: disposeDescriptor.value as () => void,
    });
  }
  const keys = Reflect.ownKeys(descriptors);
  let valid = keys.length === exactKeys.length
    && keys.every((key) => typeof key === "string" && exactKeys.includes(key));
  const snapshot: Record<string, unknown> = Object.create(null);
  if (valid) {
    for (const key of exactKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        valid = false;
        break;
      }
      snapshot[key] = descriptor.value;
    }
  }
  return Object.freeze({
    snapshot: Object.freeze(snapshot),
    release,
    valid,
  });
}

type CapturedTrustMaterial = Readonly<{
  certificateAuthorities: readonly (string | Uint8Array)[];
  release: CapturedDispose;
}>;

type CapturedCredentialMaterial = Readonly<
  | {
      readonly mode: "workload_identity";
      readonly authenticationHeaders: Readonly<Record<string, string>>;
      readonly release: CapturedDispose;
    }
  | {
      readonly mode: "mutual_tls";
      readonly clientCertificate: string | Uint8Array;
      readonly clientKey: string | Uint8Array;
      readonly release: CapturedDispose;
    }
>;

function captureDataArray(value: unknown, maxLength: number): readonly unknown[] | null {
  if (!Array.isArray(value) || rejectedProxy(value)) return null;
  try {
    const length = value.length;
    if (length > maxLength) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== length + 1
      || keys.some((key) => {
        if (key === "length") return false;
        return typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= length;
      })
    ) return null;
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureTrustMaterial(value: unknown): CapturedTrustMaterial | null {
  const captured = captureMaterialSnapshot(value, TRUST_MATERIAL_KEYS);
  if (captured === null || captured.release === null) return null;
  const release = captured.release;
  // Material the resolver already handed out is released exactly once on
  // every fail path below.
  const fail = (): null => {
    invokeDispose(release);
    return null;
  };
  if (!captured.valid) return fail();
  const rawAuthorities = captureDataArray(
    captured.snapshot.certificateAuthorities,
    MAX_CA_ENTRIES,
  );
  if (rawAuthorities === null || rawAuthorities.length < 1) return fail();
  let totalBytes = 0;
  const certificateAuthorities: (string | Uint8Array)[] = [];
  for (const entry of rawAuthorities) {
    const authority = captureTlsMaterialValue(entry);
    if (authority === null) return fail();
    totalBytes += tlsMaterialBytes(authority);
    if (totalBytes > MAX_CA_TOTAL_BYTES) return fail();
    certificateAuthorities.push(authority);
  }
  return Object.freeze({
    certificateAuthorities: Object.freeze(certificateAuthorities),
    release,
  });
}

function captureHeaderRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_AUTHENTICATION_HEADER_COUNT) return null;
  const headers: Record<string, string> = Object.create(null);
  for (const key of keys) {
    if (
      typeof key !== "string"
      || Buffer.byteLength(key, "utf8") > MAX_AUTHENTICATION_HEADER_NAME_BYTES
    ) return null;
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    const headerValue = descriptor.value;
    if (
      typeof headerValue !== "string"
      || Buffer.byteLength(headerValue, "utf8") > MAX_AUTHENTICATION_HEADER_VALUE_BYTES
    ) return null;
    headers[key] = headerValue;
  }
  return Object.freeze(headers);
}

function captureCredentialMaterial(
  value: unknown,
  mode: RelayV2ExternalContinuityAuthenticationMode,
): CapturedCredentialMaterial | null {
  const captured = captureMaterialSnapshot(
    value,
    mode === "workload_identity"
      ? WORKLOAD_CREDENTIAL_MATERIAL_KEYS
      : MUTUAL_TLS_CREDENTIAL_MATERIAL_KEYS,
  );
  if (captured === null || captured.release === null) return null;
  const release = captured.release;
  const fail = (): null => {
    invokeDispose(release);
    return null;
  };
  if (!captured.valid) return fail();
  if (mode === "workload_identity") {
    const authenticationHeaders = captureHeaderRecord(
      captured.snapshot.authenticationHeaders,
    );
    if (authenticationHeaders === null) return fail();
    return Object.freeze({
      mode,
      authenticationHeaders,
      release,
    });
  }
  const clientCertificate = captureTlsMaterialValue(captured.snapshot.clientCertificate);
  const clientKey = captureTlsMaterialValue(captured.snapshot.clientKey);
  if (clientCertificate === null || clientKey === null) return fail();
  return Object.freeze({
    mode,
    clientCertificate,
    clientKey,
    release,
  });
}

function invokeDispose(release: CapturedDispose): void {
  try {
    Reflect.apply(release.dispose, release.receiver, []);
  } catch {
    // Cleanup must never leak resolver faults or secrets into this failure surface.
  }
}

/**
 * Default-off, production-facing E0 per-attempt credential/trust resolver and
 * HTTPS transport provider. Every `resolveAttempt` freshly resolves the exact
 * opaque `credentialReference`/`tlsTrustReference` through the injected
 * privileged resolver, binds the material to the exact configured endpoint
 * identity, and issues a one-attempt transport. Nothing is cached across
 * attempts; resolved material is disposed exactly once on discard, start
 * failure, abort, or exchange settlement. There is no retry, redirect,
 * fallback, readiness, enrollment, or capability behavior here, and no
 * production resolver/backend is shipped — the CLI never constructs this seam.
 */
export function createRelayV2ExternalContinuityAuthorityNodeAttemptProvider(
  options: RelayV2ExternalContinuityAuthorityNodeAttemptProviderOptions,
): RelayV2ExternalContinuityAuthorityAttemptProvider {
  const capturedOptions = captureExactDataRecord(
    options,
    options !== null && typeof options === "object" && !rejectedProxy(options)
      && Object.hasOwn(options, "httpsRequest")
      ? [...OPTION_KEYS]
      : ["resolver"],
  );
  const capturedResolver = capturedOptions === null
    ? null
    : captureExactDataRecord(capturedOptions.resolver, RESOLVER_KEYS);
  if (
    capturedOptions === null
    || capturedResolver === null
    || !Object.isFrozen(capturedOptions.resolver)
    || !isClosedCallable(capturedResolver.resolveTrust)
    || !isClosedCallable(capturedResolver.resolveCredential)
    || (capturedOptions.httpsRequest !== undefined
      && !isClosedCallable(capturedOptions.httpsRequest))
  ) throw failure();
  const resolverReceiver = capturedOptions.resolver as object;
  const resolveTrust = capturedResolver.resolveTrust as (
    reference: string,
  ) => unknown;
  const resolveCredential = capturedResolver.resolveCredential as (
    reference: string,
    mode: RelayV2ExternalContinuityAuthenticationMode,
  ) => unknown;
  const httpsRequest = capturedOptions.httpsRequest as
    | RelayV2SingleExchangeNodeHttpsRequest
    | undefined;

  let provider: RelayV2ExternalContinuityAuthorityAttemptProvider;
  const resolveAttempt = function resolveAttempt(
    this: unknown,
    request: RelayV2ExternalContinuityAuthorityAttemptResolutionRequest,
  ): RelayV2ExternalContinuityAuthorityResolvedAttempt {
    if (this !== provider || arguments.length !== 1) throw failure();
    const capturedRequest = captureExactDataRecord(request, REQUEST_KEYS);
    if (
      capturedRequest === null
      || !Object.isFrozen(request)
      || !isExactHttpsEndpoint(capturedRequest.endpoint)
      || !isAuthenticationMode(capturedRequest.authenticationMode)
      || !isIdentifier(capturedRequest.credentialReference)
      || !isIdentifier(capturedRequest.tlsTrustReference)
    ) throw failure();
    const endpoint = capturedRequest.endpoint;
    const mode = capturedRequest.authenticationMode;

    let trust: CapturedTrustMaterial | null = null;
    let credential: CapturedCredentialMaterial | null = null;
    try {
      trust = captureTrustMaterial(
        Reflect.apply(resolveTrust, resolverReceiver, [
          capturedRequest.tlsTrustReference,
        ]),
      );
      if (trust === null) throw failure();
      credential = captureCredentialMaterial(
        Reflect.apply(resolveCredential, resolverReceiver, [
          capturedRequest.credentialReference,
          mode,
        ]),
        mode,
      );
      if (credential === null) throw failure();
    } catch {
      if (credential !== null) invokeDispose(credential.release);
      if (trust !== null) invokeDispose(trust.release);
      throw failure();
    }
    const acquiredTrust = trust;
    const acquiredCredential = credential;

    let underlying: RelayV2SingleExchangeHttpsTransport;
    try {
      const tls = acquiredCredential.mode === "mutual_tls"
        ? Object.freeze({
            ca: acquiredTrust.certificateAuthorities,
            cert: acquiredCredential.clientCertificate,
            key: acquiredCredential.clientKey,
          })
        : Object.freeze({ ca: acquiredTrust.certificateAuthorities });
      underlying = httpsRequest === undefined
        ? createRelayV2SingleExchangeNodeHttpsTransport(undefined, tls)
        : createRelayV2SingleExchangeNodeHttpsTransport(httpsRequest, tls);
    } catch {
      invokeDispose(acquiredCredential.release);
      invokeDispose(acquiredTrust.release);
      throw failure();
    }

    let state: "pending" | "started" | "discarded" = "pending";
    let released = false;
    const releaseMaterials = (): void => {
      if (released) return;
      released = true;
      invokeDispose(acquiredCredential.release);
      invokeDispose(acquiredTrust.release);
    };

    let transport: RelayV2ExternalContinuityAuthorityResolvedTransport;
    const start = function start(
      this: unknown,
      startRequest: RelayV2SingleExchangeHttpsTransportRequest,
    ): RelayV2SingleExchangeHttpsTransportExchange {
      if (this !== transport || arguments.length !== 1 || state !== "pending") {
        throw failure();
      }
      state = "started";
      let exchange: RelayV2SingleExchangeHttpsTransportExchange;
      try {
        // Resolved trust/auth material is bound to the exact resolved
        // endpoint identity; it is never forwarded to another endpoint.
        const candidate: unknown = startRequest;
        if (
          candidate === null
          || (typeof candidate !== "object" && typeof candidate !== "function")
          || rejectedProxy(candidate)
          || (candidate as { endpoint?: unknown }).endpoint !== endpoint
        ) {
          throw failure();
        }
        exchange = underlying.start(startRequest);
      } catch {
        releaseMaterials();
        throw failure();
      }
      if (
        exchange === null
        || typeof exchange !== "object"
        || rejectedProxy(exchange)
        || typeof exchange.abort !== "function"
        || !Object.hasOwn(exchange, "response")
      ) {
        releaseMaterials();
        throw failure();
      }
      // The underlying transport resolves `response` with a native promise;
      // attach directly instead of assimilating a foreign thenable.
      let response: PromiseLike<RelayV2SingleExchangeHttpsTransportResponse>;
      try {
        response = exchange.response.then(
          (value) => {
            releaseMaterials();
            return value;
          },
          () => {
            releaseMaterials();
            throw failure();
          },
        );
      } catch {
        try { Reflect.apply(exchange.abort, exchange, []); } catch {}
        releaseMaterials();
        throw failure();
      }
      let abortInvoked = false;
      let wrapped: RelayV2SingleExchangeHttpsTransportExchange;
      wrapped = Object.freeze(Object.assign(Object.create(null), {
        response,
        abort() {
          if (this !== wrapped || abortInvoked) return;
          abortInvoked = true;
          try {
            Reflect.apply(exchange.abort, exchange, []);
          } catch {
            // The underlying exchange owns its own closed failure surface.
          }
          releaseMaterials();
        },
      })) as RelayV2SingleExchangeHttpsTransportExchange;
      return wrapped;
    };
    const discard = function discard(this: unknown): void {
      if (this !== transport || arguments.length !== 0 || state !== "pending") {
        throw failure();
      }
      state = "discarded";
      releaseMaterials();
    };
    transport = Object.freeze(Object.assign(Object.create(null), {
      start,
      discard,
    })) as RelayV2ExternalContinuityAuthorityResolvedTransport;

    let resolved: RelayV2ExternalContinuityAuthorityResolvedAttempt;
    const authenticationHeaders = function authenticationHeaders(
      this: unknown,
    ): Readonly<Record<string, string>> {
      if (this !== resolved || arguments.length !== 0) throw failure();
      if (acquiredCredential.mode === "workload_identity") {
        return acquiredCredential.authenticationHeaders;
      }
      return EMPTY_HEADERS;
    };
    resolved = Object.freeze(Object.assign(Object.create(null), {
      authenticationHeaders,
      transport,
    })) as RelayV2ExternalContinuityAuthorityResolvedAttempt;
    return resolved;
  };
  provider = Object.freeze(Object.assign(Object.create(null), {
    resolveAttempt,
  })) as RelayV2ExternalContinuityAuthorityAttemptProvider;
  return provider;
}

const EMPTY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  Object.create(null),
);
