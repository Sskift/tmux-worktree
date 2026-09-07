/**
 * In-memory CredentialStorage test doubles, grouped by the three semantic
 * families found across the Relay v2 host credential tests. The families
 * differ in storage topology and conflict semantics and are intentionally
 * not merged into a single factory.
 */

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function slotFor(slots, reference) {
  let slot = slots.get(reference);
  if (!slot) {
    slot = { state: null, revision: 0 };
    slots.set(reference, slot);
  }
  return slot;
}

/**
 * Family C: single-state storage with WeakMap revision conflict detection.
 * Only runExclusive is supported (no snapshot/replace/slot/readCut).
 * The `failed` flag lets tests force the storage to reject all access.
 */
export class InMemoryCredentialStorage {
  state = null;
  revision = 0;
  revisions = new WeakMap();
  failed = false;

  runExclusive(_reference, operation) {
    if (this.failed) throw new Error("twref2.storage-secret-must-not-reflect");
    const read = () => {
      const revision = Object.freeze({ revision: true });
      this.revisions.set(revision, this.revision);
      return {
        state: this.state === null ? null : structuredClone(this.state),
        revision,
      };
    };
    return operation({
      read,
      compareAndSwap: (expected, replacement) => {
        if (this.revisions.get(expected) !== this.revision) {
          return { status: "conflict", current: read() };
        }
        this.state = structuredClone(replacement);
        this.revision += 1;
        return { status: "swapped" };
      },
    });
  }
}

/**
 * Family B: multi-slot storage with a reentry guard; compareAndSwap always
 * swaps (no conflict detection). Options:
 * - deepFreeze: deep-freeze the read state (default false)
 * - reentryMessage: error message when runExclusive is reentered
 */
export class InMemoryReentrantCredentialStorage {
  slots = new Map();
  exclusiveDepth = 0;
  operationErrors = [];
  beforeCompareAndSwap = null;
  #freezeState;
  #reentryMessage;

  constructor(options = {}) {
    this.#freezeState = options.deepFreeze ? deepFreeze : (value) => value;
    this.#reentryMessage = options.reentryMessage ?? "injected non-reentrant credential storage";
  }

  runExclusive(reference, operation) {
    if (this.exclusiveDepth !== 0) throw new Error(this.#reentryMessage);
    const slot = slotFor(this.slots, reference);
    this.exclusiveDepth += 1;
    try {
      return operation({
        read: () => ({
          state: slot.state === null ? null : this.#freezeState(structuredClone(slot.state)),
          revision: Object.freeze({ revision: slot.revision }),
        }),
        compareAndSwap: (_expected, replacement) => {
          this.beforeCompareAndSwap?.();
          slot.state = replacement === null ? null : structuredClone(replacement);
          slot.revision += 1;
          return { status: "swapped" };
        },
      });
    } catch (error) {
      this.operationErrors.push(error);
      throw error;
    } finally {
      this.exclusiveDepth -= 1;
    }
  }

  slot(reference) {
    return slotFor(this.slots, reference);
  }

  snapshot(reference) {
    const state = slotFor(this.slots, reference).state;
    return state === null ? null : structuredClone(state);
  }

  replace(reference, state) {
    const slot = slotFor(this.slots, reference);
    slot.state = state === null ? null : structuredClone(state);
    slot.revision += 1;
  }
}

/**
 * Family A: multi-slot durable storage with opaque-revision conflict
 * detection and readCut. Options:
 * - freezeRead: deep-freeze the readCut state (default true)
 * - revisionShape: shape of the opaque revision marker (default { opaque: true })
 *
 * Fault-injection hooks are public fields set by tests:
 * - conflictsRemaining: force N conflicts before swapping
 * - uncertainNext: "before" | "after" uncertainty on the next compare
 * - uncertainCompareAttempt: specific attempt number that returns uncertain
 * - beforeExclusive: callback invoked at the start of runExclusive
 */
export class InMemoryDurableCredentialStorage {
  slots = new Map();
  revisions = new WeakMap();
  compareAttempts = 0;
  operations = 0;
  conflictsRemaining = 0;
  uncertainNext = null;
  uncertainCompareAttempt = null;
  beforeExclusive = null;
  #freezeRead;
  #revisionShape;

  constructor(options = {}) {
    this.#freezeRead = options.freezeRead ?? true;
    this.#revisionShape = options.revisionShape ?? { opaque: true };
  }

  runExclusive(reference, operation) {
    this.operations += 1;
    this.beforeExclusive?.(reference);
    const transaction = {
      read: () => this.readCut(reference),
      compareAndSwap: (expected, replacement) => {
        this.compareAttempts += 1;
        const identity = this.revisions.get(expected);
        const slot = slotFor(this.slots, reference);
        if (!identity
          || identity.reference !== reference
          || identity.revision !== slot.revision) {
          return { status: "conflict", current: this.readCut(reference) };
        }
        if (this.conflictsRemaining > 0) {
          this.conflictsRemaining -= 1;
          slot.revision += 1;
          return { status: "conflict", current: this.readCut(reference) };
        }
        const uncertainty = this.uncertainNext;
        this.uncertainNext = null;
        if (uncertainty === "before") return { status: "uncertain" };
        if (uncertainty === "after") {
          slot.state = structuredClone(replacement);
          slot.revision += 1;
          return { status: "uncertain" };
        }
        if (this.uncertainCompareAttempt === this.compareAttempts) {
          return { status: "uncertain" };
        }
        slot.state = structuredClone(replacement);
        slot.revision += 1;
        return { status: "swapped" };
      },
    };
    return operation(transaction);
  }

  snapshot(reference) {
    const state = slotFor(this.slots, reference).state;
    return state === null ? null : structuredClone(state);
  }

  replace(reference, state) {
    const slot = slotFor(this.slots, reference);
    slot.state = structuredClone(state);
    slot.revision += 1;
  }

  slot(reference) {
    return slotFor(this.slots, reference);
  }

  readCut(reference) {
    const slot = slotFor(this.slots, reference);
    const revision = Object.freeze({ ...this.#revisionShape });
    this.revisions.set(revision, { reference, revision: slot.revision });
    return {
      state: slot.state === null ? null
        : (this.#freezeRead ? deepFreeze(structuredClone(slot.state)) : structuredClone(slot.state)),
      revision,
    };
  }
}
