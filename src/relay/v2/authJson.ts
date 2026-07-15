const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

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

class StrictJsonParser {
  private offset = 0;
  private keys = 0;
  private nodes = 0;

  constructor(
    private readonly source: string,
    private readonly limits: ParseLimits,
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail();
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > this.limits.maxDepth) this.fail();
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) this.fail();

    const next = this.source[this.offset];
    if (next === "{") return this.parseObject(depth + 1);
    if (next === "[") return this.parseArray(depth + 1);
    if (next === '"') return this.parseString();
    if (next === "t") return this.parseLiteral("true", true);
    if (next === "f") return this.parseLiteral("false", false);
    if (next === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.offset += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }

    while (this.offset < this.source.length) {
      if (this.source[this.offset] !== '"') this.fail();
      const key = this.parseString();
      if (Object.hasOwn(result, key)) this.fail();
      this.keys += 1;
      if (this.keys > this.limits.maxKeys) this.fail();
      this.skipWhitespace();
      if (this.source[this.offset] !== ":") this.fail();
      this.offset += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") this.fail();
      this.offset += 1;
      this.skipWhitespace();
    }
    return this.fail();
  }

  private parseArray(depth: number): unknown[] {
    this.offset += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }

    while (this.offset < this.source.length) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") this.fail();
      this.offset += 1;
      this.skipWhitespace();
    }
    return this.fail();
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = this.source.charCodeAt(this.offset);
      if (char === 0x22) {
        this.offset += 1;
        try {
          return JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          return this.fail();
        }
      }
      if (char < 0x20) this.fail();
      if (char === 0x5c) {
        this.offset += 1;
        const escape = this.source[this.offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.offset + 1, this.offset + 5))) {
            this.fail();
          }
          this.offset += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) this.fail();
      }
      this.offset += 1;
    }
    return this.fail();
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.offset),
    );
    if (!match) return this.fail();
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return this.fail();
    return value;
  }

  private parseLiteral<T>(text: string, value: T): T {
    if (this.source.slice(this.offset, this.offset + text.length) !== text) this.fail();
    this.offset += text.length;
    return value;
  }

  private skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.source[this.offset])) this.offset += 1;
  }

  private fail(): never {
    throw new Error("Relay v2 authentication JSON is invalid");
  }
}

export function decodeRelayV2AuthUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Relay v2 authentication JSON is invalid");
  }
}

export function parseRelayV2AuthJson(
  source: string,
  limits: Partial<ParseLimits> = {},
): unknown {
  return new StrictJsonParser(source, { ...DEFAULT_LIMITS, ...limits }).parse();
}
