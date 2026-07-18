import { RELAY_V2_REQUIRED_CAPABILITIES } from "./brokerCore.js";
import type {
  RelayV2HostCapabilityIntersection,
  RelayV2HostCapabilityIntersectionPort,
  RelayV2HostReadinessSink,
  RelayV2HostReadinessSnapshot,
  RelayV2HostReadinessSubscription,
} from "./hostRuntime.js";

export const RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES = Object.freeze([
  "codec",
  "carrier",
  "h0",
  "h1",
  "h2",
  "h3",
] as const);

export const RELAY_V2_HOST_CAPABILITY_READINESS_LIMITS = Object.freeze({
  maxSubscribers: 64,
} as const);

const MAX_SOURCE_GENERATION = 18_446_744_073_709_551_615n;

export type RelayV2HostCapabilityReadinessSource =
  typeof RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES[number];

/**
 * One source-local readiness fact. A generation is a canonical uint64 counter
 * owned by that source; it is process-local and never enters Relay wire data.
 */
export type RelayV2HostCapabilityReadinessSourceSnapshot<
  Source extends RelayV2HostCapabilityReadinessSource = RelayV2HostCapabilityReadinessSource,
> = Readonly<{
  source: Source;
  generation: string;
  ready: boolean;
}>;

/**
 * Narrow ingress for one already-owned codec/carrier/H0/H1/H2/H3 readiness
 * fact. The intersection owner does not construct or probe that authority.
 */
export interface RelayV2HostCapabilityReadinessSourceSink<
  Source extends RelayV2HostCapabilityReadinessSource = RelayV2HostCapabilityReadinessSource,
> {
  apply(snapshot: RelayV2HostCapabilityReadinessSourceSnapshot<Source>): boolean;
  close(): void;
}

export interface RelayV2HostCapabilityReadinessOptions {
  /** Tests may only make the production subscriber bound stricter. */
  testLimits?: { maxSubscribers?: number };
}

interface SourceState {
  generation: bigint | null;
  ready: boolean;
  requiresNewGeneration: boolean;
}

interface Subscriber {
  apply(snapshot: RelayV2HostReadinessSnapshot): unknown;
  close(): void;
}

function exactCapabilitySet(ready: boolean): RelayV2HostCapabilityIntersection {
  return Object.freeze(Object.fromEntries(
    RELAY_V2_REQUIRED_CAPABILITIES.map((capability) => [capability, ready]),
  )) as RelayV2HostCapabilityIntersection;
}

function readinessSnapshot(generation: bigint, ready: boolean): RelayV2HostReadinessSnapshot {
  return Object.freeze({
    generation: generation.toString(10),
    capabilities: exactCapabilitySet(ready),
  });
}

function parseGeneration(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_SOURCE_GENERATION ? parsed : null;
  } catch {
    return null;
  }
}

type DecodedSourceSnapshot =
  | { valid: true; generation: bigint; ready: boolean }
  | { valid: false; generationCandidate: bigint | null };

function decodeSourceSnapshot(
  expectedSource: RelayV2HostCapabilityReadinessSource,
  value: unknown,
): DecodedSourceSnapshot {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false, generationCandidate: null };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const generation = descriptors.generation;
    const generationCandidate = generation && Object.hasOwn(generation, "value")
      ? parseGeneration(generation.value)
      : null;
    if (keys.length !== 3
      || keys.some((key) => typeof key !== "string"
        || (key !== "source" && key !== "generation" && key !== "ready"))) {
      return { valid: false, generationCandidate };
    }
    const source = descriptors.source;
    const ready = descriptors.ready;
    if (!source || !generation || !ready
      || !Object.hasOwn(source, "value")
      || !Object.hasOwn(generation, "value")
      || !Object.hasOwn(ready, "value")
      || source.value !== expectedSource
      || typeof ready.value !== "boolean"
      || generationCandidate === null) {
      return { valid: false, generationCandidate };
    }
    return { valid: true, generation: generationCandidate, ready: ready.value };
  } catch {
    return { valid: false, generationCandidate: null };
  }
}

function observeThenable(value: unknown): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  try {
    if (typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
    }
  } catch {}
}

function isStrictSynchronousTrue(value: unknown): value is true {
  if (value === true) return true;
  observeThenable(value);
  return false;
}

function validSource(value: unknown): value is RelayV2HostCapabilityReadinessSource {
  return typeof value === "string"
    && (RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES as readonly string[]).includes(value);
}

function maxSubscribers(options: RelayV2HostCapabilityReadinessOptions): number {
  const production = RELAY_V2_HOST_CAPABILITY_READINESS_LIMITS.maxSubscribers;
  const selected = options.testLimits?.maxSubscribers ?? production;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > production) {
    throw new Error("invalid or widened Relay v2 host readiness subscriber limit");
  }
  return selected;
}

/**
 * Process-local, unwired owner of the atomic base-v2 readiness intersection.
 *
 * Every source starts missing/false. Only an explicit, fresh ready generation
 * from all six sources yields the frozen six-capability set. Any malformed,
 * regressed, conflicting or closed source synchronously publishes the exact
 * empty set first and can recover only with a strictly newer source generation.
 */
export class RelayV2HostCapabilityReadiness
implements RelayV2HostCapabilityIntersectionPort {
  readonly maxSubscribers: number;

  private readonly sources = new Map<RelayV2HostCapabilityReadinessSource, SourceState>();
  private readonly subscribers = new Map<number, Subscriber>();
  private publicationGeneration = 0n;
  private published = readinessSnapshot(0n, false);
  private nextSubscriberId = 0;
  private subscriberSlots = 0;
  private subscriberAdmissionActive = false;
  private subscriberAdmissionFaulted = false;
  private fanoutActive = false;
  private sourceMutationActive = false;
  private pendingWithdrawal = false;
  private faultSerial = 0;

  constructor(options: RelayV2HostCapabilityReadinessOptions = {}) {
    this.maxSubscribers = maxSubscribers(options);
    for (const source of RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES) {
      this.sources.set(source, {
        generation: null,
        ready: false,
        requiresNewGeneration: false,
      });
    }
  }

  /** Returns a typed, non-authoritative ingress bound to exactly one source. */
  source<Source extends RelayV2HostCapabilityReadinessSource>(
    source: Source,
  ): RelayV2HostCapabilityReadinessSourceSink<Source> {
    if (!validSource(source)) throw new Error("unknown Relay v2 host readiness source");
    return Object.freeze({
      apply: (snapshot: RelayV2HostCapabilityReadinessSourceSnapshot<Source>) => (
        this.applySource(source, snapshot)
      ),
      close: () => this.closeSource(source),
    });
  }

  /** Synchronous immutable view; an empty intersection is represented by six false keys. */
  current(): RelayV2HostReadinessSnapshot {
    return this.published;
  }

  subscribe(sink: RelayV2HostReadinessSink): RelayV2HostReadinessSubscription {
    if (this.subscriberAdmissionActive) {
      this.subscriberAdmissionFaulted = true;
      throw new Error("reentrant Relay v2 host readiness subscription is forbidden");
    }
    if (this.fanoutActive || this.sourceMutationActive) {
      throw new Error("reentrant Relay v2 host readiness subscription is forbidden");
    }
    if (this.subscriberSlots >= this.maxSubscribers) {
      throw new Error("Relay v2 host readiness subscriber capacity is exhausted");
    }
    this.subscriberSlots += 1;
    this.subscriberAdmissionActive = true;
    this.subscriberAdmissionFaulted = false;
    const faultBeforeAdmission = this.faultSerial;
    let apply: RelayV2HostReadinessSink["apply"] | null = null;
    let close: RelayV2HostReadinessSink["close"] | null = null;
    let admissionFailed = false;
    try {
      if (!sink || typeof sink !== "object") {
        throw new Error("Relay v2 host readiness subscriber is invalid");
      }
      const candidateApply = Reflect.get(sink, "apply");
      const candidateClose = Reflect.get(sink, "close");
      if (typeof candidateApply !== "function" || typeof candidateClose !== "function") {
        throw new Error("Relay v2 host readiness subscriber is invalid");
      }
      apply = candidateApply as RelayV2HostReadinessSink["apply"];
      close = candidateClose as RelayV2HostReadinessSink["close"];
    } catch {
      admissionFailed = true;
    }
    admissionFailed ||= apply === null
      || close === null
      || this.subscriberAdmissionFaulted
      || this.faultSerial !== faultBeforeAdmission;
    this.subscriberAdmissionActive = false;
    this.subscriberAdmissionFaulted = false;
    if (admissionFailed) this.subscriberSlots -= 1;
    this.flushPendingWithdrawal();
    if (admissionFailed) {
      throw new Error("Relay v2 host readiness subscriber is invalid");
    }
    const admittedApply = apply!;
    const admittedClose = close!;

    const subscriberId = ++this.nextSubscriberId;
    const subscriber: Subscriber = {
      apply: (snapshot) => Reflect.apply(admittedApply, sink, [snapshot]),
      close: () => { Reflect.apply(admittedClose, sink, []); },
    };
    this.subscribers.set(subscriberId, subscriber);

    this.fanoutActive = true;
    let accepted = false;
    try {
      accepted = isStrictSynchronousTrue(subscriber.apply(this.published));
      if (!accepted) this.dropSubscriber(subscriberId, subscriber);
    } catch {
      accepted = false;
      this.dropSubscriber(subscriberId, subscriber);
    } finally {
      this.fanoutActive = false;
    }
    this.flushPendingWithdrawal();

    let active = accepted && this.subscribers.get(subscriberId) === subscriber;
    return Object.freeze({
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.subscribers.get(subscriberId) === subscriber) {
          this.subscribers.delete(subscriberId);
          this.subscriberSlots -= 1;
        }
      },
    });
  }

  private applySource(
    source: RelayV2HostCapabilityReadinessSource,
    input: unknown,
  ): boolean {
    if (this.fanoutActive || this.sourceMutationActive || this.subscriberAdmissionActive) {
      this.withdrawDuringCallback(source);
      return false;
    }

    this.sourceMutationActive = true;
    const faultBeforeDecode = this.faultSerial;
    let accepted = false;
    let publishRequired = false;
    try {
      const snapshot = decodeSourceSnapshot(source, input);
      const generationCandidate = snapshot.valid
        ? snapshot.generation
        : snapshot.generationCandidate;
      if (this.faultSerial !== faultBeforeDecode) {
        this.invalidateSource(source, generationCandidate);
        publishRequired = !this.pendingWithdrawal;
      } else if (!snapshot.valid) {
        this.invalidateSource(source, snapshot.generationCandidate);
        publishRequired = true;
      } else {
        const state = this.sources.get(source)!;
        if (state.generation !== null && snapshot.generation < state.generation) {
          this.invalidateSource(source, snapshot.generation);
          publishRequired = true;
        } else if (state.generation !== null && snapshot.generation === state.generation) {
          if (!state.requiresNewGeneration && state.ready === snapshot.ready) {
            accepted = true;
          } else {
            this.invalidateSource(source, snapshot.generation);
            publishRequired = true;
          }
        } else {
          state.generation = snapshot.generation;
          state.ready = snapshot.ready;
          state.requiresNewGeneration = false;
          accepted = true;
          publishRequired = true;
        }
      }
    } finally {
      this.sourceMutationActive = false;
    }

    const faultBeforePublish = this.faultSerial;
    if (publishRequired) this.publishState();
    else this.flushPendingWithdrawal();
    return accepted && this.faultSerial === faultBeforePublish;
  }

  private closeSource(source: RelayV2HostCapabilityReadinessSource): void {
    if (this.fanoutActive || this.sourceMutationActive || this.subscriberAdmissionActive) {
      this.withdrawDuringCallback(source);
      return;
    }
    this.invalidateSource(source, null);
    this.publishState();
  }

  private invalidateSource(
    source: RelayV2HostCapabilityReadinessSource,
    candidate: bigint | null,
  ): void {
    const state = this.sources.get(source)!;
    if (candidate !== null && (state.generation === null || candidate > state.generation)) {
      state.generation = candidate;
    }
    state.ready = false;
    state.requiresNewGeneration = true;
    this.faultSerial += 1;
  }

  /** Caller callbacks may withdraw, but never recursively fan out. */
  private withdrawDuringCallback(source: RelayV2HostCapabilityReadinessSource): void {
    this.invalidateSource(source, null);
    if (this.intersectionReady(this.published)) {
      this.advancePublished(false);
      this.pendingWithdrawal = true;
    }
  }

  private publishState(): void {
    if (this.fanoutActive || this.sourceMutationActive || this.subscriberAdmissionActive) {
      throw new Error("reentrant Relay v2 host readiness fanout is forbidden");
    }
    this.advancePublished(this.allSourcesReady());
    this.fanoutPublished();
  }

  private advancePublished(ready: boolean): void {
    this.publicationGeneration += 1n;
    this.published = readinessSnapshot(this.publicationGeneration, ready);
  }

  private fanoutPublished(): void {
    if (this.fanoutActive) {
      throw new Error("reentrant Relay v2 host readiness fanout is forbidden");
    }
    do {
      this.pendingWithdrawal = false;
      this.fanoutActive = true;
      try {
        for (const [subscriberId, subscriber] of [...this.subscribers]) {
          if (this.subscribers.get(subscriberId) !== subscriber) continue;
          let accepted = false;
          try {
            accepted = isStrictSynchronousTrue(subscriber.apply(this.published));
          } catch {
            accepted = false;
          }
          if (!accepted) this.dropSubscriber(subscriberId, subscriber);
        }
      } finally {
        this.fanoutActive = false;
      }
    } while (this.pendingWithdrawal);
  }

  private flushPendingWithdrawal(): void {
    if (!this.pendingWithdrawal
      || this.fanoutActive
      || this.sourceMutationActive
      || this.subscriberAdmissionActive) return;
    this.fanoutPublished();
  }

  private dropSubscriber(subscriberId: number, subscriber: Subscriber): void {
    if (this.subscribers.get(subscriberId) === subscriber) {
      this.subscribers.delete(subscriberId);
      this.subscriberSlots -= 1;
    }
    try { subscriber.close(); } catch {}
  }

  private allSourcesReady(): boolean {
    return RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES.every((source) => {
      const state = this.sources.get(source)!;
      return state.generation !== null && state.ready && !state.requiresNewGeneration;
    });
  }

  private intersectionReady(snapshot: RelayV2HostReadinessSnapshot): boolean {
    return RELAY_V2_REQUIRED_CAPABILITIES.every(
      (capability) => snapshot.capabilities[capability] === true,
    );
  }
}
