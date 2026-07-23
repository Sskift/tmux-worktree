import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, normalize, resolve } from "node:path";
import {
  canonicalWorktreePlacementSegment,
  parseCanonicalWorktreePlacement,
} from "./canonicalWorktreePlacement";
import {
  expandHomePath,
  loadConfigFile,
  resolveWorktreeBase,
  type Config,
  type ProjectConfig,
} from "./config";
import {
  executeRpcV2CreateResolvedWorktree,
  executeRpcV2CreateTerminal,
  parseRpcV2CreateResolvedWorktreeRequest,
  parseRpcV2CreateResponse,
  type RpcV2CreateResolvedWorktreeRequest,
  type RpcV2CreateResponse,
  type RpcV2CreateTerminalRequest,
  type RpcV2CreateWorktreeRequest,
} from "./rpcV2";
import { SESSION_NAME_MAX_LEN } from "./session";
import {
  normalizeManagedSessionReservationCorrelation,
  type ManagedSessionReservationCorrelationV1,
} from "./state";
import { gitQuery as defaultGitQuery } from "./tmux";
import { parseRelayV2JsonObject } from "./relay/v2/strictJson.js";

/**
 * Independent versioned companion ABI of frozen TW RPC v2 with two phases.
 * `observe`: the target host (local or reached over SSH by the canonical
 * transport owner) atomically observes the exact catalog/placement state a
 * create_worktree or create_terminal mutation would consume — the config
 * project, canonical realpaths, the canonical git-dir/common-dir identity,
 * and the exact resolved base-ref OID the mutation fetch would consume —
 * returning it under a deterministic content revision that digests all of
 * those inputs. `admit`: the same handler first re-observes the live catalog
 * in-process and exact-compares revision, arguments, and closed execution;
 * only on an exact match does it run the resolved mutation in the same
 * process, otherwise it fails closed as OBSERVATION_STALE with zero side
 * effects. The covered drift set is exactly the observation input set above
 * (base-ref OID and git identity drift included); the only remaining drift
 * window is the irreducible local TOCTOU between the in-process
 * re-observation and the mutation itself, identical to any local create.
 * Neither phase performs capability advertisement or fallback.
 */
export const CREATE_TARGET_OBSERVATION_V1_SCHEMA_VERSION = 1 as const;
export const CREATE_TARGET_OBSERVATION_V1_ENTRYPOINT = "create-target-observation-v1";
export const CREATE_TARGET_OBSERVATION_V1_REVISION_PREFIX = "twcat1.";
export const CREATE_TARGET_OBSERVATION_V1_REQUEST_MAX_BYTES = 65_536;

const CATALOG_REVISION_DOMAIN = "tmux-worktree/create-target-observation-v1/catalog-revision\0";
const SAFE_WORKTREE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 64,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
});

export interface CreateTargetObservationV1WorktreeRequest {
  schemaVersion: 1;
  mode?: "observe";
  operation: "create_worktree";
  arguments: RpcV2CreateWorktreeRequest["arguments"];
}

export interface CreateTargetObservationV1TerminalRequest {
  schemaVersion: 1;
  mode?: "observe";
  operation: "create_terminal";
  arguments: RpcV2CreateTerminalRequest["arguments"];
}

export type CreateTargetObservationV1Request =
  | CreateTargetObservationV1WorktreeRequest
  | CreateTargetObservationV1TerminalRequest;

/**
 * Closed-set git evidence of a worktree observation. `canonicalGitIdentity`
 * is a keyed digest of the realpathed git-dir and common-dir, stable across
 * local/SSH observation of the same target repository without exposing local
 * path details; `baseRefOid` is the exact remote OID the mutation fetch
 * would consume. Both enter the catalog revision digest, so any identity or
 * OID drift changes the revision.
 */
export interface CreateTargetObservationV1WorktreeCatalogEvidence {
  canonicalGitIdentity: string;
  baseRefOid: string;
}

export interface CreateTargetObservationV1WorktreeObservation {
  operation: "create_worktree";
  arguments: RpcV2CreateWorktreeRequest["arguments"];
  execution: RpcV2CreateResolvedWorktreeRequest["execution"];
  catalog: CreateTargetObservationV1WorktreeCatalogEvidence;
}

export interface CreateTargetObservationV1TerminalObservation {
  operation: "create_terminal";
  arguments: RpcV2CreateTerminalRequest["arguments"];
  execution: { canonicalCwd: string; publicDisplayName: string };
}

export interface CreateTargetObservationV1Response {
  schemaVersion: 1;
  catalogRevision: string;
  observation:
    | CreateTargetObservationV1WorktreeObservation
    | CreateTargetObservationV1TerminalObservation;
}

export interface CreateTargetObservationV1AdmitWorktreeRequest {
  schemaVersion: 1;
  mode: "admit";
  operation: "create_worktree";
  arguments: RpcV2CreateWorktreeRequest["arguments"];
  observation: {
    catalogRevision: string;
    execution: RpcV2CreateResolvedWorktreeRequest["execution"];
  };
  reservationCorrelation: ManagedSessionReservationCorrelationV1;
}

export interface CreateTargetObservationV1AdmitTerminalRequest {
  schemaVersion: 1;
  mode: "admit";
  operation: "create_terminal";
  arguments: RpcV2CreateTerminalRequest["arguments"];
  observation: {
    catalogRevision: string;
    execution: { canonicalCwd: string; publicDisplayName: string };
  };
  reservationCorrelation: ManagedSessionReservationCorrelationV1;
}

export type CreateTargetObservationV1AdmitRequest =
  | CreateTargetObservationV1AdmitWorktreeRequest
  | CreateTargetObservationV1AdmitTerminalRequest;

export type CreateTargetObservationV1AdmitResponse =
  | {
      schemaVersion: 1;
      mode: "admit";
      state: "stale";
      sideEffect: "not_applied";
      error: { code: "OBSERVATION_STALE"; message: string };
    }
  | {
      schemaVersion: 1;
      mode: "admit";
      state: "executed";
      response: RpcV2CreateResponse;
    };

export interface CreateTargetObservationV1Deps {
  loadConfig?: () => Config | null;
  existsSync?: (path: string) => boolean;
  realpathSync?: (path: string) => string;
  statSync?: (path: string) => { isDirectory(): boolean };
  gitQuery?: (repoDir: string, args: string[], timeout?: number) => string;
}

export interface CreateTargetAdmissionV1Deps extends CreateTargetObservationV1Deps {
  runResolvedWorktree?: (request: RpcV2CreateResolvedWorktreeRequest) => RpcV2CreateResponse;
  runTerminal?: (request: RpcV2CreateTerminalRequest) => RpcV2CreateResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`invalid create-target-observation ${label}`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  return boundedString(record[field], field, maxBytes);
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 4_096);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed) {
    throw new Error(`invalid create-target-observation ${label}`);
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

/** Fixed-shape probe; the parser only validates the correlation envelope. */
function probeReservationCorrelation() {
  return {
    schemaVersion: 1 as const,
    reservationId: "create-target-observation-v1",
    hostEpoch: "create-target-observation-v1",
    principalId: "create-target-observation-v1",
    hostId: "create-target-observation-v1",
    commandId: "create-target-observation-v1",
    requestFingerprint: {
      schemaVersion: 1 as const,
      algorithm: "sha256-rfc8785" as const,
      digest: "0".repeat(64),
    },
  };
}

function parseCatalogRevision(value: unknown): string {
  const catalogRevision = boundedString(value, "catalogRevision", 128);
  if (!catalogRevision.startsWith(CREATE_TARGET_OBSERVATION_V1_REVISION_PREFIX)
    || !/^[A-Za-z0-9_-]{43}$/.test(
      catalogRevision.slice(CREATE_TARGET_OBSERVATION_V1_REVISION_PREFIX.length),
    )) {
    throw new Error("invalid create-target-observation catalogRevision");
  }
  return catalogRevision;
}

function parseWorktreeArguments(
  value: unknown,
): RpcV2CreateWorktreeRequest["arguments"] {
  if (!isRecord(value) || !exactKeys(value, ["aiCommand"], ["project", "path", "name", "branch"])) {
    throw new Error("invalid create-target-observation create_worktree arguments");
  }
  const project = optionalString(value, "project", 128);
  const path = optionalString(value, "path", 4_096);
  if (!project && !path) {
    throw new Error("create-target-observation create_worktree requires project or path");
  }
  const name = optionalString(value, "name", 80);
  if (name && Array.from(name).length > SESSION_NAME_MAX_LEN) {
    throw new Error(`create-target-observation name exceeds ${SESSION_NAME_MAX_LEN} characters`);
  }
  const branch = optionalString(value, "branch", 255);
  const aiCommand = boundedString(value.aiCommand, "aiCommand", 4_096);
  return {
    ...(project ? { project } : {}),
    ...(path ? { path } : {}),
    ...(name ? { name } : {}),
    ...(branch ? { branch } : {}),
    aiCommand,
  };
}

function parseTerminalArguments(
  value: unknown,
): RpcV2CreateTerminalRequest["arguments"] {
  if (!isRecord(value) || !exactKeys(value, ["cwd"], ["label"])) {
    throw new Error("invalid create-target-observation create_terminal arguments");
  }
  const cwd = boundedString(value.cwd, "cwd", 4_096);
  const label = optionalString(value, "label", 128);
  return { cwd, ...(label ? { label } : {}) };
}

function parseTerminalExecution(
  value: unknown,
  args: RpcV2CreateTerminalRequest["arguments"],
): { canonicalCwd: string; publicDisplayName: string } {
  if (!isRecord(value) || !exactKeys(value, ["canonicalCwd", "publicDisplayName"])) {
    throw new Error("invalid create-target-observation terminal execution");
  }
  const canonicalCwd = normalizedAbsolutePath(value.canonicalCwd, "canonicalCwd");
  const publicDisplayName = boundedString(value.publicDisplayName, "publicDisplayName", 128);
  if (publicDisplayName !== (args.label ?? (basename(canonicalCwd) || "Terminal"))) {
    throw new Error("create-target-observation terminal display is not derived from its cwd");
  }
  return { canonicalCwd, publicDisplayName };
}

export function parseCreateTargetObservationV1Request(
  value: unknown,
): CreateTargetObservationV1Request {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "operation", "arguments"], ["mode"])
    || value.schemaVersion !== CREATE_TARGET_OBSERVATION_V1_SCHEMA_VERSION
    || (value.mode !== undefined && value.mode !== "observe")
    || (value.operation !== "create_worktree" && value.operation !== "create_terminal")) {
    throw new Error("invalid create-target-observation request");
  }
  return value.operation === "create_worktree"
    ? {
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: parseWorktreeArguments(value.arguments),
    }
    : {
      schemaVersion: 1,
      operation: "create_terminal",
      arguments: parseTerminalArguments(value.arguments),
    };
}

const BASE_REF_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function parseWorktreeCatalogEvidence(
  value: unknown,
): CreateTargetObservationV1WorktreeCatalogEvidence {
  if (!isRecord(value) || !exactKeys(value, ["canonicalGitIdentity", "baseRefOid"])) {
    throw new Error("invalid create-target-observation worktree catalog evidence");
  }
  const canonicalGitIdentity = boundedString(value.canonicalGitIdentity, "canonicalGitIdentity", 64);
  const baseRefOid = boundedString(value.baseRefOid, "baseRefOid", 64);
  if (!BASE_REF_OID.test(baseRefOid)) {
    throw new Error("invalid create-target-observation baseRefOid");
  }
  return { canonicalGitIdentity, baseRefOid };
}

export function parseCreateTargetObservationV1Response(
  value: unknown,
): CreateTargetObservationV1Response {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "catalogRevision", "observation"])
    || value.schemaVersion !== CREATE_TARGET_OBSERVATION_V1_SCHEMA_VERSION
    || !isRecord(value.observation)) {
    throw new Error("invalid create-target-observation response");
  }
  const catalogRevision = parseCatalogRevision(value.catalogRevision);
  const observation = value.observation;
  if (observation.operation === "create_worktree") {
    if (!exactKeys(observation, ["operation", "arguments", "execution", "catalog"])) {
      throw new Error("invalid create-target-observation response");
    }
    const args = parseWorktreeArguments(observation.arguments);
    const execution = parseRpcV2CreateResolvedWorktreeRequest({
      arguments: args,
      execution: observation.execution,
      reservationCorrelation: probeReservationCorrelation(),
    }).execution;
    return {
      schemaVersion: 1,
      catalogRevision,
      observation: {
        operation: "create_worktree",
        arguments: args,
        execution,
        catalog: parseWorktreeCatalogEvidence(observation.catalog),
      },
    };
  }
  if (observation.operation !== "create_terminal"
    || !exactKeys(observation, ["operation", "arguments", "execution"])) {
    throw new Error("invalid create-target-observation response");
  }
  const args = parseTerminalArguments(observation.arguments);
  return {
    schemaVersion: 1,
    catalogRevision,
    observation: {
      operation: "create_terminal",
      arguments: args,
      execution: parseTerminalExecution(observation.execution, args),
    },
  };
}

export function parseCreateTargetObservationV1AdmitRequest(
  value: unknown,
): CreateTargetObservationV1AdmitRequest {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "mode", "operation", "arguments", "observation",
      "reservationCorrelation",
    ])
    || value.schemaVersion !== CREATE_TARGET_OBSERVATION_V1_SCHEMA_VERSION
    || value.mode !== "admit"
    || (value.operation !== "create_worktree" && value.operation !== "create_terminal")
    || !isRecord(value.observation)
    || !exactKeys(value.observation, ["catalogRevision", "execution"])) {
    throw new Error("invalid create-target-observation admit request");
  }
  const reservationCorrelation = normalizeManagedSessionReservationCorrelation(
    value.reservationCorrelation,
  );
  const catalogRevision = parseCatalogRevision(value.observation.catalogRevision);
  if (value.operation === "create_worktree") {
    const args = parseWorktreeArguments(value.arguments);
    const execution = parseRpcV2CreateResolvedWorktreeRequest({
      arguments: args,
      execution: value.observation.execution,
      reservationCorrelation,
    }).execution;
    return {
      schemaVersion: 1,
      mode: "admit",
      operation: "create_worktree",
      arguments: args,
      observation: { catalogRevision, execution },
      reservationCorrelation,
    };
  }
  const args = parseTerminalArguments(value.arguments);
  return {
    schemaVersion: 1,
    mode: "admit",
    operation: "create_terminal",
    arguments: args,
    observation: {
      catalogRevision,
      execution: parseTerminalExecution(value.observation.execution, args),
    },
    reservationCorrelation,
  };
}

export function parseCreateTargetObservationV1AdmitResponse(
  value: unknown,
  operation: "create_worktree" | "create_terminal",
): CreateTargetObservationV1AdmitResponse {
  if (!isRecord(value)
    || value.schemaVersion !== CREATE_TARGET_OBSERVATION_V1_SCHEMA_VERSION
    || value.mode !== "admit"
    || (value.state !== "stale" && value.state !== "executed")) {
    throw new Error("invalid create-target-observation admit response");
  }
  if (value.state === "stale") {
    if (!exactKeys(value, ["schemaVersion", "mode", "state", "sideEffect", "error"])
      || value.sideEffect !== "not_applied"
      || !isRecord(value.error)
      || !exactKeys(value.error, ["code", "message"])
      || value.error.code !== "OBSERVATION_STALE"
      || typeof value.error.message !== "string"
      || value.error.message.length === 0
      || value.error.message.includes("\0")
      || Buffer.byteLength(value.error.message, "utf8") > 4_096) {
      throw new Error("invalid create-target-observation stale admit response");
    }
    return {
      schemaVersion: 1,
      mode: "admit",
      state: "stale",
      sideEffect: "not_applied",
      error: { code: "OBSERVATION_STALE", message: value.error.message },
    };
  }
  if (!exactKeys(value, ["schemaVersion", "mode", "state", "response"])) {
    throw new Error("invalid create-target-observation executed admit response");
  }
  return {
    schemaVersion: 1,
    mode: "admit",
    state: "executed",
    response: parseRpcV2CreateResponse(
      value.response,
      operation === "create_worktree" ? "create-worktree-resolved" : "create-terminal",
    ),
  };
}

function canonicalDirectory(
  candidate: string,
  deps: Required<CreateTargetObservationV1Deps>,
  label: string,
): string {
  if (!deps.existsSync(candidate) || !deps.statSync(candidate).isDirectory()) {
    throw new Error(`create-target-observation ${label} is not an existing directory`);
  }
  return normalizedAbsolutePath(deps.realpathSync(candidate), label);
}

/** Mirrors session.ts detectTargetBranch for the default (no explicit branch) case. */
function detectDefaultBaseBranch(
  repoDir: string,
  gitQuery: (repoDir: string, args: string[], timeout?: number) => string,
): string {
  const originHead = gitQuery(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    .replace("refs/remotes/origin/", "")
    .trim();
  if (originHead) return originHead;
  const hasMaster = gitQuery(repoDir, ["ls-remote", "--heads", "origin", "master"]);
  return hasMaster ? "master" : "main";
}

/**
 * Closed-set repository identity: the realpathed canonical git dir and
 * common dir, digested so the revision is stable across local/SSH
 * observation of the same target without leaking local path details. An
 * unresolvable or unreadable git identity fails closed.
 */
function canonicalGitIdentityDigest(
  canonicalRepoPath: string,
  deps: Required<CreateTargetObservationV1Deps>,
): string {
  const raw = deps.gitQuery(canonicalRepoPath, ["rev-parse", "--git-dir", "--git-common-dir"]);
  const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length !== 2) {
    throw new Error("create-target-observation git identity is not resolvable");
  }
  const canonical = lines.map((line) => {
    const absolute = isAbsolute(line) ? normalize(line) : resolve(canonicalRepoPath, line);
    return normalizedAbsolutePath(deps.realpathSync(absolute), "gitDir");
  });
  return createHash("sha256")
    .update(CATALOG_REVISION_DOMAIN, "utf8")
    .update("git-identity\0", "utf8")
    .update(`${canonical[0]}\0${canonical[1]}`, "utf8")
    .digest("base64url");
}

/**
 * The exact remote OID of the base branch, matching the fetch precondition
 * the resolved mutation consumes. Anything unparseable or mismatched fails
 * closed instead of observing a bare ref-exists boolean.
 */
function resolveBaseRefOid(
  repoDir: string,
  branch: string,
  gitQuery: (repoDir: string, args: string[], timeout?: number) => string,
): string {
  const raw = gitQuery(repoDir, ["ls-remote", "--heads", "origin", branch]);
  const line = raw.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\trefs\/heads\/(.+)$/.exec(line);
  if (match === null || match[2] !== branch) {
    throw new Error(`create-target-observation base branch is not resolvable: ${branch}`);
  }
  return match[1];
}

/** Deterministic collision-free-by-construction branch segment; unsafe names hash closed. */
function deterministicWorktreeBranch(rawSessionName: string): string {
  if (SAFE_WORKTREE_BRANCH.test(rawSessionName)) return rawSessionName;
  const digest = createHash("sha256")
    .update(CATALOG_REVISION_DOMAIN, "utf8")
    .update("worktree-branch\0", "utf8")
    .update(rawSessionName, "utf8")
    .digest("base64url");
  return `project-${digest}`;
}

function catalogRevision(observed: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(CATALOG_REVISION_DOMAIN, "utf8")
    .update(canonicalJson(observed), "utf8")
    .digest("base64url");
  return `${CREATE_TARGET_OBSERVATION_V1_REVISION_PREFIX}${digest}`;
}

function buildWorktreeObservation(
  request: CreateTargetObservationV1WorktreeRequest,
  deps: Required<CreateTargetObservationV1Deps>,
): CreateTargetObservationV1Response {
  const args = request.arguments;
  const config = deps.loadConfig();
  const configuredProject: ProjectConfig | undefined = args.project
    ? config?.projects[args.project]
    : undefined;
  if (args.project && !configuredProject && !args.path) {
    throw new Error(`project '${args.project}' not in ~/.tmux-worktree.json`);
  }
  const projectDir = args.path ? expandHomePath(args.path) : configuredProject?.path;
  if (!projectDir) throw new Error("create-target-observation requires project or path");
  const canonicalRepoPath = canonicalDirectory(projectDir, deps, "canonicalRepoPath");
  // The mutation path requires a real git work tree with a resolvable remote
  // base ref; an existing non-git directory fails closed here, not later.
  if (deps.gitQuery(canonicalRepoPath, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("create-target-observation canonicalRepoPath is not a git repository");
  }
  const canonicalGitIdentity = canonicalGitIdentityDigest(canonicalRepoPath, deps);
  const effectiveProject = args.project ?? (basename(canonicalRepoPath) || "project");
  const effectiveBaseBranch = args.branch
    ?? configuredProject?.branch
    ?? detectDefaultBaseBranch(canonicalRepoPath, deps.gitQuery);
  const baseRefOid = resolveBaseRefOid(canonicalRepoPath, effectiveBaseBranch, deps.gitQuery);
  const rawSessionName = (
    args.name ? `${effectiveProject}-${args.name}` : effectiveProject
  ).slice(0, SESSION_NAME_MAX_LEN);
  const publicDisplayName = args.name ?? effectiveProject;
  const worktreeBase = resolveWorktreeBase(config?.worktreeBase);
  const worktreeBranch = deterministicWorktreeBranch(rawSessionName);
  const worktreePath = resolve(
    worktreeBase,
    canonicalWorktreePlacementSegment(effectiveProject),
    worktreeBranch,
  );
  const placement = parseCanonicalWorktreePlacement({ worktreeBase, worktreePath, worktreeBranch });
  const execution = parseRpcV2CreateResolvedWorktreeRequest({
    arguments: args,
    execution: {
      canonicalRepoPath,
      effectiveProject,
      effectiveBaseBranch,
      rawSessionName,
      publicDisplayName,
      worktreeBase: placement.worktreeBase,
      worktreePath: placement.worktreePath,
      worktreeBranch: placement.worktreeBranch,
    },
    reservationCorrelation: probeReservationCorrelation(),
  }).execution;
  const observation: CreateTargetObservationV1WorktreeObservation = {
    operation: "create_worktree",
    arguments: args,
    execution,
    catalog: { canonicalGitIdentity, baseRefOid },
  };
  return {
    schemaVersion: 1,
    catalogRevision: catalogRevision({
      configProject: configuredProject ?? null,
      observation,
    }),
    observation,
  };
}

function buildTerminalObservation(
  request: CreateTargetObservationV1TerminalRequest,
  deps: Required<CreateTargetObservationV1Deps>,
): CreateTargetObservationV1Response {
  const args = request.arguments;
  const canonicalCwd = canonicalDirectory(expandHomePath(args.cwd), deps, "canonicalCwd");
  const publicDisplayName = args.label ?? (basename(canonicalCwd) || "Terminal");
  const observation: CreateTargetObservationV1TerminalObservation = {
    operation: "create_terminal",
    arguments: args,
    execution: { canonicalCwd, publicDisplayName },
  };
  // The revision digests the exact canonical arguments (canonical cwd +
  // derived label) the mutation consumes, so an admit presenting the
  // canonical form re-observes the identical revision: observation, admitted
  // store, and executor share one exact argument form.
  return {
    schemaVersion: 1,
    catalogRevision: catalogRevision({
      observation: {
        ...observation,
        arguments: { cwd: canonicalCwd, label: publicDisplayName },
      },
    }),
    observation,
  };
}

/**
 * Pure atomic catalog observation. Unresolvable targets (unknown project,
 * missing or non-git directory, unresolvable base ref, non-canonical
 * placement) throw: omission is a closed, unavailable state, never a
 * fabricated placement or a PROJECT_NOT_FOUND business result.
 */
export function buildCreateTargetObservationV1(
  rawRequest: unknown,
  deps: CreateTargetObservationV1Deps = {},
): CreateTargetObservationV1Response {
  const request = parseCreateTargetObservationV1Request(rawRequest);
  const resolvedDeps: Required<CreateTargetObservationV1Deps> = {
    loadConfig: deps.loadConfig ?? loadConfigFile,
    existsSync: deps.existsSync ?? existsSync,
    realpathSync: deps.realpathSync ?? realpathSync,
    statSync: deps.statSync ?? statSync,
    gitQuery: deps.gitQuery ?? defaultGitQuery,
  };
  return request.operation === "create_worktree"
    ? buildWorktreeObservation(request, resolvedDeps)
    : buildTerminalObservation(request, resolvedDeps);
}

function staleAdmission(): CreateTargetObservationV1AdmitResponse {
  return {
    schemaVersion: 1,
    mode: "admit",
    state: "stale",
    sideEffect: "not_applied",
    error: {
      code: "OBSERVATION_STALE",
      message: "create target catalog changed after its observation",
    },
  };
}

/**
 * Target-side admission: re-observes the live catalog in the same process and
 * exact-compares the frozen revision, arguments, and closed execution. Any
 * drift fails closed as OBSERVATION_STALE with zero side effects; only an
 * exact match proceeds to the resolved mutation. The residual drift window is
 * the irreducible local TOCTOU between this re-observation and the mutation,
 * identical to any local create.
 */
export function executeCreateTargetAdmissionV1(
  rawRequest: unknown,
  deps: CreateTargetAdmissionV1Deps = {},
): CreateTargetObservationV1AdmitResponse {
  const request = parseCreateTargetObservationV1AdmitRequest(rawRequest);
  let fresh: CreateTargetObservationV1Response;
  try {
    fresh = buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: request.operation,
      arguments: request.arguments,
    }, deps);
  } catch {
    return staleAdmission();
  }
  if (fresh.catalogRevision !== request.observation.catalogRevision
    || canonicalJson(fresh.observation.arguments) !== canonicalJson(request.arguments)
    || canonicalJson(fresh.observation.execution) !== canonicalJson(request.observation.execution)) {
    return staleAdmission();
  }
  const response = request.operation === "create_worktree"
    ? (deps.runResolvedWorktree ?? executeRpcV2CreateResolvedWorktree)({
      arguments: request.arguments as RpcV2CreateWorktreeRequest["arguments"],
      execution: request.observation.execution as RpcV2CreateResolvedWorktreeRequest["execution"],
      reservationCorrelation: request.reservationCorrelation,
    })
    : (deps.runTerminal ?? executeRpcV2CreateTerminal)({
      arguments: request.arguments as RpcV2CreateTerminalRequest["arguments"],
      reservationCorrelation: request.reservationCorrelation,
    });
  return { schemaVersion: 1, mode: "admit", state: "executed", response };
}

/**
 * Bounded strict parse of the raw `--request-json` payload: exact UTF-8 byte
 * cap plus depth/key/node limits and duplicate-key rejection, the same
 * discipline the relay v2 strict JSON parser enforces on wire frames.
 */
export function parseCreateTargetObservationV1RequestJson(source: string): unknown {
  if (typeof source !== "string"
    || Buffer.byteLength(source, "utf8") > CREATE_TARGET_OBSERVATION_V1_REQUEST_MAX_BYTES) {
    throw new Error("create-target-observation request exceeds its byte limit");
  }
  return parseRelayV2JsonObject(source, REQUEST_JSON_LIMITS);
}

export async function createTargetObservationV1Cmd(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--request-json") {
    throw new Error("create-target-observation requires exactly --request-json <json>");
  }
  const raw = parseCreateTargetObservationV1RequestJson(args[1]);
  if (isRecord(raw) && raw.mode === "admit") {
    console.log(JSON.stringify(executeCreateTargetAdmissionV1(raw)));
    return;
  }
  console.log(JSON.stringify(buildCreateTargetObservationV1(raw)));
}
