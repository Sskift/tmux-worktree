export type RelayV2JsonValue =
  | null
  | boolean
  | number
  | string
  | RelayV2JsonValue[]
  | { [key: string]: RelayV2JsonValue };

export type RelayV2JsonFailureClass =
  | "duplicate-key"
  | "invalid-utf8"
  | "json-depth-limit"
  | "json-direct-key-limit"
  | "json-total-key-limit"
  | "json-node-limit"
  | "malformed-json"
  | "non-object-root"
  | "safe-integer-limit"
  | "trailing-json";

export interface RelayV2JsonLimits {
  maxDepth: number;
  maxDirectKeys: number;
  maxTotalKeys: number;
  maxNodes: number;
}

export interface RelayV2JsonInspection {
  rootIsObject: boolean;
  rootType: string | null;
  totalKeys: number;
  totalNodes: number;
}

const OBJECT_CREATE = Object.create;
const REFLECT_APPLY = Reflect.apply;
const ARRAY_IS_ARRAY = Array.isArray;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON_OBJECT.parse;
const REGEXP_EXEC = RegExp.prototype.exec;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_SLICE = String.prototype.slice;
const TEXT_DECODER_CONSTRUCTOR = TextDecoder;
const TEXT_DECODER_DECODE = TEXT_DECODER_CONSTRUCTOR.prototype.decode;
const STRICT_UTF8_TEXT_DECODER =
  new TEXT_DECODER_CONSTRUCTOR("utf-8", { fatal: true });

export class RelayV2JsonError extends Error {
  constructor(readonly failureClass: RelayV2JsonFailureClass) {
    super("Relay v2 JSON is invalid");
    this.name = "RelayV2JsonError";
  }
}

const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = -MAX_SAFE_INTEGER;

class StrictJsonParser {
  private offset = 0;
  private totalKeys = 0;
  private totalNodes = 0;
  private rootType: string | null = null;
  private rootIsObject = false;

  constructor(
    private readonly source: string,
    private readonly limits: RelayV2JsonLimits,
    private readonly build: boolean,
  ) {}

  inspect(): RelayV2JsonInspection {
    this.parseDocument();
    return {
      rootIsObject: this.rootIsObject,
      rootType: this.rootType,
      totalKeys: this.totalKeys,
      totalNodes: this.totalNodes,
    };
  }

  parse(): { [key: string]: RelayV2JsonValue } {
    const value = this.parseDocument();
    if (!this.rootIsObject || !isJsonObject(value)) this.fail("non-object-root");
    return value;
  }

  private parseDocument(): RelayV2JsonValue | undefined {
    this.skipWhitespace();
    if (this.offset >= this.source.length) this.fail("malformed-json");
    const value = this.parseValue(0, true);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail("trailing-json");
    return value;
  }

  private parseValue(depth: number, root = false): RelayV2JsonValue | undefined {
    this.totalNodes += 1;
    if (this.totalNodes > this.limits.maxNodes) this.fail("json-node-limit");

    const next = this.source[this.offset];
    if (next === "{") {
      if (depth + 1 > this.limits.maxDepth) this.fail("json-depth-limit");
      if (root) this.rootIsObject = true;
      return this.parseObject(depth + 1);
    }
    if (next === "[") {
      if (depth + 1 > this.limits.maxDepth) this.fail("json-depth-limit");
      return this.parseArray(depth + 1);
    }
    if (next === '"') return this.parseString();
    if (next === "t") return this.parseLiteral("true", true);
    if (next === "f") return this.parseLiteral("false", false);
    if (next === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseObject(depth: number): RelayV2JsonValue | undefined {
    this.offset += 1;
    this.skipWhitespace();
    const result = this.build
      ? OBJECT_CREATE(null) as { [key: string]: RelayV2JsonValue }
      : undefined;
    const seen = new Set<string>();
    let directKeys = 0;
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }

    while (this.offset < this.source.length) {
      if (this.source[this.offset] !== '"') this.fail("malformed-json");
      const key = this.parseString();
      if (seen.has(key)) this.fail("duplicate-key");
      seen.add(key);
      directKeys += 1;
      if (directKeys > this.limits.maxDirectKeys) this.fail("json-direct-key-limit");
      this.totalKeys += 1;
      if (this.totalKeys > this.limits.maxTotalKeys) this.fail("json-total-key-limit");

      this.skipWhitespace();
      if (this.source[this.offset] !== ":") this.fail("malformed-json");
      this.offset += 1;
      this.skipWhitespace();
      const value = this.parseValue(depth);
      if (depth === 1 && key === "type" && typeof value === "string") {
        this.rootType = value;
      }
      if (result !== undefined) result[key] = value as RelayV2JsonValue;

      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") this.fail("malformed-json");
      this.offset += 1;
      this.skipWhitespace();
    }
    return this.fail("malformed-json");
  }

  private parseArray(depth: number): RelayV2JsonValue | undefined {
    this.offset += 1;
    this.skipWhitespace();
    const result = this.build ? [] as RelayV2JsonValue[] : undefined;
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }

    while (this.offset < this.source.length) {
      const value = this.parseValue(depth);
      if (result !== undefined) result.push(value as RelayV2JsonValue);
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") this.fail("malformed-json");
      this.offset += 1;
      this.skipWhitespace();
    }
    return this.fail("malformed-json");
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = REFLECT_APPLY(
        STRING_CHAR_CODE_AT,
        this.source,
        [this.offset],
      ) as number;
      if (char === 0x22) {
        this.offset += 1;
        try {
          const encoded = REFLECT_APPLY(
            STRING_SLICE,
            this.source,
            [start, this.offset],
          ) as string;
          return REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [encoded]) as string;
        } catch {
          return this.fail("malformed-json");
        }
      }
      if (char < 0x20) this.fail("malformed-json");
      if (char === 0x5c) {
        this.offset += 1;
        const escape = this.source[this.offset];
        if (escape === "u") {
          const escapeDigits = REFLECT_APPLY(STRING_SLICE, this.source, [
            this.offset + 1,
            this.offset + 5,
          ]) as string;
          if (!REFLECT_APPLY(REGEXP_TEST, /^[0-9a-fA-F]{4}$/, [escapeDigits])) {
            this.fail("malformed-json");
          }
          this.offset += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
          this.fail("malformed-json");
        }
      }
      this.offset += 1;
    }
    return this.fail("malformed-json");
  }

  private parseNumber(): number {
    const remainder = REFLECT_APPLY(
      STRING_SLICE,
      this.source,
      [this.offset],
    ) as string;
    const match = REFLECT_APPLY(
      REGEXP_EXEC,
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
      [remainder],
    ) as RegExpExecArray | null;
    if (!match) return this.fail("malformed-json");
    this.offset += match[0].length;
    if (!REFLECT_APPLY(REGEXP_TEST, /[.eE]/, [match[0]])) {
      let integer: bigint;
      try {
        integer = BigInt(match[0]);
      } catch {
        return this.fail("malformed-json");
      }
      if (integer > MAX_SAFE_INTEGER || integer < MIN_SAFE_INTEGER) {
        this.fail("safe-integer-limit");
      }
    }
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return this.fail("malformed-json");
    return value;
  }

  private parseLiteral<T extends null | boolean>(text: string, value: T): T {
    if (REFLECT_APPLY(STRING_SLICE, this.source, [
      this.offset,
      this.offset + text.length,
    ]) !== text) {
      this.fail("malformed-json");
    }
    this.offset += text.length;
    return value;
  }

  private skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.source[this.offset])) this.offset += 1;
  }

  private fail(failureClass: RelayV2JsonFailureClass): never {
    throw new RelayV2JsonError(failureClass);
  }
}

function isJsonObject(
  value: RelayV2JsonValue | undefined,
): value is { [key: string]: RelayV2JsonValue } {
  return value !== null
    && typeof value === "object"
    && !REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value]);
}

export function decodeRelayV2StrictUtf8(bytes: Uint8Array): string {
  try {
    return REFLECT_APPLY(
      TEXT_DECODER_DECODE,
      STRICT_UTF8_TEXT_DECODER,
      [bytes],
    ) as string;
  } catch {
    throw new RelayV2JsonError("invalid-utf8");
  }
}

export function inspectRelayV2Json(
  source: string,
  limits: RelayV2JsonLimits,
): RelayV2JsonInspection {
  return new StrictJsonParser(source, limits, false).inspect();
}

export function parseRelayV2JsonObject(
  source: string,
  limits: RelayV2JsonLimits,
): { [key: string]: RelayV2JsonValue } {
  return new StrictJsonParser(source, limits, true).parse();
}
