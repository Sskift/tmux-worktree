import { createHash } from "node:crypto";

interface RelayV2CanonicalBackendInstanceIdentity {
  processTarget: {
    kind: "local" | "ssh";
    /** Stable local process target or configured SSH target identity. */
    targetId: string;
  };
  incarnation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 128) {
    throw new TypeError(`canonical backend ${label} is invalid`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

/**
 * The sole owner of Relay v2 TW backend instance identity. The hash deliberately
 * preserves the original processTarget encoding so extraction cannot change an
 * already-issued key. Public scope/session IDs and raw tmux names are excluded.
 */
export function issueRelayV2CanonicalBackendInstanceKey(
  value: RelayV2CanonicalBackendInstanceIdentity,
): string {
  if (!isRecord(value)
    || !exactKeys(value, ["processTarget", "incarnation"])
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")) {
    throw new TypeError("canonical backend identity input is malformed");
  }
  const targetId = boundedIdentity(value.processTarget.targetId, "targetId");
  const rpcIncarnation = boundedIdentity(value.incarnation, "RPC incarnation");
  if (!/^twinc2\.[A-Za-z0-9_-]{43}$/.test(rpcIncarnation)) {
    throw new TypeError("canonical backend RPC incarnation is invalid");
  }
  const digest = createHash("sha256").update(canonicalJson({
    domain: "tmux-worktree.relay-v2.backend-instance.v1",
    value: {
      processTarget: { kind: value.processTarget.kind, targetId },
      rpcIncarnation,
    },
  }), "utf8").digest("base64url");
  return `twbk2.${digest}`;
}
