import { types as nodeUtilTypes } from "node:util";

const MAX_CA_ENTRIES = 8;
export const RELAY_V2_HOST_TLS_CA_MAX_ENTRY_BYTES = 16_384;
const MAX_CA_ENTRY_BYTES = RELAY_V2_HOST_TLS_CA_MAX_ENTRY_BYTES;
const MAX_CA_TOTAL_BYTES = 32_768;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const OBJECT_PROTOTYPE = Object.prototype;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const STRING_CONSTRUCTOR = String;
const UINT8_ARRAY_CONSTRUCTOR = Uint8Array;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(UINT8_ARRAY_PROTOTYPE);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_SET = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "set",
)?.value;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_HAS = WeakMap.prototype.has;
const WEAK_MAP_SET = WeakMap.prototype.set;
const SYSTEM_TLS_TRUST = OBJECT_FREEZE(OBJECT_CREATE(null));
const HOST_CA_TRUST_CUTS =
  new WeakMap<object, RelayV2HostTlsCaTrust | typeof SYSTEM_TLS_TRUST>();

/**
 * Injected-only CA extension for one exact Host TLS client lane.
 *
 * Omission means system trust. The record cannot carry a client certificate,
 * private key, verification override, hostname verifier, or arbitrary TLS
 * option. Each consumer captures its own lane before constructing a transport.
 */
export interface RelayV2HostTlsCaTrust {
  readonly certificateAuthorities: readonly (string | Uint8Array)[];
}

/** Process-local authority; runtime readers reject every copied or forged value. */
export type RelayV2HostTlsCaTrustCut = object & {
  readonly __relayV2HostTlsCaTrustCut: never;
};

export class RelayV2HostTlsTrustMaterialError extends Error {
  constructor() {
    super("Relay v2 Host TLS trust material is invalid");
    this.name = "RelayV2HostTlsTrustMaterialError";
  }
}

function invalid(): RelayV2HostTlsTrustMaterialError {
  return new RelayV2HostTlsTrustMaterialError();
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return NODE_IS_PROXY(value);
  } catch {
    return true;
  }
}

interface CapturedEntry {
  readonly material: string | Uint8Array;
  readonly byteLength: number;
}

function captureUint8Array(value: object): CapturedEntry {
  let prototype: object | null;
  try {
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    throw invalid();
  }
  if (prototype !== UINT8_ARRAY_PROTOTYPE
    || typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
    || typeof TYPED_ARRAY_SET !== "function") throw invalid();

  let byteLength: unknown;
  try {
    byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  } catch {
    throw invalid();
  }
  if (!NUMBER_IS_SAFE_INTEGER(byteLength)
    || (byteLength as number) < 1
    || (byteLength as number) > MAX_CA_ENTRY_BYTES) throw invalid();

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    throw invalid();
  }
  const keys = REFLECT_OWN_KEYS(descriptors);
  if (keys.length !== byteLength) throw invalid();
  for (let index = 0; index < (byteLength as number); index += 1) {
    const key = STRING_CONSTRUCTOR(index);
    if (keys[index] !== key) throw invalid();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, "value")) {
      throw invalid();
    }
  }

  const copy = new UINT8_ARRAY_CONSTRUCTOR(byteLength as number);
  try {
    REFLECT_APPLY(TYPED_ARRAY_SET, copy, [value]);
  } catch {
    throw invalid();
  }
  return OBJECT_FREEZE({ material: copy, byteLength: byteLength as number });
}

function captureEntry(value: unknown): CapturedEntry {
  if (typeof value === "string") {
    const bytes = BUFFER_BYTE_LENGTH(value, "utf8");
    if (bytes < 1 || bytes > MAX_CA_ENTRY_BYTES) throw invalid();
    return OBJECT_FREEZE({ material: value, byteLength: bytes });
  }
  if (value !== null && typeof value === "object" && !rejectedProxy(value)) {
    return captureUint8Array(value);
  }
  throw invalid();
}

/**
 * Exact own-data capture of one non-empty bounded CA bundle. The returned
 * record and list are frozen, and every byte entry is independently copied.
 */
export function captureRelayV2HostTlsCaTrust(value: unknown): RelayV2HostTlsCaTrust {
  if (value === null
    || typeof value !== "object"
    || ARRAY_IS_ARRAY(value)
    || rejectedProxy(value)) throw invalid();
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    throw invalid();
  }
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw invalid();
  const keys = REFLECT_OWN_KEYS(descriptors);
  if (keys.length !== 1 || keys[0] !== "certificateAuthorities") throw invalid();
  const descriptor = descriptors.certificateAuthorities;
  if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, "value")) throw invalid();

  const list = descriptor.value;
  if (!ARRAY_IS_ARRAY(list) || rejectedProxy(list)) throw invalid();
  let listPrototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    listPrototype = OBJECT_GET_PROTOTYPE_OF(list);
    lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(list, "length");
  } catch {
    throw invalid();
  }
  if (listPrototype !== ARRAY_PROTOTYPE
    || lengthDescriptor === undefined
    || !OBJECT_HAS_OWN(lengthDescriptor, "value")) throw invalid();
  const length = lengthDescriptor.value;
  if (!NUMBER_IS_SAFE_INTEGER(length)
    || length < 1
    || length > MAX_CA_ENTRIES) throw invalid();

  let listDescriptors: PropertyDescriptorMap;
  try {
    listDescriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(list) as unknown as
      PropertyDescriptorMap;
  } catch {
    throw invalid();
  }
  const listKeys = REFLECT_OWN_KEYS(listDescriptors);
  if (listKeys.length !== length + 1 || listKeys[length] !== "length") throw invalid();

  let totalBytes = 0;
  const certificateAuthorities: (string | Uint8Array)[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = STRING_CONSTRUCTOR(index);
    if (listKeys[index] !== key) throw invalid();
    const entryDescriptor = listDescriptors[key];
    if (entryDescriptor === undefined || !OBJECT_HAS_OWN(entryDescriptor, "value")) {
      throw invalid();
    }
    const entry = captureEntry(entryDescriptor.value);
    totalBytes += entry.byteLength;
    if (totalBytes > MAX_CA_TOTAL_BYTES) throw invalid();
    certificateAuthorities[index] = entry.material;
  }
  return OBJECT_FREEZE({
    certificateAuthorities: OBJECT_FREEZE(certificateAuthorities),
  });
}

export function captureRelayV2HostTlsCaTrustCut(
  value: unknown,
): RelayV2HostTlsCaTrustCut {
  const material = captureRelayV2HostTlsCaTrust(value);
  const cut = OBJECT_FREEZE(OBJECT_CREATE(null)) as RelayV2HostTlsCaTrustCut;
  REFLECT_APPLY(WEAK_MAP_SET, HOST_CA_TRUST_CUTS, [cut, material]);
  return cut;
}

/**
 * Issues an explicit system-trust cut. Two callers receive two independent
 * process-local authorities even though both lanes intentionally omit an
 * additive CA bundle at the transport boundary.
 */
export function captureRelayV2HostSystemTlsTrustCut(): RelayV2HostTlsCaTrustCut {
  const cut = OBJECT_FREEZE(OBJECT_CREATE(null)) as RelayV2HostTlsCaTrustCut;
  REFLECT_APPLY(WEAK_MAP_SET, HOST_CA_TRUST_CUTS, [cut, SYSTEM_TLS_TRUST]);
  return cut;
}

export function isRelayV2HostTlsTrustCut(value: unknown): value is RelayV2HostTlsCaTrustCut {
  if (value === null || typeof value !== "object") return false;
  try {
    return REFLECT_APPLY(WEAK_MAP_HAS, HOST_CA_TRUST_CUTS, [value]) as boolean;
  } catch {
    return false;
  }
}

export function readRelayV2HostTlsCaTrustCut(
  value: unknown,
): RelayV2HostTlsCaTrust | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const trust = REFLECT_APPLY(WEAK_MAP_GET, HOST_CA_TRUST_CUTS, [value]) as
      RelayV2HostTlsCaTrust | typeof SYSTEM_TLS_TRUST | undefined;
    return trust === SYSTEM_TLS_TRUST ? undefined : trust;
  } catch {
    return undefined;
  }
}
