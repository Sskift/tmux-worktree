import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  type RelayV2JsonLimits,
} from "./strictJson.js";

type ParseLimits = {
  maxDepth: number;
  maxKeys: number;
  maxNodes: number;
};

const DEFAULT_LIMITS: ParseLimits = {
  maxDepth: 8,
  maxKeys: 256,
  maxNodes: 1_024,
};

function authenticationJsonInvalid(): never {
  throw new Error("Relay v2 authentication JSON is invalid");
}

export function decodeRelayV2AuthUtf8(bytes: Uint8Array): string {
  try {
    return decodeRelayV2StrictUtf8(bytes);
  } catch {
    return authenticationJsonInvalid();
  }
}

export function parseRelayV2AuthJson(
  source: string,
  limits: Partial<ParseLimits> = {},
): unknown {
  const selected = { ...DEFAULT_LIMITS, ...limits };
  const strictLimits: RelayV2JsonLimits = {
    maxDepth: selected.maxDepth,
    maxDirectKeys: selected.maxKeys,
    maxTotalKeys: selected.maxKeys,
    maxNodes: selected.maxNodes,
  };
  try {
    return parseRelayV2JsonObject(source, strictLimits);
  } catch {
    return authenticationJsonInvalid();
  }
}
