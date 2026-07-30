import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import {
  RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
  RelayV2BrokerCredentialStateStoreError,
  type RelayV2BrokerCredentialStateRevision,
  type RelayV2BrokerCredentialStateStore,
  type RelayV2BrokerCredentialStateTransaction,
} from "./brokerCredentialStateStore.js";
import type {
  RelayV2BrokerCredentialStateStoreNativeLoader,
} from "./brokerCredentialStateStoreLoader.js";
import type {
  RelayV2ExternalContinuityAuthorityAttemptProvider,
  RelayV2ExternalContinuityAuthorityAttemptResolutionRequest,
} from "./externalContinuityAuthorityConfig.js";
import { createRelayV2IssuerKeyring } from "./issuer.js";
import {
  startRelayV2BrokerShippingRoot,
  type RelayV2BrokerShippingRootHandle,
} from "./brokerShippingRoot.js";

const LOOPBACK_HOST = "127.0.0.1";
const MEMORY_TRUSTED_HOME = "/relay-v2-local-development-memory";
const EXTERNAL_ENDPOINT = "https://relay-v2-local-development.invalid/e0";
const BROKER_ANCHOR = "relay-v2-local-development-broker-anchor";
const TLS_FILE_MAX_BYTES = 64 * 1024;
const ACTIVATION_FAILED = "Relay v2 local development Broker activation failed";

export interface RelayV2BrokerLocalDevelopmentOptions {
  readonly port: number;
  readonly tlsKeyPath: string;
  readonly tlsCertificatePath: string;
  readonly advertisedOrigin?: string;
}

type CapturedLocalDevelopmentOptions = Readonly<{
  port: number;
  tlsKeyPath: string;
  tlsCertificatePath: string;
  issuerUrl: string;
  relayUrl: string;
}>;

type RevisionOwner = Readonly<{
  transactionIdentity: object;
  generation: number;
}>;

/**
 * Process-local development storage only. It deliberately does not expose a
 * native capability result or participate in the production qualification
 * allowlist. The shipping composition consumes it only through its existing
 * injected loader port.
 */
class RelayV2BrokerLocalDevelopmentMemoryStore
implements RelayV2BrokerCredentialStateStore {
  private bytes: Uint8Array | null = null;
  private generation = 0;
  private readonly revisions = new WeakMap<object, RevisionOwner>();
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  runExclusive<Result>(
    operation: <TransactionScope>(
      transaction: RelayV2BrokerCredentialStateTransaction<TransactionScope>,
    ) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (this.closing) {
      return Promise.reject(new RelayV2BrokerCredentialStateStoreError("STORE_CLOSED"));
    }
    const transactionIdentity = Object.freeze({});
    const admitted = this.tail.then(async () => {
      let active = true;
      const requireActive = (): void => {
        if (!active) {
          throw new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION");
        }
      };
      const readCurrent = <TransactionScope>() => {
        requireActive();
        const revision = Object.freeze({});
        this.revisions.set(revision, Object.freeze({
          transactionIdentity,
          generation: this.generation,
        }));
        return this.bytes === null
          ? Object.freeze({
              outcome: "missing" as const,
              revision: revision as RelayV2BrokerCredentialStateRevision<TransactionScope>,
            })
          : Object.freeze({
              outcome: "present" as const,
              revision: revision as RelayV2BrokerCredentialStateRevision<TransactionScope>,
              bytes: Uint8Array.from(this.bytes),
            });
      };
      const transaction = Object.freeze({
        read: async () => readCurrent(),
        compareAndPublish: async <TransactionScope>(
          expected: RelayV2BrokerCredentialStateRevision<TransactionScope>,
          next: Uint8Array,
        ) => {
          requireActive();
          if (!(next instanceof Uint8Array)
            || next.byteLength > RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES) {
            throw new RelayV2BrokerCredentialStateStoreError("STATE_TOO_LARGE");
          }
          const expectedOwner = this.revisions.get(expected as object);
          if (expectedOwner?.transactionIdentity !== transactionIdentity) {
            throw new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION");
          }
          const copied = Uint8Array.from(next);
          if (this.bytes !== null && Buffer.from(this.bytes).equals(copied)) {
            return Object.freeze({
              outcome: "already_same" as const,
              current: readCurrent<TransactionScope>(),
            });
          }
          if (expectedOwner.generation !== this.generation) {
            return Object.freeze({
              outcome: "conflict" as const,
              current: readCurrent<TransactionScope>(),
            });
          }
          if (this.bytes !== null) this.bytes.fill(0);
          this.bytes = copied;
          this.generation += 1;
          return Object.freeze({
            outcome: "swapped" as const,
            current: readCurrent<TransactionScope>(),
          });
        },
      }) as RelayV2BrokerCredentialStateTransaction<unknown>;
      try {
        return await operation(transaction);
      } finally {
        active = false;
      }
    });
    this.tail = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(() => {
      if (this.bytes !== null) this.bytes.fill(0);
      this.bytes = null;
    });
    return this.closePromise;
  }
}

function localDevelopmentLoader(): RelayV2BrokerCredentialStateStoreNativeLoader {
  let opened = false;
  return Object.freeze({
    capability(): never {
      throw new Error(ACTIVATION_FAILED);
    },
    async open(trustedHome) {
      if (opened || trustedHome !== MEMORY_TRUSTED_HOME) {
        throw new Error(ACTIVATION_FAILED);
      }
      opened = true;
      return Object.freeze({
        status: "opened" as const,
        selfCheck: "passed" as const,
        store: new RelayV2BrokerLocalDevelopmentMemoryStore(),
      });
    },
  });
}

type ContinuitySnapshot =
  | Readonly<{
      protocolVersion: 1;
      status: "uninitialized";
      anchorId: string;
      casToken: string;
    }>
  | Readonly<{
      protocolVersion: 1;
      status: "committed";
      anchorId: string;
      casToken: string;
      checkpoint: unknown;
    }>;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function responseEnvelope(
  operationId: string,
  result: unknown,
): Readonly<{
  statusCode: number;
  headers: readonly (readonly [string, string])[];
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}> {
  const body = Buffer.from(JSON.stringify({
    contractVersion: 1,
    operationId,
    ok: true,
    result,
    error: null,
  }), "utf8");
  return Object.freeze({
    statusCode: 200,
    headers: Object.freeze([
      Object.freeze(["Content-Type", "application/json"] as const),
      Object.freeze(["Cache-Control", "no-store"] as const),
      Object.freeze(["Content-Length", String(body.byteLength)] as const),
    ]),
    body: Object.freeze({
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    }),
    destroy() {},
  });
}

function exactResolutionRequest(
  value: RelayV2ExternalContinuityAuthorityAttemptResolutionRequest,
): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return Object.isFrozen(value)
      && keys.length === 4
      && keys.every((key) => typeof key === "string" && [
        "endpoint",
        "authenticationMode",
        "credentialReference",
        "tlsTrustReference",
      ].includes(key))
      && value.endpoint === EXTERNAL_ENDPOINT
      && value.authenticationMode === "workload_identity"
      && value.credentialReference === "local-development-memory-credential"
      && value.tlsTrustReference === "local-development-memory-trust";
  } catch {
    return false;
  }
}

function localDevelopmentContinuityProvider():
  RelayV2ExternalContinuityAuthorityAttemptProvider {
  let casGeneration = 0;
  let current: ContinuitySnapshot = Object.freeze({
    protocolVersion: 1,
    status: "uninitialized",
    anchorId: BROKER_ANCHOR,
    casToken: "local-development-cas-0",
  });

  return Object.freeze({
    resolveAttempt(request) {
      if (!exactResolutionRequest(request)) throw new Error(ACTIVATION_FAILED);
      let state: "pending" | "started" | "discarded" = "pending";
      const transport = Object.freeze({
        start(startRequest) {
          if (state !== "pending"
            || startRequest.endpoint !== EXTERNAL_ENDPOINT
            || startRequest.method !== "POST"
            || !(startRequest.body instanceof Uint8Array)) {
            throw new Error(ACTIVATION_FAILED);
          }
          state = "started";
          let wire: Record<string, unknown>;
          try {
            wire = JSON.parse(Buffer.from(startRequest.body).toString("utf8")) as
              Record<string, unknown>;
          } catch {
            throw new Error(ACTIVATION_FAILED);
          }
          if (typeof wire.operationId !== "string"
            || wire.namespace !== "broker-credential.v1"
            || wire.anchorId !== BROKER_ANCHOR
            || (wire.operation !== "read" && wire.operation !== "compare_and_swap")) {
            throw new Error(ACTIVATION_FAILED);
          }

          let result: unknown;
          if (wire.operation === "read") {
            result = cloneJson(current);
          } else {
            const payload = wire.payload as Record<string, unknown> | null;
            if (payload === null || typeof payload !== "object"
              || !Object.hasOwn(payload, "expected")
              || !Object.hasOwn(payload, "next")) {
              throw new Error(ACTIVATION_FAILED);
            }
            const expected = payload.expected as ContinuitySnapshot;
            if (JSON.stringify(expected) === JSON.stringify(current)) {
              casGeneration += 1;
              current = Object.freeze({
                protocolVersion: 1,
                status: "committed",
                anchorId: BROKER_ANCHOR,
                casToken: `local-development-cas-${casGeneration}`,
                checkpoint: cloneJson(payload.next),
              });
              result = {
                protocolVersion: 1,
                outcome: "swapped",
                current: cloneJson(current),
              };
            } else {
              result = {
                protocolVersion: 1,
                outcome: "conflict",
                current: cloneJson(current),
              };
            }
          }
          return Object.freeze({
            response: Promise.resolve(responseEnvelope(wire.operationId, result)),
            abort() {},
          });
        },
        discard() {
          if (state !== "pending") throw new Error(ACTIVATION_FAILED);
          state = "discarded";
        },
      });
      return Object.freeze({
        authenticationHeaders() {
          if (state !== "pending") throw new Error(ACTIVATION_FAILED);
          return Object.freeze({
            Authorization: "Bearer relay-v2-local-development-memory",
          });
        },
        transport,
      });
    },
  });
}

function assertRestrictedTlsFile(information: BigIntStats, euid: bigint): void {
  if (!information.isFile()
    || information.isSymbolicLink()
    || information.uid !== euid
    || Number(information.mode & 0o7777n) !== 0o600
    || information.nlink !== 1n
    || information.size <= 0n
    || information.size > BigInt(TLS_FILE_MAX_BYTES)) {
    throw new Error(ACTIVATION_FAILED);
  }
}

export function readRelayV2BrokerDevelopmentTlsFile(path: string): Buffer {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
    || typeof fsConstants.O_NOFOLLOW !== "number"
    || !isAbsolute(path)
    || path.includes("\0")) {
    throw new Error(ACTIVATION_FAILED);
  }
  const euid = BigInt(process.geteuid());
  let descriptor = -1;
  let bytes: Buffer | null = null;
  let succeeded = false;
  try {
    const before = lstatSync(path, { bigint: true });
    assertRestrictedTlsFile(before, euid);
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertRestrictedTlsFile(opened, euid);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(ACTIVATION_FAILED);
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read <= 0) throw new Error(ACTIVATION_FAILED);
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      bytes.fill(0);
      throw new Error(ACTIVATION_FAILED);
    }
    closeSync(descriptor);
    descriptor = -1;
    succeeded = true;
    return bytes;
  } catch {
    throw new Error(ACTIVATION_FAILED);
  } finally {
    if (!succeeded && bytes !== null) bytes.fill(0);
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function validAdvertisedHostname(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isIP(hostname.slice(1, -1)) === 6;
  }
  if (isIP(hostname) !== 0) return true;
  const withoutFinalDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return withoutFinalDot.length > 0
    && withoutFinalDot.length <= 253
    && withoutFinalDot.split(".").every((label) =>
      label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function captureRelayV2BrokerDevelopmentAdvertisedEndpoints(
  value: unknown,
  listenerPort: number,
): Readonly<{ issuerUrl: string; relayUrl: string }> {
  if (value === undefined) {
    return Object.freeze({
      issuerUrl: `https://localhost:${listenerPort}/`,
      relayUrl: `wss://localhost:${listenerPort}/client`,
    });
  }
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 2_048
    || !value.startsWith("https://")
    || !/^[\x21-\x7e]+$/.test(value)
    || value.includes("\\")
    || value.includes("?")
    || value.includes("#")
    || value.includes("%")) {
    throw new Error(ACTIVATION_FAILED);
  }
  const afterScheme = value.slice("https://".length);
  const firstSlash = afterScheme.indexOf("/");
  const authority = firstSlash === -1 ? afterScheme : afterScheme.slice(0, firstSlash);
  if (authority.length === 0
    || authority.endsWith(":")
    || authority.includes("@")
    || (firstSlash !== -1 && firstSlash !== afterScheme.length - 1)) {
    throw new Error(ACTIVATION_FAILED);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(ACTIVATION_FAILED);
  }
  const explicitPort = parsed.port === "" ? null : Number(parsed.port);
  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname !== "/"
    || !validAdvertisedHostname(parsed.hostname)
    || (explicitPort !== null
      && (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65_535))) {
    throw new Error(ACTIVATION_FAILED);
  }
  return Object.freeze({
    issuerUrl: `${parsed.origin}/`,
    relayUrl: `wss://${parsed.host}/client`,
  });
}

function captureOptions(value: unknown): CapturedLocalDevelopmentOptions {
  if (value === null || typeof value !== "object") throw new Error(ACTIVATION_FAILED);
  let descriptors: PropertyDescriptorMap;
  let keys: PropertyKey[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw new Error(ACTIVATION_FAILED);
  }
  const required = ["port", "tlsKeyPath", "tlsCertificatePath"];
  if (keys.some((key) => typeof key !== "string"
    || ![...required, "advertisedOrigin"].includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new Error(ACTIVATION_FAILED);
  }
  if (keys.some((key) => !Object.hasOwn(descriptors[key as string], "value"))) {
    throw new Error(ACTIVATION_FAILED);
  }
  const port = descriptors.port.value;
  const tlsKeyPath = descriptors.tlsKeyPath.value;
  const tlsCertificatePath = descriptors.tlsCertificatePath.value;
  const advertisedOrigin = descriptors.advertisedOrigin?.value;
  if (!Number.isInteger(port) || port < 1 || port > 65_535
    || typeof tlsKeyPath !== "string" || tlsKeyPath.length === 0
    || typeof tlsCertificatePath !== "string" || tlsCertificatePath.length === 0
    || (advertisedOrigin !== undefined && typeof advertisedOrigin !== "string")) {
    throw new Error(ACTIVATION_FAILED);
  }
  const endpoints = captureRelayV2BrokerDevelopmentAdvertisedEndpoints(
    advertisedOrigin,
    port,
  );
  return Object.freeze({
    port,
    tlsKeyPath,
    tlsCertificatePath,
    issuerUrl: endpoints.issuerUrl,
    relayUrl: endpoints.relayUrl,
  });
}

/**
 * Explicit loopback-only developer activation. It reuses the canonical
 * shipping/composition/public lifecycle and substitutes only process-local
 * credential persistence, issuer keys, and a continuity test backend which is
 * not E0. Nothing here qualifies or changes either production deployment
 * source.
 */
export async function startRelayV2BrokerLocalDevelopment(
  optionsInput: unknown,
): Promise<RelayV2BrokerShippingRootHandle> {
  const options = captureOptions(optionsInput);
  const key = readRelayV2BrokerDevelopmentTlsFile(options.tlsKeyPath);
  let certificate: Buffer;
  try {
    certificate = readRelayV2BrokerDevelopmentTlsFile(options.tlsCertificatePath);
  } catch (error) {
    key.fill(0);
    throw error;
  }
  let tlsDisposed = false;
  const disposeTls = (): void => {
    if (tlsDisposed) return;
    tlsDisposed = true;
    key.fill(0);
    certificate.fill(0);
  };

  const keyring = createRelayV2IssuerKeyring({
    issuerId: "relay-v2-local-development-issuer",
    kid: "relay-v2-local-development-key",
    secretBase64url: randomBytes(32).toString("base64url"),
  });
  const profile = Object.freeze({
    configVersion: 1 as const,
    listen: Object.freeze({ host: LOOPBACK_HOST, port: options.port }),
    issuerUrl: options.issuerUrl,
    relayUrl: options.relayUrl,
    trustedHome: MEMORY_TRUSTED_HOME,
    tls: Object.freeze({
      keyReference: "local-development-tls-key",
      certificateReference: "local-development-tls-certificate",
    }),
    issuerKeyringReference: "local-development-memory-keyring",
    externalContinuity: Object.freeze({
      configVersion: 1 as const,
      endpoint: EXTERNAL_ENDPOINT,
      securityDomainId: "relay-v2-local-development",
      authenticationMode: "workload_identity" as const,
      credentialReference: "local-development-memory-credential",
      tlsTrustReference: "local-development-memory-trust",
      operationTimeoutMs: 5_000,
      maxPendingOperations: 4,
      namespaceBindings: Object.freeze([
        Object.freeze({
          namespace: "broker-credential.v1" as const,
          ownerBinding: "relay-v2-local-development-broker-owner",
          anchorId: BROKER_ANCHOR,
        }),
      ]),
    }),
  });
  const privilegedResolver = Object.freeze({
    resolveIssuerKeyring(reference: string) {
      if (reference !== profile.issuerKeyringReference) throw new Error(ACTIVATION_FAILED);
      return keyring;
    },
    resolveTlsMaterial(references: Readonly<{
      keyReference: string;
      certificateReference: string;
    }>) {
      if (tlsDisposed
        || references.keyReference !== profile.tls.keyReference
        || references.certificateReference !== profile.tls.certificateReference) {
        throw new Error(ACTIVATION_FAILED);
      }
      return Object.freeze({
        key,
        cert: certificate,
        dispose: disposeTls,
      });
    },
  });

  try {
    return await startRelayV2BrokerShippingRoot(profile, Object.freeze({
      privilegedResolver,
      externalContinuityAttemptProvider: localDevelopmentContinuityProvider(),
      nativeLoader: localDevelopmentLoader(),
    }));
  } finally {
    disposeTls();
  }
}
