import { RELAY_V2_REQUIRED_CAPABILITIES } from "./brokerCore.js";
import type {
  RelayV2HostCapabilityIntersection,
  RelayV2HostCapabilityIntersectionPort,
  RelayV2HostReadinessSink,
  RelayV2HostReadinessSnapshot,
  RelayV2HostReadinessSubscription,
  RelayV2RequiredCapability,
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
const MAX_ACTIVE_PRE_CARRIER_OFFERS = 64;
const PRE_CARRIER_SOURCES = Object.freeze(
  RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES.filter((source) => source !== "carrier"),
) as readonly Exclude<RelayV2HostCapabilityReadinessSource, "carrier">[];
const FULL_PRE_CARRIER_CAPABILITIES = Object.freeze([
  ...RELAY_V2_REQUIRED_CAPABILITIES,
]);

declare const relayV2HostPreCarrierOfferClaimBrand: unique symbol;

export type RelayV2HostCapabilityReadinessSource =
  typeof RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES[number];

export interface RelayV2HostPreCarrierOfferClaim {
  readonly [relayV2HostPreCarrierOfferClaimBrand]: true;
}

export interface RelayV2HostPreCarrierOfferAttemptBinding {
  readonly controllerGeneration: string;
  readonly carrierAttemptGeneration: string;
}

export interface RelayV2HostPreCarrierOfferBinding
extends RelayV2HostPreCarrierOfferAttemptBinding {
  readonly offerGeneration: string;
}

export interface RelayV2HostPreCarrierOfferFence {
  bind(binding: Readonly<RelayV2HostPreCarrierOfferBinding>): boolean;
  fence(binding: Readonly<RelayV2HostPreCarrierOfferBinding>): void;
}

export interface RelayV2HostPreCarrierOfferIssueInput
extends RelayV2HostPreCarrierOfferAttemptBinding {
  readonly fence: RelayV2HostPreCarrierOfferFence;
  /** Exact optional producer cut captured by the composition at issuance. */
  readonly optionalCapabilities?: readonly string[];
}

export interface RelayV2HostPreCarrierOfferIssuerPort {
  issuePreCarrierOffer(
    input: Readonly<RelayV2HostPreCarrierOfferIssueInput>,
  ): RelayV2HostPreCarrierOfferClaim | null;
}

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

interface PreCarrierOfferRecord {
  readonly binding: Readonly<RelayV2HostPreCarrierOfferBinding>;
  readonly fence: Readonly<{
    receiver: object;
    bind: RelayV2HostPreCarrierOfferFence["bind"];
    fence: RelayV2HostPreCarrierOfferFence["fence"];
  }>;
  readonly cutSerial: bigint;
  readonly capabilities: readonly string[];
  state: "offered" | "consumed" | "invalidated" | "released";
  consume(): readonly string[] | null;
  release(): void;
}

const preCarrierOfferClaims = new WeakMap<object, PreCarrierOfferRecord>();

function exactPositiveGeneration(value: unknown): bigint | null {
  const parsed = parseGeneration(value);
  return parsed !== null && parsed > 0n ? parsed : null;
}

function samePreCarrierAttemptBinding(
  record: PreCarrierOfferRecord,
  candidate: RelayV2HostPreCarrierOfferAttemptBinding,
): boolean {
  return record.binding.controllerGeneration === candidate.controllerGeneration
    && record.binding.carrierAttemptGeneration === candidate.carrierAttemptGeneration;
}

export function matchesRelayV2HostPreCarrierOfferClaim(
  claim: unknown,
  binding: Readonly<RelayV2HostPreCarrierOfferAttemptBinding>,
): claim is RelayV2HostPreCarrierOfferClaim {
  if (typeof claim !== "object" || claim === null
    || exactPositiveGeneration(binding?.controllerGeneration) === null
    || exactPositiveGeneration(binding?.carrierAttemptGeneration) === null) return false;
  const record = preCarrierOfferClaims.get(claim);
  return record !== undefined && samePreCarrierAttemptBinding(record, binding);
}

export function consumeRelayV2HostPreCarrierOfferClaim(
  claim: unknown,
): readonly string[] | null {
  if (typeof claim !== "object" || claim === null) return null;
  return preCarrierOfferClaims.get(claim)?.consume() ?? null;
}

export function releaseRelayV2HostPreCarrierOfferClaim(claim: unknown): void {
  if (typeof claim !== "object" || claim === null) return;
  preCarrierOfferClaims.get(claim)?.release();
}

function capturePreCarrierOfferFence(
  value: unknown,
): PreCarrierOfferRecord["fence"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const bind = Reflect.get(value, "bind");
    const fence = Reflect.get(value, "fence");
    if (typeof bind !== "function" || typeof fence !== "function") return null;
    return Object.freeze({ receiver: value, bind, fence });
  } catch {
    return null;
  }
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
  private preCarrierCutSerial = 0n;
  private preCarrierOfferGeneration = 0n;
  private preCarrierOfferIssuanceClosed = false;
  private readonly activePreCarrierOffers = new Set<PreCarrierOfferRecord>();

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

  /**
   * Issues one opaque offer against the current five-source pre-carrier cut.
   * The supplied fence is bound before the claim becomes observable.
   */
  issuePreCarrierOffer(
    input: Readonly<RelayV2HostPreCarrierOfferIssueInput>,
  ): RelayV2HostPreCarrierOfferClaim | null {
    const controllerGeneration = exactPositiveGeneration(input?.controllerGeneration);
    const carrierAttemptGeneration = exactPositiveGeneration(input?.carrierAttemptGeneration);
    const fence = capturePreCarrierOfferFence(input?.fence);
    const optionalCapabilities = this.captureOptionalCapabilities(input?.optionalCapabilities);
    if (controllerGeneration === null
      || carrierAttemptGeneration === null
      || fence === null
      || optionalCapabilities === null
      || this.preCarrierOfferIssuanceClosed
      || !this.allPreCarrierSourcesReady()) return null;
    if (this.activePreCarrierOffers.size >= MAX_ACTIVE_PRE_CARRIER_OFFERS
      || this.preCarrierOfferGeneration === MAX_SOURCE_GENERATION) {
      this.preCarrierOfferIssuanceClosed = true;
      this.invalidatePreCarrierOffers();
      return null;
    }

    this.preCarrierOfferGeneration += 1n;
    const binding = Object.freeze({
      controllerGeneration: controllerGeneration.toString(10),
      carrierAttemptGeneration: carrierAttemptGeneration.toString(10),
      offerGeneration: this.preCarrierOfferGeneration.toString(10),
    });
    const cutSerial = this.preCarrierCutSerial;
    let bound = false;
    try {
      bound = Reflect.apply(fence.bind, fence.receiver, [binding]) === true;
    } catch {}
    if (!bound
      || cutSerial !== this.preCarrierCutSerial
      || !this.allPreCarrierSourcesReady()) {
      if (bound) {
        try { Reflect.apply(fence.fence, fence.receiver, [binding]); } catch {}
      }
      return null;
    }

    const claim = Object.freeze(Object.create(null)) as RelayV2HostPreCarrierOfferClaim;
    let record!: PreCarrierOfferRecord;
    record = {
      binding,
      fence,
      cutSerial,
      capabilities: Object.freeze([
        ...FULL_PRE_CARRIER_CAPABILITIES,
        ...optionalCapabilities,
      ]),
      state: "offered",
      consume: () => this.consumePreCarrierOffer(record),
      release: () => this.releasePreCarrierOffer(record),
    };
    preCarrierOfferClaims.set(claim as object, record);
    this.activePreCarrierOffers.add(record);
    return claim;
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
    let invalidateOffers = false;
    let advancePreCarrierCut = false;
    try {
      const snapshot = decodeSourceSnapshot(source, input);
      const generationCandidate = snapshot.valid
        ? snapshot.generation
        : snapshot.generationCandidate;
      if (this.faultSerial !== faultBeforeDecode) {
        this.invalidateSource(source, generationCandidate);
        publishRequired = !this.pendingWithdrawal;
        invalidateOffers = true;
        advancePreCarrierCut = source !== "carrier";
      } else if (!snapshot.valid) {
        this.invalidateSource(source, snapshot.generationCandidate);
        publishRequired = true;
        invalidateOffers = true;
        advancePreCarrierCut = source !== "carrier";
      } else {
        const state = this.sources.get(source)!;
        if (state.generation !== null && snapshot.generation < state.generation) {
          this.invalidateSource(source, snapshot.generation);
          publishRequired = true;
          invalidateOffers = true;
          advancePreCarrierCut = source !== "carrier";
        } else if (state.generation !== null && snapshot.generation === state.generation) {
          if (!state.requiresNewGeneration && state.ready === snapshot.ready) {
            accepted = true;
          } else {
            this.invalidateSource(source, snapshot.generation);
            publishRequired = true;
            invalidateOffers = true;
            advancePreCarrierCut = source !== "carrier";
          }
        } else {
          state.generation = snapshot.generation;
          state.ready = snapshot.ready;
          state.requiresNewGeneration = false;
          accepted = true;
          publishRequired = true;
          invalidateOffers = source !== "carrier" || !snapshot.ready;
          advancePreCarrierCut = source !== "carrier";
        }
      }
    } finally {
      this.sourceMutationActive = false;
    }

    if (advancePreCarrierCut) this.advancePreCarrierCut();
    if (invalidateOffers) this.invalidatePreCarrierOffers();

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
    if (source !== "carrier") this.advancePreCarrierCut();
    this.invalidatePreCarrierOffers();
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
    if (source !== "carrier") this.advancePreCarrierCut();
    this.invalidatePreCarrierOffers();
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

  private allPreCarrierSourcesReady(): boolean {
    return PRE_CARRIER_SOURCES.every((source) => {
      const state = this.sources.get(source)!;
      return state.generation !== null && state.ready && !state.requiresNewGeneration;
    });
  }

  private advancePreCarrierCut(): void {
    if (this.preCarrierCutSerial === MAX_SOURCE_GENERATION) {
      this.preCarrierOfferIssuanceClosed = true;
      return;
    }
    this.preCarrierCutSerial += 1n;
  }

  private consumePreCarrierOffer(
    record: PreCarrierOfferRecord,
  ): readonly string[] | null {
    if (record.state !== "offered"
      || !this.activePreCarrierOffers.has(record)
      || record.cutSerial !== this.preCarrierCutSerial
      || !this.allPreCarrierSourcesReady()) {
      if (record.state === "offered" || record.state === "consumed") {
        this.invalidatePreCarrierOffer(record);
      }
      return null;
    }
    record.state = "consumed";
    return record.capabilities;
  }

  private captureOptionalCapabilities(value: unknown): readonly string[] | null {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > 58) return null;
    const capabilities: string[] = [];
    for (const capability of value) {
      if (typeof capability !== "string"
        || capability.length === 0
        || Buffer.byteLength(capability, "utf8") > 128
        || (RELAY_V2_REQUIRED_CAPABILITIES as readonly string[]).includes(capability)
        || capabilities.includes(capability)) return null;
      capabilities.push(capability);
    }
    return Object.freeze(capabilities);
  }

  private releasePreCarrierOffer(record: PreCarrierOfferRecord): void {
    if (record.state === "released" || record.state === "invalidated") return;
    record.state = "released";
    this.activePreCarrierOffers.delete(record);
  }

  private invalidatePreCarrierOffer(record: PreCarrierOfferRecord): void {
    if (record.state === "invalidated" || record.state === "released") return;
    record.state = "invalidated";
    this.activePreCarrierOffers.delete(record);
    try { Reflect.apply(record.fence.fence, record.fence.receiver, [record.binding]); } catch {}
  }

  private invalidatePreCarrierOffers(): void {
    for (const record of [...this.activePreCarrierOffers]) {
      this.invalidatePreCarrierOffer(record);
    }
  }

  private intersectionReady(snapshot: RelayV2HostReadinessSnapshot): boolean {
    return RELAY_V2_REQUIRED_CAPABILITIES.every(
      (capability) => snapshot.capabilities[capability] === true,
    );
  }
}
