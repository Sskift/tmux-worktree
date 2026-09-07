/**
 * Sorted-key JSON serialization shared by terminal-control and relay-v2
 * identity/fingerprinting code. The output bytes are load-bearing (they feed
 * sha256 fingerprints and persisted inputJson fields), so this implementation
 * must stay byte-identical to the historical inline copies it replaces.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}
