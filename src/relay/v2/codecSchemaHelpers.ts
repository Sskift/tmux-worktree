import type { RelayV2JsonValue } from "./strictJson.js";

const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_BYTE_LENGTH = BUFFER_CONSTRUCTOR.byteLength;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
const REFLECT_APPLY = Reflect.apply;
const STRING_INCLUDES = String.prototype.includes;
const STRING_TRIM = String.prototype.trim;
const ARRAY_CONSTRUCTOR = Array;
const ARRAY_FROM = ARRAY_CONSTRUCTOR.from;
const ARRAY_IS_ARRAY = ARRAY_CONSTRUCTOR.isArray;

const UINT64_MAX = 18_446_744_073_709_551_615n;

export type CodecSchemaJsonObject = { [key: string]: RelayV2JsonValue };

export interface CodecSchemaStringOptions {
  allowEmpty?: boolean;
  allowOuterWhitespace?: boolean;
  maxBytes?: number;
  maxCharacters?: number;
  allowNul?: boolean;
}

export interface CodecSchemaHelpers {
  array(
    value: RelayV2JsonValue,
    validator: (item: RelayV2JsonValue) => void,
    maximum: number,
    minimum?: number,
  ): RelayV2JsonValue[];
  booleanValue(value: RelayV2JsonValue): boolean;
  counter(value: RelayV2JsonValue): string;
  cursor(value: RelayV2JsonValue): string;
  exact(
    value: CodecSchemaJsonObject,
    required: readonly string[],
    optional?: readonly string[],
  ): void;
  field(value: CodecSchemaJsonObject, name: string): RelayV2JsonValue;
  id(value: RelayV2JsonValue): string;
  integer(value: RelayV2JsonValue, minimum?: number, maximum?: number): number;
  literal<T extends string | number | boolean>(value: RelayV2JsonValue, expected: T): T;
  nullable<T>(
    value: RelayV2JsonValue,
    validator: (item: RelayV2JsonValue) => T,
  ): T | null;
  nullValue(value: RelayV2JsonValue): null;
  object(value: RelayV2JsonValue): CodecSchemaJsonObject;
  oneOf<const T extends readonly string[]>(
    value: RelayV2JsonValue,
    allowed: T,
  ): T[number];
  positiveCounter(value: RelayV2JsonValue): string;
  stringValue(value: RelayV2JsonValue, options?: CodecSchemaStringOptions): string;
  text(value: RelayV2JsonValue, maxBytes: number): string;
}

export interface CodecSchemaHelperOptions {
  /**
   * When true, string validators reject unpaired UTF-16 surrogates with the
   * "invalid-utf8" failure class. The base v2 envelope codec leaves string
   * well-formedness to the strict JSON parser layer, while extension codecs
   * enforce it inline; the two dialects diverge here deliberately.
   */
  wellFormedStrings: boolean;
}

/**
 * Builds the frozen schema-validation helper DSL shared by the base v2 codec
 * and the extension codecs. Each domain supplies its own reject seam so error
 * classes, messages, and failure-class typing stay domain-owned; the helper
 * bodies (and therefore protocol bytes and failure classes) are identical.
 */
export function createCodecSchemaHelpers(
  reject: (failureClass: string) => never,
  options: CodecSchemaHelperOptions,
): CodecSchemaHelpers {
  function assertWellFormedUnicode(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) reject("invalid-utf8");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        reject("invalid-utf8");
      }
    }
  }

  function object(value: RelayV2JsonValue): CodecSchemaJsonObject {
    if (value === null) reject("forbidden-null");
    if (typeof value !== "object"
      || REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [value])) {
      reject("type-coercion");
    }
    return value as CodecSchemaJsonObject;
  }

  function exact(
    value: CodecSchemaJsonObject,
    required: readonly string[],
    optional: readonly string[] = [],
  ): void {
    const allowed = new Set([...required, ...optional]);
    for (const key of required) {
      if (!OBJECT_HAS_OWN(value, key)) reject("missing-field");
    }
    for (const key of OBJECT_KEYS(value)) {
      if (!allowed.has(key)) reject("unknown-field");
    }
  }

  function field(value: CodecSchemaJsonObject, name: string): RelayV2JsonValue {
    if (!OBJECT_HAS_OWN(value, name)) reject("missing-field");
    return value[name]!;
  }

  function stringValue(
    value: RelayV2JsonValue,
    stringOptions: CodecSchemaStringOptions = {},
  ): string {
    if (value === null) reject("forbidden-null");
    if (typeof value !== "string") reject("type-coercion");
    if (options.wellFormedStrings) assertWellFormedUnicode(value);
    if (!stringOptions.allowEmpty && value.length === 0) reject("invalid-argument");
    if (!stringOptions.allowNul
      && REFLECT_APPLY(STRING_INCLUDES, value, ["\0"])) reject("invalid-argument");
    if (!stringOptions.allowOuterWhitespace
      && REFLECT_APPLY(STRING_TRIM, value, []) !== value) reject("invalid-argument");
    if (
      stringOptions.maxBytes !== undefined
      && BUFFER_BYTE_LENGTH(value, "utf8") > stringOptions.maxBytes
    ) {
      reject("id-byte-limit");
    }
    if (
      stringOptions.maxCharacters !== undefined
      && (
        REFLECT_APPLY(ARRAY_FROM, ARRAY_CONSTRUCTOR, [value]) as unknown[]
      ).length > stringOptions.maxCharacters
    ) {
      reject("invalid-argument");
    }
    return value;
  }

  function id(value: RelayV2JsonValue): string {
    return stringValue(value, { maxBytes: 128 });
  }

  function cursor(value: RelayV2JsonValue): string {
    return stringValue(value, { maxBytes: 1_024 });
  }

  function text(value: RelayV2JsonValue, maxBytes: number): string {
    return stringValue(value, {
      allowEmpty: true,
      allowOuterWhitespace: true,
      maxBytes,
    });
  }

  function nullable<T>(
    value: RelayV2JsonValue,
    validator: (item: RelayV2JsonValue) => T,
  ): T | null {
    return value === null ? null : validator(value);
  }

  function booleanValue(value: RelayV2JsonValue): boolean {
    if (value === null) reject("forbidden-null");
    if (typeof value !== "boolean") reject("type-coercion");
    return value;
  }

  function nullValue(value: RelayV2JsonValue): null {
    if (value !== null) reject("schema-mismatch");
    return null;
  }

  function integer(
    value: RelayV2JsonValue,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number {
    if (value === null) reject("forbidden-null");
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
    ) {
      reject("type-coercion");
    }
    if (value < minimum || value > maximum) reject("invalid-argument");
    return value;
  }

  function literal<T extends string | number | boolean>(
    value: RelayV2JsonValue,
    expected: T,
  ): T {
    if (value !== expected) {
      if (value === null) reject("forbidden-null");
      reject("schema-mismatch");
    }
    return expected;
  }

  function oneOf<const T extends readonly string[]>(
    value: RelayV2JsonValue,
    allowed: T,
  ): T[number] {
    if (value === null) reject("forbidden-null");
    if (typeof value !== "string") reject("type-coercion");
    if (!(allowed as readonly string[]).includes(value)) reject("schema-mismatch");
    return value as T[number];
  }

  function array(
    value: RelayV2JsonValue,
    validator: (item: RelayV2JsonValue) => void,
    maximum: number,
    minimum = 0,
  ): RelayV2JsonValue[] {
    if (value === null) reject("forbidden-null");
    if (!REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [value])) {
      reject("type-coercion");
    }
    const items = value as RelayV2JsonValue[];
    if (items.length < minimum || items.length > maximum) reject("invalid-argument");
    for (const item of items) validator(item);
    return items;
  }

  function counter(value: RelayV2JsonValue): string {
    if (value === null) reject("forbidden-null");
    if (typeof value !== "string") reject("type-coercion");
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) reject("non-canonical-counter");
    if (BigInt(value) > UINT64_MAX) reject("counter-overflow");
    return value;
  }

  function positiveCounter(value: RelayV2JsonValue): string {
    const parsed = counter(value);
    if (parsed === "0") reject("invalid-argument");
    return parsed;
  }

  return {
    array,
    booleanValue,
    counter,
    cursor,
    exact,
    field,
    id,
    integer,
    literal,
    nullable,
    nullValue,
    object,
    oneOf,
    positiveCounter,
    stringValue,
    text,
  };
}
