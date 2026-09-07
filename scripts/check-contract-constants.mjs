#!/usr/bin/env node

// Three-way drift check for shared contract constants. The same values are
// hand-written in the contract manifest, the Node implementation, and the
// mobile Kotlin (relay v2) / Dashboard Rust (feishu bridge) implementations;
// this script fails (non-zero exit) when any side disagrees, printing the
// diff. Regex/simple parsing only — no dependencies.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

const problems = [];

// Compare two string lists as sets and record the diff under `label`.
function compareSets(label, actual, expected) {
  const A = new Set(actual);
  const B = new Set(expected);
  const onlyActual = [...A].filter((value) => !B.has(value));
  const onlyExpected = [...B].filter((value) => !A.has(value));
  if (onlyActual.length > 0 || onlyExpected.length > 0) {
    problems.push(
      `${label}: only in first=[${onlyActual.join(", ")}] ` +
        `only in second=[${onlyExpected.join(", ")}]`,
    );
  }
}

// Extract every "..." string literal appearing in the first regex capture
// region of `source` (the region is the match of `regionPattern` itself).
function extractQuotedInRegion(source, regionPattern) {
  const region = source.match(regionPattern)?.[0] ?? "";
  return [...region.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const digits = (value) => Number(String(value).replace(/_/g, ""));

// ---------------------------------------------------------------------------
// Relay v2: errorCodes + commandDispositions
// manifest <-> src/relay/v2/codecSchema.ts <-> mobile RelayV2SchemaCommon.kt
// ---------------------------------------------------------------------------

const relayManifest = JSON.parse(read("contracts/relay/v2/manifest.json"));
const codecSchemaTs = read("src/relay/v2/codecSchema.ts");
const schemaCommonKt = read(
  "mobile/android/app/src/main/java/com/tmuxworktree/mobile/core/relay/v2/codec/RelayV2SchemaCommon.kt",
);

const nodeErrorCodes = extractQuotedInRegion(
  codecSchemaTs,
  /const ERROR_CODES = new Set\(\[[\s\S]*?\]\);/,
);
const kotlinErrorCodes = extractQuotedInRegion(
  schemaCommonKt,
  /private val ERROR_CODES = setOf\([\s\S]*?\)/,
);
compareSets(
  "relay v2 errorCodes: manifest vs codecSchema.ts",
  relayManifest.errorCodes,
  nodeErrorCodes,
);
compareSets(
  "relay v2 errorCodes: manifest vs RelayV2SchemaCommon.kt",
  relayManifest.errorCodes,
  kotlinErrorCodes,
);

const nodeDispositions = extractQuotedInRegion(
  codecSchemaTs,
  /const COMMAND_DISPOSITIONS = \[[\s\S]*?\] as const;/,
);
const kotlinDispositions = extractQuotedInRegion(
  schemaCommonKt,
  /private val COMMAND_DISPOSITIONS = setOf\([\s\S]*?\)/,
);
compareSets(
  "relay v2 commandDispositions: manifest vs codecSchema.ts",
  relayManifest.commandDispositions,
  nodeDispositions,
);
compareSets(
  "relay v2 commandDispositions: manifest vs RelayV2SchemaCommon.kt",
  relayManifest.commandDispositions,
  kotlinDispositions,
);

// ---------------------------------------------------------------------------
// Relay v2: limits
// manifest <-> src/relay/v2/codec.ts <-> mobile RelayV2Codec.kt
// Only the keys with a named constant on both code sides are compared; the
// remaining manifest limits (idMaxUtf8Bytes, unsignedCounterMax,
// jsonSafeIntegerMax, terminalDecodedFrameBytes) are inline literals with no
// named counterpart to diff against.
// ---------------------------------------------------------------------------

const codecTs = read("src/relay/v2/codec.ts");
const codecKt = read(
  "mobile/android/app/src/main/java/com/tmuxworktree/mobile/core/relay/v2/codec/RelayV2Codec.kt",
);

function nodeJsonLimits(blockName) {
  const region = codecTs.match(
    new RegExp(`const ${blockName}_JSON_LIMITS: RelayV2JsonLimits = \\{[\\s\\S]*?\\};`),
  )?.[0] ?? "";
  const limits = {};
  for (const match of region.matchAll(/(maxDepth|maxDirectKeys|maxTotalKeys|maxNodes): ([\d_]+)/g)) {
    limits[match[1]] = digits(match[2]);
  }
  return limits;
}

function kotlinJsonLimits(blockName) {
  const region = codecKt.match(
    new RegExp(`private val ${blockName}_JSON_LIMITS = RelayV2JsonLimits\\([\\s\\S]*?\\)`),
  )?.[0] ?? "";
  const limits = {};
  for (const match of region.matchAll(/(maxDepth|maxDirectKeys|maxTotalKeys|maxNodes) = ([\d_]+)/g)) {
    limits[match[1]] = digits(match[2]);
  }
  return limits;
}

const nodeLimits = {
  publicFrameBytes: digits(codecTs.match(/RELAY_V2_PUBLIC_FRAME_BYTES = ([\d_]+)/)?.[1]),
  carrierFrameBytes: digits(codecTs.match(/RELAY_V2_CARRIER_FRAME_BYTES = ([\d_]+)/)?.[1]),
  httpsBodyBytes: digits(codecTs.match(/RELAY_V2_HTTP_BODY_BYTES = ([\d_]+)/)?.[1]),
  jsonMaxDepth: nodeJsonLimits("STANDARD").maxDepth,
  jsonMaxDirectKeysPerObject: nodeJsonLimits("STANDARD").maxDirectKeys,
  jsonMaxTotalKeys: nodeJsonLimits("STANDARD").maxTotalKeys,
  jsonMaxNodes: nodeJsonLimits("STANDARD").maxNodes,
  stateSnapshotJsonMaxTotalKeys: nodeJsonLimits("SNAPSHOT").maxTotalKeys,
  stateSnapshotJsonMaxNodes: nodeJsonLimits("SNAPSHOT").maxNodes,
  httpsJsonMaxDepth: nodeJsonLimits("HTTP").maxDepth,
  httpsJsonMaxTotalKeys: nodeJsonLimits("HTTP").maxTotalKeys,
};

const kotlinLimits = {
  publicFrameBytes: digits(codecKt.match(/const val PUBLIC_FRAME_BYTES = ([\d_]+)/)?.[1]),
  carrierFrameBytes: digits(codecKt.match(/const val CARRIER_FRAME_BYTES = ([\d_]+)/)?.[1]),
  httpsBodyBytes: digits(codecKt.match(/const val HTTPS_BODY_BYTES = ([\d_]+)/)?.[1]),
  jsonMaxDepth: kotlinJsonLimits("STANDARD").maxDepth,
  jsonMaxDirectKeysPerObject: kotlinJsonLimits("STANDARD").maxDirectKeys,
  jsonMaxTotalKeys: kotlinJsonLimits("STANDARD").maxTotalKeys,
  jsonMaxNodes: kotlinJsonLimits("STANDARD").maxNodes,
  stateSnapshotJsonMaxTotalKeys: kotlinJsonLimits("SNAPSHOT").maxTotalKeys,
  stateSnapshotJsonMaxNodes: kotlinJsonLimits("SNAPSHOT").maxNodes,
  httpsJsonMaxDepth: kotlinJsonLimits("HTTP").maxDepth,
  httpsJsonMaxTotalKeys: kotlinJsonLimits("HTTP").maxTotalKeys,
};

for (const [key, expected] of Object.entries(relayManifest.limits)) {
  if (!(key in nodeLimits)) continue; // no named counterpart on the code sides
  const nodeValue = nodeLimits[key];
  const kotlinValue = kotlinLimits[key];
  if (nodeValue !== expected) {
    problems.push(
      `relay v2 limits.${key}: manifest=${expected} vs codec.ts=${nodeValue}`,
    );
  }
  if (kotlinValue !== expected) {
    problems.push(
      `relay v2 limits.${key}: manifest=${expected} vs RelayV2Codec.kt=${kotlinValue}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Feishu bridge: capabilities
// manifest.capabilityNegotiation.currentCapabilities
//   <-> src/feishuBridgeServer.ts FEISHU_BRIDGE_CAPABILITIES
//   <-> app/src-tauri/src/features/feishu_bridge.rs (BASE_REQUIRED + named)
// ---------------------------------------------------------------------------

const bridgeManifest = JSON.parse(read("contracts/feishu-bridge/v1/manifest.json"));
const bridgeTs = read("src/feishuBridgeServer.ts");
const bridgeRs = read("app/src-tauri/src/features/feishu_bridge.rs");

const nodeCapabilities = extractQuotedInRegion(
  bridgeTs,
  /export const FEISHU_BRIDGE_CAPABILITIES = \[[\s\S]*?\] as const;/,
);
// Rust keeps the same set as a 3-item BASE array plus 6 named &str constants.
const rustBaseCapabilities = extractQuotedInRegion(
  bridgeRs,
  /BASE_REQUIRED_BRIDGE_CAPABILITIES: \[&str; 3\] = \[[\s\S]*?\]/,
);
const rustNamedCapabilities = [...bridgeRs.matchAll(
  /const [A-Z_]*BRIDGE_CAPABILITY[A-Z_]*: &str = "([^"]+)"/g,
)].map((match) => match[1]);
const rustCapabilities = [...rustBaseCapabilities, ...rustNamedCapabilities];

compareSets(
  "feishu bridge capabilities: manifest vs feishuBridgeServer.ts",
  bridgeManifest.capabilityNegotiation.currentCapabilities,
  nodeCapabilities,
);
compareSets(
  "feishu bridge capabilities: manifest vs feishu_bridge.rs",
  bridgeManifest.capabilityNegotiation.currentCapabilities,
  rustCapabilities,
);

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error("contract constants drift detected:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  "contract constants OK: relay v2 errorCodes/commandDispositions/limits " +
    "and feishu bridge capabilities match across manifest, Node, Kotlin, and Rust",
);
