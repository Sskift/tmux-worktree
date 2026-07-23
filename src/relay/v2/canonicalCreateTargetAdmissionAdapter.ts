import { createHash } from "node:crypto";
import { basename } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  parseCreateTargetObservationV1AdmitResponse,
  type CreateTargetObservationV1AdmitResponse,
} from "../../createTargetObservationV1.js";
import {
  parseRpcV2CreateResolvedWorktreeRequest,
  parseRpcV2CreateTerminalRequest,
  type RpcV2CreateResolvedWorktreeRequest,
  type RpcV2CreateTerminalRequest,
  type RpcV2CreateWorktreeRequest,
} from "../../rpcV2.js";
import type {
  CanonicalTerminalOwner,
} from "../../canonicalTerminalControlClient.js";
import {
  RelayV2CanonicalCommandExecutorAdapter,
  type RelayV2CanonicalTerminalControlExecutionPort,
  type RelayV2StructuredProcessPort,
  type RelayV2StructuredProcessRequest,
  type RelayV2StructuredProcessResult,
} from "./canonicalCommandExecutorAdapter.js";
import {
  parseRelayV2CanonicalCreateTargetEvidenceV1,
  RelayV2CanonicalCommandTargetAuthorityAdapter,
  requireSynchronous,
  type RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
  type RelayV2CanonicalCreateTargetAuthorityInputV1,
  type RelayV2CanonicalCreateTargetAuthorityPortV1,
} from "./canonicalCommandTargetAuthorityAdapter.js";
import type {
  RelayV2ExactTerminalControlTargetPortV1,
} from "./canonicalTerminalTargetResolverAdapter.js";
import {
  RelayV2HostCommandPlane,
  type RelayV2CommandResourceMutationOwner,
  type RelayV2HostCommandPlaneReadinessCandidate,
} from "./hostCommandPlane.js";
import type { RelayV2HostStateStore } from "./hostState.js";
import type { RelayV2CanonicalResourceResolverPort } from "./resourceState.js";
import {
  asObservationFailure,
  bounded,
  canonicalJson,
  clone,
  collectRelayV2CanonicalObservationProcess,
  dataRecord,
  hasExactKeys,
  normalizeInvocation,
  normalizeProcessHandle,
  ownDataSnapshot,
  ownDataStringArray,
  RelayV2CanonicalCreateTargetObservationAuthority,
  RelayV2CanonicalCreateTargetObservationError,
  type RelayV2CanonicalCreateTargetAdmissionLookupPortV1,
} from "./canonicalCreateTargetObservationAuthority.js";
import {
  RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDERR_BYTES,
  RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDOUT_BYTES,
  RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_TIMEOUT_MS,
} from "./canonicalStructuredProcessAdapter.js";
import type {
  RelayV2CanonicalCreateTargetAuthorityBundleV1,
  RelayV2CanonicalProcessTargetClaimPortV1,
  RelayV2CanonicalProcessTargetClaimV1,
  RelayV2CanonicalStructuredProcessInvocation,
  RelayV2CanonicalTwRpcQueryProcessHandle,
  RelayV2CanonicalTwRpcQueryProcessRunner,
} from "./canonicalTwRpcQueryTransportAdapter.js";
import {
  openRelayV2CanonicalCreateTargetAuthorityBundleV1,
} from "./canonicalTwRpcQueryTransportAdapter.js";
import type {
  RelayV2CanonicalStructuredProcessTargetLookupPort,
} from "./canonicalStructuredProcessAdapter.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
} from "./strictJson.js";

const RESPONSE_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 64,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
});
const REQUEST_JSON_MAX_BYTES = 65_536;
const MAX_PENDING_CREATE_TARGET_CLAIMS = 64;

declare const createTargetExecutionPairBrand: unique symbol;

/**
 * Opaque required create target execution pair: a frozen, null-prototype,
 * fieldless ticket. Its module-private registry entry holds the exact
 * captured pieces of one issuance — one observation store, the bundled claim
 * port and live targets lookup of one exact owner bundle, the captured
 * runner, and the sealed inner rpc-v2 lane — from which the one-shot H1
 * factory later constructs the private claim wrapper and private admission
 * adapter in the same closure, so external code can neither construct nor
 * disassemble the components. `{}` cannot express it at the type level; a
 * foreign, fabricated, or already-captured pair fails closed at capture
 * time, before any lookup, claim consume, catalog fence, admitted access,
 * or spawn.
 */
export interface RelayV2CanonicalCreateTargetExecutionPairV1 {
  readonly [createTargetExecutionPairBrand]: void;
}

/** Narrow issuance port of the single canonical query transport owner. */
export interface RelayV2CanonicalCreateTargetExecutionPairOwnerPortV1 {
  issueCreateTargetAuthorityBundleV1(): RelayV2CanonicalCreateTargetAuthorityBundleV1;
}

export interface RelayV2CanonicalCreateTargetExecutionPairOptionsV1 {
  /** The single canonical query transport owner whose bundle is opened inside the issuance. */
  owner: RelayV2CanonicalCreateTargetExecutionPairOwnerPortV1;
  /** The child-process runner shared by observation and admission. */
  runner: RelayV2CanonicalTwRpcQueryProcessRunner;
  /** Delegates every non-create operation to the existing rpc-v2 lane. */
  inner: RelayV2StructuredProcessPort;
  timeoutMs?: number;
  now?: () => number;
}

export interface RelayV2CanonicalCreateTargetH1FactoryInputV1 {
  readonly store: RelayV2HostStateStore;
  readonly hostId: string;
  readonly resourceResolver: RelayV2CanonicalResourceResolverPort;
  readonly exactTerminalTarget: RelayV2ExactTerminalControlTargetPortV1;
  readonly commandTerminal: RelayV2CanonicalTerminalControlExecutionPort;
  readonly terminalOwner: CanonicalTerminalOwner & { kind: "relay-v2" };
  readonly resourceMutationOwner: RelayV2CommandResourceMutationOwner;
}

/**
 * One-shot lexical closure captured from an execution pair: it assembles the
 * canonical command target resolver and command executor around the pair's
 * sealed components and opens the recovered H1 authority in the same call,
 * returning only the opaque readiness candidate. The pair's components are
 * never exposed.
 */
export type RelayV2CanonicalCreateTargetH1FactoryV1 = (
  input: RelayV2CanonicalCreateTargetH1FactoryInputV1,
) => Promise<RelayV2HostCommandPlaneReadinessCandidate | null>;

interface ExecutionPairRecord {
  readonly observationAuthority: RelayV2CanonicalCreateTargetObservationAuthority;
  readonly claims: RelayV2CanonicalProcessTargetClaimPortV1;
  readonly targets: RelayV2CanonicalStructuredProcessTargetLookupPort;
  readonly runner: RelayV2CanonicalTwRpcQueryProcessRunner;
  readonly inner: RelayV2StructuredProcessPort;
}

/**
 * Module-private one-shot registry binding each issued opaque pair to the
 * exact captured pieces the one-shot H1 factory assembles its private
 * components from.
 */
const executionPairComponents = new WeakMap<object, ExecutionPairRecord>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One-time exact own-data capture of a foreign options record: plain,
 * non-Proxy, exactly the expected string keys (no accessor, symbol, or
 * non-enumerable extra), each value read exactly once from its descriptor.
 * Nothing re-reads the foreign record afterwards, so enumerable getters or
 * Proxies cannot swap values between reads.
 */
function captureExactData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value) || nodeTypes.isProxy(value)) {
    throw new TypeError("canonical create target options are malformed");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical create target options are malformed");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !keys.includes(key))) {
    throw new TypeError("canonical create target options are malformed");
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key as string);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
      throw new TypeError("canonical create target options are malformed");
    }
    out[key as string] = descriptor.value;
  }
  return Object.freeze(out);
}

interface CapturedMethod {
  readonly receiver: object;
  readonly method: (...args: never[]) => unknown;
}

/**
 * Captures one method exactly once against its original receiver: the
 * prototype-chain walk rejects Proxies at every level and reads the
 * descriptor once; the method must be a plain data function.
 */
function captureDataMethod(value: unknown, key: string, label: string): CapturedMethod {
  if (!isRecord(value) && typeof value !== "function") {
    throw new TypeError(`canonical create target ${label} is malformed`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError(`canonical create target ${label} is malformed`);
  }
  let holder: object | null = value as object;
  for (;;) {
    if (holder === null || nodeTypes.isProxy(holder)) {
      throw new TypeError(`canonical create target ${label} is malformed`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function"
        || nodeTypes.isProxy(descriptor.value)) {
        throw new TypeError(`canonical create target ${label} is malformed`);
      }
      return Object.freeze({
        receiver: value as object,
        method: descriptor.value as (...args: never[]) => unknown,
      });
    }
    holder = Object.getPrototypeOf(holder);
  }
}

function boundedLimit(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  return value as number;
}

interface CreateTargetClaimBinding {
  operation: "create_worktree" | "create_terminal";
  kind: "local" | "ssh";
  targetId: string;
}

function createClaimBinding(value: unknown): CreateTargetClaimBinding {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "request", "resourceTarget"])
    || value.schemaVersion !== 1
    || !isRecord(value.request)
    || (value.request.operation !== "create_worktree"
      && value.request.operation !== "create_terminal")
    || !isRecord(value.resourceTarget)
    || !isRecord(value.resourceTarget.processTarget)
    || !hasExactKeys(value.resourceTarget.processTarget, ["kind", "targetId"])
    || (value.resourceTarget.processTarget.kind !== "local"
      && value.resourceTarget.processTarget.kind !== "ssh")) {
    throw new TypeError("canonical create target claim input is malformed");
  }
  return {
    operation: value.request.operation,
    kind: value.resourceTarget.processTarget.kind,
    targetId: bounded(value.resourceTarget.processTarget.targetId),
  };
}

function createClaimKey(
  input: RelayV2CanonicalCreateTargetAuthorityInputV1,
  evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
): string {
  return createHash("sha256")
    .update(canonicalJson({ input, evidence }), "utf8")
    .digest("base64url");
}

/**
 * Private claim/observation wrapper, constructible only inside the one-shot
 * H1 factory below. Every resolve binds the observed evidence field by field to
 * the request, the H2 resourceTarget, the operation, and one opaque one-shot
 * claim issued by the same-owner config process-target generation owner for
 * that exact kind+targetId; the admission fence synchronously and atomically
 * consumes the claim before delegating to the observation authority's catalog
 * fence. No public constructor, no v1 fallback, no capability advertisement.
 */
class CreateTargetClaimWrapper implements RelayV2CanonicalCreateTargetAuthorityPortV1 {
  private readonly authority: RelayV2CanonicalCreateTargetAuthorityPortV1;

  private readonly claims: RelayV2CanonicalProcessTargetClaimPortV1;

  private readonly pending = new Map<string, RelayV2CanonicalProcessTargetClaimV1>();

  constructor(
    authority: RelayV2CanonicalCreateTargetAuthorityPortV1,
    claims: RelayV2CanonicalProcessTargetClaimPortV1,
  ) {
    this.authority = authority;
    this.claims = claims;
  }

  async resolveCreateTarget(
    rawInput: RelayV2CanonicalCreateTargetAuthorityInputV1,
  ): Promise<RelayV2CanonicalCreateTargetAuthorityEvidenceV1> {
    const binding = createClaimBinding(rawInput);
    const claim = this.claims.issueProcessTargetClaim(binding.kind, binding.targetId);
    let evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1;
    try {
      evidence = parseRelayV2CanonicalCreateTargetEvidenceV1(
        await this.authority.resolveCreateTarget(clone(rawInput)),
        binding.operation,
      );
    } catch (error) {
      try {
        this.claims.consumeProcessTargetClaim(claim, binding.kind, binding.targetId);
      } catch {}
      throw error;
    }
    const key = createClaimKey(rawInput, evidence);
    if (this.pending.size >= MAX_PENDING_CREATE_TARGET_CLAIMS) {
      this.pending.delete(this.pending.keys().next().value as string);
    }
    this.pending.set(key, claim);
    return evidence;
  }

  fenceCreateTargetForAdmission(
    rawInput: RelayV2CanonicalCreateTargetAuthorityInputV1,
    rawEvidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
  ): void {
    const binding = createClaimBinding(rawInput);
    const evidence = parseRelayV2CanonicalCreateTargetEvidenceV1(rawEvidence, binding.operation);
    const key = createClaimKey(rawInput, evidence);
    const claim = this.pending.get(key);
    if (claim === undefined) {
      throw new TypeError("canonical create target claim is missing or already consumed");
    }
    this.pending.delete(key);
    this.claims.consumeProcessTargetClaim(claim, binding.kind, binding.targetId);
    const result = this.authority.fenceCreateTargetForAdmission(
      clone(rawInput),
      clone(evidence),
    );
    requireSynchronous(result, "canonical create target catalog fence");
  }
}

interface NormalizedCreateRequest {
  operation: "create_worktree" | "create_terminal";
  kind: "local" | "ssh";
  targetId: string;
  arguments: RpcV2CreateWorktreeRequest["arguments"] | RpcV2CreateTerminalRequest["arguments"];
  execution: RpcV2CreateResolvedWorktreeRequest["execution"] | {
    canonicalCwd: string;
    publicDisplayName: string;
  };
  reservationCorrelation: RpcV2CreateResolvedWorktreeRequest["reservationCorrelation"];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

function createRpcOperation(
  operation: "create_worktree" | "create_terminal",
): "create-worktree-resolved" | "create-terminal" {
  return operation === "create_worktree" ? "create-worktree-resolved" : "create-terminal";
}

function createOperationFor(rpcOperation: string): "create_worktree" | "create_terminal" {
  return rpcOperation === "create-worktree-resolved" ? "create_worktree" : "create_terminal";
}

function staleFrame(operation: "create_worktree" | "create_terminal"): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    protocolVersion: 2,
    operation: createRpcOperation(operation),
    state: "failed",
    sideEffect: "not_applied",
    error: {
      code: "CREATE_FAILED",
      message: "create target catalog observation is stale (OBSERVATION_STALE)",
    },
  })}\n`);
}

/**
 * Private create-mutation lane, constructible only inside the one-shot H1
 * factory below: routes create_worktree/create_terminal mutations through the
 * companion `create-target-observation-v1` admit phase instead of
 * `rpc-v2 create-worktree-resolved`/`create-terminal`. The admit request is
 * built from exactly one admitted observation row — keyed by its opaque
 * authority token and consumed by the exact evidence identity (operation,
 * arguments, closed execution, and the reservation correlation carrying the
 * fenced command fingerprint) — plus the executor's correlated rpc-v2
 * request, and invoked on the pair's live target lookup and runner. Every
 * other operation delegates untouched to the pair's sealed inner rpc-v2
 * lane. A stale admit maps to a proved not_applied failure frame; transport
 * failures fail closed as uncertain. No retry, no v1 fallback, no capability
 * advertisement.
 */
class CreateTargetAdmissionAdapter implements RelayV2StructuredProcessPort {
  private readonly targets: RelayV2CanonicalStructuredProcessTargetLookupPort;

  private readonly runner: RelayV2CanonicalTwRpcQueryProcessRunner;

  private readonly observations: RelayV2CanonicalCreateTargetAdmissionLookupPortV1;

  private readonly inner: RelayV2StructuredProcessPort;

  constructor(
    targets: RelayV2CanonicalStructuredProcessTargetLookupPort,
    runner: RelayV2CanonicalTwRpcQueryProcessRunner,
    observations: RelayV2CanonicalCreateTargetAdmissionLookupPortV1,
    inner: RelayV2StructuredProcessPort,
  ) {
    this.targets = targets;
    this.runner = runner;
    this.observations = observations;
    this.inner = inner;
  }

  private normalizeCreateRequest(snapshot: unknown): NormalizedCreateRequest | null {
    const request = dataRecord(snapshot, [
      "target", "executable", "argv", "stdin", "timeoutMs",
      "maxStdoutBytes", "maxStderrBytes", "maxResponseFrameBytes",
    ]);
    if (request.executable !== "tw"
      || request.stdin !== null
      || !Array.isArray(request.argv)
      || request.argv.length !== 4
      || request.argv[0] !== "rpc-v2"
      || (request.argv[1] !== "create-worktree-resolved" && request.argv[1] !== "create-terminal")
      || request.argv[2] !== "--request-json"
      || typeof request.argv[3] !== "string") {
      return null;
    }
    const argv = ownDataStringArray(request.argv);
    if (Buffer.byteLength(argv[3], "utf8") > REQUEST_JSON_MAX_BYTES) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    const timeoutMs = boundedLimit(
      request.timeoutMs,
      RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_TIMEOUT_MS,
    );
    const maxStdoutBytes = boundedLimit(
      request.maxStdoutBytes,
      RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDOUT_BYTES,
    );
    const maxStderrBytes = boundedLimit(
      request.maxStderrBytes,
      RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDERR_BYTES,
    );
    boundedLimit(request.maxResponseFrameBytes, RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDOUT_BYTES);
    const target = dataRecord(request.target, ["kind", "scopeId", "targetId"]);
    if ((target.kind !== "local" && target.kind !== "ssh")) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    const targetId = bounded(target.targetId);
    const operation = createOperationFor(argv[1]);
    const parsed = parseRelayV2JsonObject(argv[3], RESPONSE_JSON_LIMITS);
    if (operation === "create_worktree") {
      const rpcRequest = parseRpcV2CreateResolvedWorktreeRequest(parsed);
      return {
        operation,
        kind: target.kind,
        targetId,
        arguments: rpcRequest.arguments,
        execution: rpcRequest.execution,
        reservationCorrelation: rpcRequest.reservationCorrelation,
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
      };
    }
    const rpcRequest = parseRpcV2CreateTerminalRequest(parsed);
    const publicDisplayName = rpcRequest.arguments.label
      ?? (basename(rpcRequest.arguments.cwd) || "Terminal");
    return {
      operation,
      kind: target.kind,
      targetId,
      arguments: rpcRequest.arguments,
      execution: { canonicalCwd: rpcRequest.arguments.cwd, publicDisplayName },
      reservationCorrelation: rpcRequest.reservationCorrelation,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    };
  }

  async execute(rawRequest: RelayV2StructuredProcessRequest): Promise<RelayV2StructuredProcessResult> {
    const startedAt = Date.now();
    let request: NormalizedCreateRequest | null;
    try {
      // One deep own-data snapshot of the foreign request; every create-lane
      // read below touches only this private copy. A non-create request
      // delegates with the original value, exactly as the inner lane
      // receives it today.
      const snapshot = ownDataSnapshot(rawRequest);
      request = this.normalizeCreateRequest(snapshot);
    } catch (error) {
      throw asObservationFailure(error);
    }
    if (request === null) {
      return this.inner.execute(rawRequest);
    }

    // The admit consumes exactly one admitted row of this pair's own store by
    // its exact evidence identity; an unknown, replayed, or foreign binding
    // fails closed before any target lookup or process spawn.
    const catalogRevision = this.observations.consumeAdmittedCatalogRevision({
      operation: request.operation,
      arguments: request.arguments,
      execution: request.execution,
      reservationCorrelation: request.reservationCorrelation,
    });
    const admitRequest = {
      schemaVersion: 1 as const,
      mode: "admit" as const,
      operation: request.operation,
      arguments: request.arguments,
      observation: { catalogRevision, execution: request.execution },
      reservationCorrelation: request.reservationCorrelation,
    };
    let invocation: RelayV2CanonicalStructuredProcessInvocation;
    try {
      invocation = normalizeInvocation(this.targets.structuredProcessInvocation(
        request.kind,
        request.targetId,
        ["create-target-observation-v1", "--request-json", JSON.stringify(admitRequest)],
        request.timeoutMs,
      ));
    } catch (error) {
      throw asObservationFailure(error);
    }
    let handle: RelayV2CanonicalTwRpcQueryProcessHandle;
    try {
      handle = normalizeProcessHandle(this.runner.spawn(Object.freeze({
        executable: invocation.executable,
        argv: invocation.argv,
        shell: false as const,
        stdin: "ignore" as const,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
      })));
    } catch {
      return {
        kind: "spawn_failed",
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        elapsedMs: 0,
      };
    }
    const result = await collectRelayV2CanonicalObservationProcess(
      handle,
      request.timeoutMs,
      request.maxStdoutBytes,
      request.maxStderrBytes,
    );
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const text = decodeRelayV2StrictUtf8(result.stdout);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    let response: CreateTargetObservationV1AdmitResponse;
    try {
      response = parseCreateTargetObservationV1AdmitResponse(
        parseRelayV2JsonObject(text.slice(0, -1), RESPONSE_JSON_LIMITS),
        request.operation,
      );
    } catch {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    const frame = response.state === "stale"
      ? staleFrame(request.operation)
      : new TextEncoder().encode(`${JSON.stringify(response.response)}\n`);
    return {
      kind: "exited",
      exitCode: 0,
      signal: null,
      stdout: frame,
      stderr: new Uint8Array(),
      elapsedMs,
    };
  }
}

/**
 * One-shot issuance of the frozen opaque create target execution pair. Every
 * option is captured exactly once from its own-data descriptor (accessor,
 * Proxy, symbol, or non-enumerable extras fail closed before anything is
 * read twice), the owner's same-owner bundle is opened inside this call, and
 * exactly one observation authority/store is constructed on the bundled live
 * lookup and the captured runner. The private claim wrapper and private
 * admission adapter are constructed later, inside the one-shot H1 factory,
 * over this same store, the bundled claim port, the captured runner, and the
 * sealed inner rpc-v2 lane. Callers receive only the fieldless opaque pair;
 * the pieces are reachable exactly once, and only inside that factory, via
 * captureRelayV2CanonicalCreateTargetH1FactoryV1. A foreign owner or
 * fabricated bundle fails closed before any lookup or side effect.
 */
export function issueRelayV2CanonicalCreateTargetExecutionPairV1(
  options: RelayV2CanonicalCreateTargetExecutionPairOptionsV1,
): RelayV2CanonicalCreateTargetExecutionPairV1 {
  const captured = captureExactData(options, ["owner", "runner", "inner"], ["timeoutMs", "now"]);
  const issueBundle = captureDataMethod(captured.owner, "issueCreateTargetAuthorityBundleV1", "owner");
  const spawn = captureDataMethod(captured.runner, "spawn", "runner");
  const innerExecute = captureDataMethod(captured.inner, "execute", "inner lane");
  const runner: RelayV2CanonicalTwRpcQueryProcessRunner = Object.freeze({
    spawn: (request: Parameters<RelayV2CanonicalTwRpcQueryProcessRunner["spawn"]>[0]) => Reflect.apply(
      spawn.method,
      spawn.receiver,
      [request],
    ) as RelayV2CanonicalTwRpcQueryProcessHandle,
  });
  const inner: RelayV2StructuredProcessPort = Object.freeze({
    execute: (request: RelayV2StructuredProcessRequest) => Reflect.apply(
      innerExecute.method,
      innerExecute.receiver,
      [request],
    ) as Promise<RelayV2StructuredProcessResult>,
  });
  const opened = openRelayV2CanonicalCreateTargetAuthorityBundleV1(
    Reflect.apply(issueBundle.method, issueBundle.receiver, []) as
      RelayV2CanonicalCreateTargetAuthorityBundleV1,
  );
  if (!isRecord(opened.targets)
    || typeof opened.targets.structuredProcessInvocation !== "function"
    || !isRecord(opened.claims)
    || typeof opened.claims.issueProcessTargetClaim !== "function"
    || typeof opened.claims.consumeProcessTargetClaim !== "function") {
    throw new TypeError("invalid canonical create target execution pair owner");
  }
  const timeoutMs = captured.timeoutMs;
  if (timeoutMs !== undefined
    && (!Number.isSafeInteger(timeoutMs)
      || (timeoutMs as number) < 1
      || (timeoutMs as number) > 600_000)) {
    throw new TypeError("invalid canonical create target execution pair timeout");
  }
  if (captured.now !== undefined && typeof captured.now !== "function") {
    throw new TypeError("invalid canonical create target execution pair clock");
  }
  const record: ExecutionPairRecord = Object.freeze({
    observationAuthority: new RelayV2CanonicalCreateTargetObservationAuthority({
      targets: opened.targets,
      runner,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
      ...(captured.now !== undefined ? { now: captured.now as () => number } : {}),
    }),
    claims: opened.claims,
    targets: opened.targets,
    runner,
    inner,
  });
  const pair = Object.freeze(Object.create(null)) as RelayV2CanonicalCreateTargetExecutionPairV1;
  executionPairComponents.set(pair as object, record);
  return pair;
}

/**
 * Synchronous, exactly-once capture of an issued execution pair as its
 * one-shot H1 factory closure. The first capture removes the pair's registry
 * entry; a replay, foreign, fabricated, or structurally cloned pair fails
 * closed here, before any lookup, claim consume, catalog fence, admitted
 * access, or spawn can be reached through it. The returned closure itself
 * fires exactly once: it assembles the canonical command target resolver and
 * command executor around the pair's sealed components and opens the
 * recovered H1 authority in the same call, returning only the opaque
 * readiness candidate.
 */
export function captureRelayV2CanonicalCreateTargetH1FactoryV1(
  pair: RelayV2CanonicalCreateTargetExecutionPairV1,
): RelayV2CanonicalCreateTargetH1FactoryV1 {
  if (pair === null || typeof pair !== "object") {
    throw new TypeError("canonical create target execution pair is malformed");
  }
  const record = executionPairComponents.get(pair as object);
  if (record === undefined) {
    throw new TypeError(
      "canonical create target execution pair is foreign, fabricated, or already captured",
    );
  }
  executionPairComponents.delete(pair as object);
  let consumed = false;
  const factory: RelayV2CanonicalCreateTargetH1FactoryV1 = (rawInput) => {
    if (consumed) {
      throw new TypeError("canonical create target H1 factory is already consumed");
    }
    consumed = true;
    // One-time exact own-data capture; accessors, Proxies, or extra keys fail
    // closed before any port is read twice or swapped between reads.
    const input = captureExactData(rawInput, [
      "store", "hostId", "resourceResolver", "exactTerminalTarget",
      "commandTerminal", "terminalOwner", "resourceMutationOwner",
    ]);
    if (typeof input.hostId !== "string") {
      throw new TypeError("invalid canonical create target H1 factory input");
    }
    // The private components are constructed only here, inside the one-shot
    // factory, over the pair's same captured pieces.
    const commandTargets = new RelayV2CanonicalCommandTargetAuthorityAdapter({
      resourceResolver: input.resourceResolver as RelayV2CanonicalResourceResolverPort,
      createTargetAuthority: new CreateTargetClaimWrapper(
        record.observationAuthority,
        record.claims,
      ),
      exactTerminalTarget: input.exactTerminalTarget as RelayV2ExactTerminalControlTargetPortV1,
    });
    const executor = new RelayV2CanonicalCommandExecutorAdapter({
      resolver: commandTargets,
      process: new CreateTargetAdmissionAdapter(
        record.targets,
        record.runner,
        record.observationAuthority,
        record.inner,
      ),
      terminalControl: input.commandTerminal as RelayV2CanonicalTerminalControlExecutionPort,
      terminalOwner: input.terminalOwner as CanonicalTerminalOwner & { kind: "relay-v2" },
    });
    return RelayV2HostCommandPlane.openRecoveredAuthority({
      store: input.store as RelayV2HostStateStore,
      hostId: input.hostId,
      executor,
      resourceMutationOwner: input.resourceMutationOwner as RelayV2CommandResourceMutationOwner,
    });
  };
  return Object.freeze(factory);
}
