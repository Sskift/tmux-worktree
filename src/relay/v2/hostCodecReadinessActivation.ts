import {
  decodeRelayV2CommandRouteEnvelope,
  decodeRelayV2HttpsBody,
  decodeRelayV2WebSocketFrame,
  encodeRelayV2HttpsBody,
  encodeRelayV2WebSocketFrame,
  resolveRelayV2RouteDialect,
  validateRelayV2CommandRouteEnvelope,
} from "./codec.js";
import type { RelayV2HostCapabilityReadinessSourceSink } from "./hostCapabilityReadiness.js";

export interface RelayV2HostCodecReadinessActivationOptions {
  readinessSink: RelayV2HostCapabilityReadinessSourceSink<"codec">;
}

/** The only public lifecycle of the process-local production codec fact. */
export interface RelayV2HostCodecReadinessLifecycle {
  close(): void;
}

interface CodecActivationAttempt {
  faulted: boolean;
}

let codecActivationAttempt: CodecActivationAttempt | null = null;
const claimedReadinessSinks = new WeakSet<object>();

function exactOwnDataDescriptors(
  value: unknown,
  keys: readonly PropertyKey[],
): Map<PropertyKey, PropertyDescriptor> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Reflect.ownKeys(descriptors);
    if (actualKeys.length !== keys.length
      || actualKeys.some((key) => !keys.includes(key))) return null;
    const captured = new Map<PropertyKey, PropertyDescriptor>();
    for (const key of keys) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
      if (descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined) return null;
      captured.set(key, descriptor);
    }
    return captured;
  } catch {
    return null;
  }
}

function observeThenable(value: unknown): void {
  if (((typeof value !== "object" || value === null)
    && typeof value !== "function")) return;
  try {
    if (typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
    }
  } catch {}
}

function closeSink(sink: object, close: (...args: never[]) => unknown): void {
  try { observeThenable(Reflect.apply(close, sink, [])); } catch {}
}

/**
 * This is a static module binding, not a fixture or caller-supplied probe. If
 * any production strict-codec entry is absent, activation fails before it can
 * publish readiness.
 */
function productionCodecReadyConclusion(): true {
  if (typeof decodeRelayV2WebSocketFrame !== "function"
    || typeof encodeRelayV2WebSocketFrame !== "function"
    || typeof decodeRelayV2CommandRouteEnvelope !== "function"
    || typeof validateRelayV2CommandRouteEnvelope !== "function"
    || typeof decodeRelayV2HttpsBody !== "function"
    || typeof encodeRelayV2HttpsBody !== "function"
    || typeof resolveRelayV2RouteDialect !== "function") {
    throw new TypeError("Relay v2 production strict codec binding is unavailable");
  }
  return true;
}

/**
 * Publishes the one process-local readiness generation for the repository's
 * production strict codec. The owner is one-shot: failure, reentry, duplicate
 * claim or close permanently withdraws generation 1 and never retries it.
 */
export function createRelayV2HostCodecReadinessActivation(
  options: RelayV2HostCodecReadinessActivationOptions,
): RelayV2HostCodecReadinessLifecycle | null {
  const parentAttempt = codecActivationAttempt;
  if (parentAttempt !== null) parentAttempt.faulted = true;
  const attempt: CodecActivationAttempt = { faulted: parentAttempt !== null };
  codecActivationAttempt = attempt;

  try {
    const optionFields = exactOwnDataDescriptors(options, ["readinessSink"]);
    if (optionFields === null) return null;
    const sink = optionFields.get("readinessSink")!.value;
    const sinkFields = exactOwnDataDescriptors(sink, ["apply", "close"]);
    if (sinkFields === null) return null;
    const apply = sinkFields.get("apply")!.value;
    const close = sinkFields.get("close")!.value;
    if (typeof apply !== "function" || typeof close !== "function") return null;

    let sourceClosed = false;
    const lifecycle: RelayV2HostCodecReadinessLifecycle = Object.freeze({
      close(): void {
        if (sourceClosed) return;
        sourceClosed = true;
        closeSink(sink as object, close);
      },
    });

    if (claimedReadinessSinks.has(sink as object) || attempt.faulted) {
      lifecycle.close();
      return null;
    }
    claimedReadinessSinks.add(sink as object);

    let applied: unknown = false;
    try {
      applied = Reflect.apply(apply, sink, [Object.freeze({
        source: "codec",
        generation: "1",
        ready: productionCodecReadyConclusion(),
      })]);
    } catch {
      applied = false;
    }
    if (applied !== true || attempt.faulted) {
      observeThenable(applied);
      lifecycle.close();
      return null;
    }
    return lifecycle;
  } finally {
    codecActivationAttempt = parentAttempt;
  }
}
