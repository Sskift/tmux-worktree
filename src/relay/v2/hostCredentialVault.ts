import { createHash, timingSafeEqual } from "node:crypto";
import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";
import {
  decodeRelayV2HostCredentialState,
  RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE,
  type RelayV2HostCredentialSecretResolver,
  type RelayV2HostCredentialState,
  type RelayV2HostCredentialStorage,
  type RelayV2HostCredentialStorageCasResult,
  type RelayV2HostCredentialStorageRead,
  type RelayV2HostCredentialStorageRevision,
  type RelayV2HostCredentialStorageTransaction,
} from "./hostCredentialAuthority.js";
import { isRelayV2AuthIdentifier } from "./token.js";

const ENVELOPE_MAGIC = Buffer.from("tw-hcv1\0", "ascii");
const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.byteLength + 4 + 32;
export const RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES = 65_536;
const MAX_ENVELOPE_BYTES = RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES;
const MAX_SECRET_BYTES = 8_192;
const MAX_PROVISION_CONFLICTS = 4;

type JsonObject = Record<string, unknown>;

/** Opaque to the vault; only the atomic byte cell may interpret it. */
export type RelayV2HostCredentialAtomicByteCellRevision = unknown;

export interface RelayV2HostCredentialAtomicByteCellRead {
  readonly bytes: Uint8Array | null;
  readonly revision: RelayV2HostCredentialAtomicByteCellRevision;
}

export type RelayV2HostCredentialAtomicByteCellCasResult =
  | { readonly status: "swapped" }
  | { readonly status: "conflict"; readonly current: RelayV2HostCredentialAtomicByteCellRead }
  | { readonly status: "uncertain" };

export interface RelayV2HostCredentialAtomicByteCellTransaction {
  read(): RelayV2HostCredentialAtomicByteCellRead;
  compareAndSwap(
    expected: RelayV2HostCredentialAtomicByteCellRevision,
    replacement: Uint8Array,
  ): RelayV2HostCredentialAtomicByteCellCasResult;
}

/**
 * Single-cell, synchronously serialized byte storage. Revisions are opaque and
 * CAS uncertainty never means success.
 */
export interface RelayV2HostCredentialAtomicByteCell {
  runExclusive<T>(
    operation: (transaction: RelayV2HostCredentialAtomicByteCellTransaction) => T,
  ): T;
}

declare const RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE: unique symbol;

/** Opaque, source-owned, read-once bootstrap-secret handoff candidate. */
export interface RelayV2HostBootstrapSecretHandoffCandidate {
  readonly [RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE]: never;
}

/**
 * The source rejects foreign/replayed candidates before the callback, invokes
 * the callback synchronously, and commits consumption only after the callback
 * returns normally. A callback throw leaves the candidate retryable.
 */
export interface RelayV2HostBootstrapSecretHandoff {
  runWithCandidate<T>(
    candidate: RelayV2HostBootstrapSecretHandoffCandidate,
    operation: (bootstrapSecret: string) => T,
  ): T;
}

export interface RelayV2HostCredentialVaultOptions {
  readonly hostId: string;
  readonly credentialReference: string;
  readonly bootstrapSecretReference: string;
  readonly refreshSecretReference: string;
  readonly cell: RelayV2HostCredentialAtomicByteCell;
  readonly bootstrapSecretHandoff: RelayV2HostBootstrapSecretHandoff;
}

export type RelayV2HostCredentialVaultErrorCode =
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_INVALID_OPTIONS"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_FOREIGN_REFERENCE"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_CAS_CONFLICT"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_HANDOFF_INVALID"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_SECRET_UNAVAILABLE"
  | "RELAY_V2_HOST_CREDENTIAL_VAULT_CLOSED";

export class RelayV2HostCredentialVaultError extends Error {
  constructor(readonly code: RelayV2HostCredentialVaultErrorCode) {
    super(messageForCode(code));
    this.name = "RelayV2HostCredentialVaultError";
  }
}

interface VaultBinding {
  hostId: string;
  credentialReference: string;
  bootstrapSecretReference: string;
  refreshSecretReference: string;
}

interface VaultEnvelope {
  credentialState: RelayV2HostCredentialState | null;
  bootstrapSecret: string | null;
  refreshSecret: string | null;
}

interface VaultRevisionRecord {
  owner: RelayV2HostCredentialVault;
  transaction: object;
  rawRevision: RelayV2HostCredentialAtomicByteCellRevision;
  envelope: VaultEnvelope;
  consumed: boolean;
}

const vaultRevisions = new WeakMap<object, VaultRevisionRecord>();

function fail(code: RelayV2HostCredentialVaultErrorCode): never {
  throw new RelayV2HostCredentialVaultError(code);
}

function messageForCode(code: RelayV2HostCredentialVaultErrorCode): string {
  switch (code) {
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_INVALID_OPTIONS":
      return "Relay v2 host credential vault options are invalid";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_FOREIGN_REFERENCE":
      return "Relay v2 host credential vault reference is foreign";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID":
      return "Relay v2 host credential vault state is invalid";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE":
      return "Relay v2 host credential vault backend is unavailable";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN":
      return "Relay v2 host credential vault commit is uncertain";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_CAS_CONFLICT":
      return "Relay v2 host credential vault could not settle bounded CAS conflicts";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_HANDOFF_INVALID":
      return "Relay v2 host credential bootstrap handoff is invalid";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED":
      return "Relay v2 host credential bootstrap slot is already provisioned";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_SECRET_UNAVAILABLE":
      return "Relay v2 host credential vault secret is unavailable";
    case "RELAY_V2_HOST_CREDENTIAL_VAULT_CLOSED":
      return "Relay v2 host credential vault is closed";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, fields: readonly string[]): boolean {
  const expected = new Set(fields);
  return fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => expected.has(field));
}

function isCredentialReference(value: unknown): value is string {
  if (typeof value !== "string"
    || !value.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || Buffer.byteLength(value, "utf8") > 128) return false;
  const identifier = value.slice(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)
    && !/^(?:twcap2|twref2|twenroll2|twhostboot2)\./.test(identifier);
}

function isSecretReference(value: unknown): value is string {
  return isRelayV2AuthIdentifier(value)
    && !/^(?:twcap2|twref2|twenroll2|twhostboot2)\./.test(value);
}

function isSecret(value: unknown, prefix: "twhostboot2." | "twref2."): value is string {
  return typeof value === "string"
    && value.startsWith(prefix)
    && Buffer.byteLength(value, "utf8") <= MAX_SECRET_BYTES
    && /^[\x21-\x7e]+$/.test(value);
}

function decodeCredentialState(
  value: unknown,
  binding: VaultBinding,
): RelayV2HostCredentialState | null {
  if (value === null) return null;
  try {
    const state = decodeRelayV2HostCredentialState(
      value,
      binding.credentialReference,
    );
    if (state.hostId !== binding.hostId) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
    }
    return state;
  } catch {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
}

function emptyEnvelope(): VaultEnvelope {
  return { credentialState: null, bootstrapSecret: null, refreshSecret: null };
}

function validateEnvelopeInvariants(envelope: VaultEnvelope): VaultEnvelope {
  const state = envelope.credentialState;
  if (state === null) {
    if (envelope.refreshSecret !== null) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
    }
    return envelope;
  }
  if (state.credentialVersion === "0") {
    if (envelope.bootstrapSecret === null
      || envelope.refreshSecret !== null
      || state.refreshToken !== null) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
    }
    return envelope;
  }
  if (envelope.bootstrapSecret !== null
    || typeof state.refreshToken !== "string"
    || envelope.refreshSecret !== state.refreshToken) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  return envelope;
}

function encodeEnvelope(envelope: VaultEnvelope, binding: VaultBinding): Uint8Array {
  const validated = validateEnvelopeInvariants(envelope);
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      binding,
      credentialState: validated.credentialState,
      secretSlots: {
        bootstrapSecret: validated.bootstrapSecret,
        refreshSecret: validated.refreshSecret,
      },
    }), "utf8");
  } catch {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  if (payload.byteLength + ENVELOPE_HEADER_BYTES > MAX_ENVELOPE_BYTES) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  const bytes = Buffer.allocUnsafe(ENVELOPE_HEADER_BYTES + payload.byteLength);
  ENVELOPE_MAGIC.copy(bytes, 0);
  bytes.writeUInt32BE(payload.byteLength, ENVELOPE_MAGIC.byteLength);
  createHash("sha256").update(payload).digest().copy(
    bytes,
    ENVELOPE_MAGIC.byteLength + 4,
  );
  payload.copy(bytes, ENVELOPE_HEADER_BYTES);
  return Uint8Array.from(bytes);
}

function decodeEnvelope(raw: Uint8Array | null, binding: VaultBinding): VaultEnvelope {
  if (raw === null) return emptyEnvelope();
  if (!(raw instanceof Uint8Array)
    || raw.byteLength < ENVELOPE_HEADER_BYTES
    || raw.byteLength > MAX_ENVELOPE_BYTES) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!timingSafeEqual(bytes.subarray(0, ENVELOPE_MAGIC.byteLength), ENVELOPE_MAGIC)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  const payloadLength = bytes.readUInt32BE(ENVELOPE_MAGIC.byteLength);
  if (payloadLength + ENVELOPE_HEADER_BYTES !== bytes.byteLength) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  const expectedDigest = bytes.subarray(
    ENVELOPE_MAGIC.byteLength + 4,
    ENVELOPE_HEADER_BYTES,
  );
  const payload = bytes.subarray(ENVELOPE_HEADER_BYTES);
  const actualDigest = createHash("sha256").update(payload).digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(payload), {
      maxDepth: 5,
      maxKeys: 64,
      maxNodes: 64,
    });
  } catch {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  if (!isRecord(parsed)
    || !exactKeys(parsed, ["schemaVersion", "binding", "credentialState", "secretSlots"])
    || parsed.schemaVersion !== 1
    || !isRecord(parsed.binding)
    || !exactKeys(parsed.binding, [
      "hostId", "credentialReference", "bootstrapSecretReference", "refreshSecretReference",
    ])
    || parsed.binding.hostId !== binding.hostId
    || parsed.binding.credentialReference !== binding.credentialReference
    || parsed.binding.bootstrapSecretReference !== binding.bootstrapSecretReference
    || parsed.binding.refreshSecretReference !== binding.refreshSecretReference
    || !isRecord(parsed.secretSlots)
    || !exactKeys(parsed.secretSlots, ["bootstrapSecret", "refreshSecret"])) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  const bootstrapSecret = parsed.secretSlots.bootstrapSecret;
  const refreshSecret = parsed.secretSlots.refreshSecret;
  if (bootstrapSecret !== null && !isSecret(bootstrapSecret, "twhostboot2.")) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  if (refreshSecret !== null && !isSecret(refreshSecret, "twref2.")) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  }
  return validateEnvelopeInvariants({
    credentialState: decodeCredentialState(parsed.credentialState, binding),
    bootstrapSecret,
    refreshSecret,
  });
}

function validateCellRead(value: unknown): RelayV2HostCredentialAtomicByteCellRead {
  try {
    if (!isRecord(value)
      || !exactKeys(value, ["bytes", "revision"])
      || (value.bytes !== null && !(value.bytes instanceof Uint8Array))) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
    }
    return {
      bytes: value.bytes === null ? null : Uint8Array.from(value.bytes),
      revision: value.revision,
    };
  } catch (error) {
    if (error instanceof RelayV2HostCredentialVaultError) throw error;
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
  }
}

function replacementEnvelope(
  current: VaultEnvelope,
  replacement: RelayV2HostCredentialState,
  binding: VaultBinding,
): VaultEnvelope {
  const state = decodeCredentialState(replacement, binding);
  if (state === null) return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID");
  if (state.credentialVersion === "0" && current.bootstrapSecret === null) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_SECRET_UNAVAILABLE");
  }
  return validateEnvelopeInvariants({
    credentialState: state,
    bootstrapSecret: state.credentialVersion === "0" ? current.bootstrapSecret : null,
    refreshSecret: state.credentialVersion === "0" ? null : state.refreshToken,
  });
}

/**
 * Single-profile owner for host credential state and both secret slots. It is
 * inert until provision/read/transaction is explicitly invoked and has no
 * filesystem, keychain, process, network, Dashboard, readiness, or fallback.
 */
export class RelayV2HostCredentialVault
implements RelayV2HostCredentialStorage, RelayV2HostCredentialSecretResolver {
  readonly #binding: VaultBinding;
  readonly #cell: RelayV2HostCredentialAtomicByteCell;
  readonly #bootstrapSecretHandoff: RelayV2HostBootstrapSecretHandoff;
  #lifecycle: "open" | "closing" | "closed" = "open";
  #admitted = 0;
  #drainPromise: Promise<void> | null = null;
  #resolveDrain: (() => void) | null = null;

  constructor(options: RelayV2HostCredentialVaultOptions) {
    if (!isRecord(options)
      || !exactKeys(options, [
        "hostId", "credentialReference", "bootstrapSecretReference",
        "refreshSecretReference", "cell", "bootstrapSecretHandoff",
      ])
      || !isRelayV2AuthIdentifier(options.hostId)
      || !isCredentialReference(options.credentialReference)
      || !isSecretReference(options.bootstrapSecretReference)
      || !isSecretReference(options.refreshSecretReference)
      || options.bootstrapSecretReference === options.refreshSecretReference
      || !isRecord(options.cell)
      || typeof options.cell.runExclusive !== "function"
      || !isRecord(options.bootstrapSecretHandoff)
      || typeof options.bootstrapSecretHandoff.runWithCandidate !== "function") {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_INVALID_OPTIONS");
    }
    this.#binding = Object.freeze({
      hostId: options.hostId,
      credentialReference: options.credentialReference,
      bootstrapSecretReference: options.bootstrapSecretReference,
      refreshSecretReference: options.refreshSecretReference,
    });
    this.#cell = options.cell;
    this.#bootstrapSecretHandoff = options.bootstrapSecretHandoff;
  }

  provisionBootstrap(candidate: RelayV2HostBootstrapSecretHandoffCandidate): void {
    return this.#admit(() => this.#withCell((transaction) => {
      let read = this.#cellRead(transaction);
      let current = decodeEnvelope(read.bytes, this.#binding);
      if (current.credentialState !== null
        || current.bootstrapSecret !== null
        || current.refreshSecret !== null) {
        return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED");
      }

      return this.#runWithBootstrapCandidate(candidate, (bootstrapSecret) => {
        for (let conflicts = 0; conflicts <= MAX_PROVISION_CONFLICTS; conflicts += 1) {
          const replacement = encodeEnvelope({
            credentialState: null,
            bootstrapSecret,
            refreshSecret: null,
          }, this.#binding);
          const result = this.#cellCompareAndSwap(transaction, read.revision, replacement);
          if (result.status === "swapped") return;
          if (result.status === "uncertain") {
            return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN");
          }
          if (conflicts === MAX_PROVISION_CONFLICTS) {
            return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_CAS_CONFLICT");
          }
          read = validateCellRead(result.current);
          current = decodeEnvelope(read.bytes, this.#binding);
          if (current.credentialState !== null
            || current.bootstrapSecret !== null
            || current.refreshSecret !== null) {
            return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED");
          }
        }
        return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_CAS_CONFLICT");
      });
    }));
  }

  runExclusive<T>(
    reference: string,
    operation: (transaction: RelayV2HostCredentialStorageTransaction) => T,
  ): T {
    if (reference !== this.#binding.credentialReference || typeof operation !== "function") {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_FOREIGN_REFERENCE");
    }
    return this.#admit(() => this.#withCell((rawTransaction) => {
      const transactionIdentity = Object.freeze(Object.create(null));
      let active = true;
      const transaction: RelayV2HostCredentialStorageTransaction = {
        read: () => {
          if (!active) return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
          return this.#storageRead(
            this.#cellRead(rawTransaction),
            transactionIdentity,
          );
        },
        compareAndSwap: (expected, replacement) => {
          if (!active) return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
          return this.#storageCompareAndSwap(
            rawTransaction,
            transactionIdentity,
            expected,
            replacement,
          );
        },
      };
      try {
        return operation(transaction);
      } finally {
        active = false;
      }
    }));
  }

  resolve(reference: string): string {
    if (reference !== this.#binding.bootstrapSecretReference
      && reference !== this.#binding.refreshSecretReference) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_FOREIGN_REFERENCE");
    }
    return this.#admit(() => this.#withCell((transaction) => {
      const read = this.#cellRead(transaction);
      const envelope = decodeEnvelope(read.bytes, this.#binding);
      const secret = reference === this.#binding.bootstrapSecretReference
        ? envelope.bootstrapSecret
        : envelope.refreshSecret;
      if (secret === null) return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_SECRET_UNAVAILABLE");
      return secret;
    }));
  }

  closeAndDrain(): Promise<void> {
    if (this.#drainPromise !== null) return this.#drainPromise;
    this.#lifecycle = "closing";
    this.#drainPromise = new Promise<void>((resolve) => {
      this.#resolveDrain = resolve;
    });
    this.#settleDrainIfReady();
    return this.#drainPromise;
  }

  #storageRead(
    rawRead: RelayV2HostCredentialAtomicByteCellRead,
    transaction: object,
  ): RelayV2HostCredentialStorageRead {
    const envelope = decodeEnvelope(rawRead.bytes, this.#binding);
    const revision = Object.freeze(Object.create(null)) as RelayV2HostCredentialStorageRevision;
    vaultRevisions.set(revision as object, {
      owner: this,
      transaction,
      rawRevision: rawRead.revision,
      envelope,
      consumed: false,
    });
    return {
      state: envelope.credentialState === null
        ? null
        : decodeCredentialState(envelope.credentialState, this.#binding),
      revision,
    };
  }

  #storageCompareAndSwap(
    transaction: RelayV2HostCredentialAtomicByteCellTransaction,
    transactionIdentity: object,
    expected: RelayV2HostCredentialStorageRevision,
    replacement: RelayV2HostCredentialState,
  ): RelayV2HostCredentialStorageCasResult {
    const record = typeof expected === "object" && expected !== null
      ? vaultRevisions.get(expected)
      : undefined;
    if (!record
      || record.owner !== this
      || record.transaction !== transactionIdentity
      || record.consumed) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
    }
    record.consumed = true;
    const envelope = replacementEnvelope(record.envelope, replacement, this.#binding);
    const result = this.#cellCompareAndSwap(
      transaction,
      record.rawRevision,
      encodeEnvelope(envelope, this.#binding),
    );
    if (result.status === "swapped" || result.status === "uncertain") return result;
    return {
      status: "conflict",
      current: this.#storageRead(validateCellRead(result.current), transactionIdentity),
    };
  }

  #cellCompareAndSwap(
    transaction: RelayV2HostCredentialAtomicByteCellTransaction,
    expected: RelayV2HostCredentialAtomicByteCellRevision,
    replacement: Uint8Array,
  ): RelayV2HostCredentialAtomicByteCellCasResult {
    let result: unknown;
    try {
      result = transaction.compareAndSwap(expected, Uint8Array.from(replacement));
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
    }
    try {
      if (!isRecord(result) || typeof result.status !== "string") {
        return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
      }
      if ((result.status === "swapped" || result.status === "uncertain")
        && exactKeys(result, ["status"])) return { status: result.status };
      if (result.status === "conflict"
        && exactKeys(result, ["status", "current"])) {
        return { status: "conflict", current: validateCellRead(result.current) };
      }
    } catch (error) {
      if (error instanceof RelayV2HostCredentialVaultError) throw error;
    }
    return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
  }

  #runWithBootstrapCandidate<T>(
    candidate: RelayV2HostBootstrapSecretHandoffCandidate,
    operation: (bootstrapSecret: string) => T,
  ): T {
    let active = true;
    let entered = 0;
    let callbackFailed = false;
    let callbackError: unknown;
    let result: T | undefined;
    let outerFailed = false;
    try {
      result = this.#bootstrapSecretHandoff.runWithCandidate(candidate, (secret) => {
        entered += 1;
        if (!active || entered !== 1 || !isSecret(secret, "twhostboot2.")) {
          return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_HANDOFF_INVALID");
        }
        try {
          return operation(secret);
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
          throw error;
        }
      });
    } catch {
      outerFailed = true;
    } finally {
      active = false;
    }
    if (callbackFailed) throw callbackError;
    if (outerFailed || entered !== 1) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_HANDOFF_INVALID");
    }
    return result as T;
  }

  #cellRead(
    transaction: RelayV2HostCredentialAtomicByteCellTransaction,
  ): RelayV2HostCredentialAtomicByteCellRead {
    let read: unknown;
    try {
      read = transaction.read();
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
    }
    return validateCellRead(read);
  }

  #withCell<T>(
    operation: (transaction: RelayV2HostCredentialAtomicByteCellTransaction) => T,
  ): T {
    let entered = 0;
    let callbackFailed = false;
    let callbackError: unknown;
    let result: T | undefined;
    let outerFailed = false;
    try {
      result = this.#cell.runExclusive((transaction) => {
        entered += 1;
        if (entered !== 1
          || !isRecord(transaction)
          || typeof transaction.read !== "function"
          || typeof transaction.compareAndSwap !== "function") {
          return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
        }
        try {
          return operation(transaction);
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
          throw error;
        }
      });
    } catch {
      outerFailed = true;
    }
    if (callbackFailed) throw callbackError;
    if (outerFailed || entered !== 1) {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE");
    }
    return result as T;
  }

  #admit<T>(operation: () => T): T {
    if (this.#lifecycle !== "open") {
      return fail("RELAY_V2_HOST_CREDENTIAL_VAULT_CLOSED");
    }
    this.#admitted += 1;
    try {
      return operation();
    } finally {
      this.#admitted -= 1;
      this.#settleDrainIfReady();
    }
  }

  #settleDrainIfReady(): void {
    if (this.#lifecycle !== "closing" || this.#admitted !== 0) return;
    this.#lifecycle = "closed";
    const resolve = this.#resolveDrain;
    this.#resolveDrain = null;
    resolve?.();
  }
}
