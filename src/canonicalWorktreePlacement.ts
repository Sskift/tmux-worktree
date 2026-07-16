import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

const PROJECT_BYTES = 128;
const PATH_BYTES = 4_096;
const BRANCH_BYTES = 255;
const SEGMENT_BYTES = 128;
const MAX_RELATIVE_SEGMENTS = 32;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PLACEMENT_PREFIX = "project-";
const PLACEMENT_HASH_DOMAIN = "tmux-worktree/canonical-worktree-placement/v1\0";

export interface CanonicalWorktreePlacement {
  worktreeBase: string;
  worktreePath: string;
  worktreeBranch: string;
  placementSegment: string;
}

export interface CanonicalWorktreePlacementFilesystem {
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`invalid canonical worktree ${label}`);
  }
  return value;
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  const parsed = boundedString(value, label, PATH_BYTES);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed || resolve(parsed) !== parsed) {
    throw new TypeError(`invalid canonical worktree ${label}`);
  }
  return parsed;
}

function safeRelativeSegments(value: string, label: string): string[] {
  if (isAbsolute(value) || normalize(value) !== value || value === "." || value === "..") {
    throw new TypeError(`invalid canonical worktree ${label}`);
  }
  const segments = value.split(sep);
  if (segments.length === 0 || segments.length > MAX_RELATIVE_SEGMENTS) {
    throw new TypeError(`invalid canonical worktree ${label}`);
  }
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)
      || Buffer.byteLength(segment, "utf8") > SEGMENT_BYTES) {
      throw new TypeError(`invalid canonical worktree ${label}`);
    }
  }
  return segments;
}

/** Stable resolver-owned mapping; public project identity is never used as a path segment directly. */
export function canonicalWorktreePlacementSegment(project: unknown): string {
  const identity = boundedString(project, "project identity", PROJECT_BYTES);
  if (SAFE_SEGMENT.test(identity)
    && Buffer.byteLength(identity, "utf8") <= SEGMENT_BYTES
    && !identity.toLowerCase().startsWith(RESERVED_PLACEMENT_PREFIX)) {
    return identity;
  }
  const digest = createHash("sha256")
    .update(PLACEMENT_HASH_DOMAIN, "utf8")
    .update(identity, "utf8")
    .digest("base64url");
  return `${RESERVED_PLACEMENT_PREFIX}${digest}`;
}

/** Parses the resolver-frozen final placement without consulting public project identity. */
export function parseCanonicalWorktreePlacement(value: unknown): CanonicalWorktreePlacement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid canonical worktree placement");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3
    || keys[0] !== "worktreeBase"
    || keys[1] !== "worktreeBranch"
    || keys[2] !== "worktreePath") {
    throw new TypeError("invalid canonical worktree placement");
  }
  const worktreeBase = normalizedAbsolutePath(record.worktreeBase, "base");
  const worktreePath = normalizedAbsolutePath(record.worktreePath, "path");
  const worktreeBranch = boundedString(record.worktreeBranch, "branch", BRANCH_BYTES);
  const branchSegments = safeRelativeSegments(worktreeBranch, "branch");
  const relativePath = relative(worktreeBase, worktreePath);
  if (relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)) {
    throw new TypeError("canonical worktree path escapes its base");
  }
  const pathSegments = safeRelativeSegments(relativePath, "relative path");
  if (pathSegments.length !== branchSegments.length + 1
    || pathSegments.slice(1).some((segment, index) => segment !== branchSegments[index])) {
    throw new TypeError("canonical worktree path does not match its frozen branch");
  }
  const placementSegment = pathSegments[0]!;
  const expectedPath = resolve(worktreeBase, placementSegment, ...branchSegments);
  if (expectedPath !== worktreePath) {
    throw new TypeError("canonical worktree path is not closed over its placement");
  }
  return { worktreeBase, worktreePath, worktreeBranch, placementSegment };
}

function nearestExistingAncestor(
  candidate: string,
  filesystem: CanonicalWorktreePlacementFilesystem,
): string {
  let current = candidate;
  while (!filesystem.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new TypeError("canonical worktree placement has no existing filesystem ancestor");
    }
    current = parent;
  }
  return current;
}

/** Target-host proof against symlink aliases or escapes, run immediately before mutation. */
export function assertCanonicalWorktreePlacementFilesystem(
  placement: CanonicalWorktreePlacement,
  filesystem: CanonicalWorktreePlacementFilesystem,
): void {
  for (const candidate of [placement.worktreeBase, placement.worktreePath]) {
    const ancestor = nearestExistingAncestor(candidate, filesystem);
    let actual: string;
    try {
      actual = normalizedAbsolutePath(filesystem.realpathSync(ancestor), "realpath");
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith("invalid canonical worktree")) {
        throw error;
      }
      throw new TypeError("cannot verify canonical worktree filesystem placement");
    }
    if (actual !== ancestor) {
      throw new TypeError("canonical worktree filesystem placement crosses a symlink");
    }
  }
}
