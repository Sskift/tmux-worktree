import type { DashboardLayoutPreferences } from "./layout/types";

export type LayoutSaveFailureClassification = "retry" | "block";

export type LayoutSaveAuthorization = {
  attempt: number;
  write(snapshot: DashboardLayoutPreferences): Promise<void>;
  classifyFailure(error: unknown): LayoutSaveFailureClassification;
};

export type LayoutSaveScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

export type LayoutSaveCoordinatorOptions = {
  debounceMs: number;
  schedule: LayoutSaveScheduler;
  retryDelayMs(): number;
  onError(error: unknown): void;
  onRecovered(): void;
  onBlocked(error: unknown): void;
};

export type LayoutSaveCoordinator = {
  beginAttempt(attempt: number): void;
  authorize(authorization: LayoutSaveAuthorization): void;
  enqueue(attempt: number, snapshot: DashboardLayoutPreferences): void;
  block(attempt: number): void;
  stop(): void;
};

type PendingSave = {
  attempt: number;
  debounceReady: boolean;
  snapshot: DashboardLayoutPreferences;
};

type ExactRetrySave = {
  attempt: number;
  snapshot: DashboardLayoutPreferences;
};

type InFlightSave = {
  attempt: number;
  authorization: LayoutSaveAuthorization;
  snapshot: DashboardLayoutPreferences;
};

const PRIMITIVE_LAYOUT_KEYS = [
  "left",
  "right",
  "gitHeight",
  "sectionSplit",
  "automationHeight",
  "automationSectionCollapsed",
  "scratchCollapsed",
  "scratchWidth",
  "fileBrowserOpen",
  "fileTreeWidth",
  "editorWidth",
  "sidebarWidth",
  "inspectorWidth",
  "sidebarOpen",
  "sidebarView",
  "inspectorOpen",
  "inspectorTab",
] as const;

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function defineOwn<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K],
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function cloneRecord<T extends object>(value: T): T {
  const clone = Object.create(null) as T;
  for (const [key, field] of Object.entries(value)) {
    defineOwn(clone, key as keyof T, field as T[keyof T]);
  }
  return clone;
}

function cloneLayoutSnapshot(
  source: DashboardLayoutPreferences,
): DashboardLayoutPreferences {
  const snapshot = Object.create(null) as DashboardLayoutPreferences;
  defineOwn(snapshot, "columnOrder", [...source.columnOrder]);

  for (const key of PRIMITIVE_LAYOUT_KEYS) {
    if (hasOwn(source, key)) defineOwn(snapshot, key, source[key]);
  }
  if (hasOwn(source, "sessionOrder")) {
    defineOwn(snapshot, "sessionOrder", source.sessionOrder ? [...source.sessionOrder] : undefined);
  }
  if (hasOwn(source, "collapsedProjects")) {
    defineOwn(
      snapshot,
      "collapsedProjects",
      source.collapsedProjects ? [...source.collapsedProjects] : undefined,
    );
  }
  if (hasOwn(source, "pinnedItems")) {
    defineOwn(
      snapshot,
      "pinnedItems",
      source.pinnedItems?.map((item) => cloneRecord(item)),
    );
  }
  if (hasOwn(source, "selection")) {
    defineOwn(
      snapshot,
      "selection",
      source.selection === null || source.selection === undefined
        ? source.selection
        : cloneRecord(source.selection),
    );
  }
  if (hasOwn(source, "editingFile")) {
    defineOwn(
      snapshot,
      "editingFile",
      source.editingFile === null || source.editingFile === undefined
        ? source.editingFile
        : cloneRecord(source.editingFile),
    );
  }
  if (hasOwn(source, "diffFile")) {
    defineOwn(
      snapshot,
      "diffFile",
      source.diffFile === null || source.diffFile === undefined
        ? source.diffFile
        : cloneRecord(source.diffFile),
    );
  }
  if (hasOwn(source, "window")) {
    defineOwn(
      snapshot,
      "window",
      source.window === undefined ? undefined : cloneRecord(source.window),
    );
  }
  return snapshot;
}

export function createLayoutSaveCoordinator(
  options: LayoutSaveCoordinatorOptions,
): LayoutSaveCoordinator {
  let stopped = false;
  let currentAttempt: number | null = null;
  let currentBlocked = true;
  let authorization: LayoutSaveAuthorization | null = null;
  let pending: PendingSave | null = null;
  let exactRetry: ExactRetrySave | null = null;
  let inFlight: InFlightSave | null = null;
  let debounceToken: object | null = null;
  let cancelDebounce: (() => void) | null = null;
  let retryToken: object | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryBlocked = false;
  let errorOutstanding = false;

  const notify = (callback: () => void) => {
    try {
      callback();
    } catch {
      // Notification callbacks must never corrupt persistence state.
    }
  };

  const cancel = (callback: (() => void) | null) => {
    if (!callback) return;
    try {
      callback();
    } catch {
      // A scheduler cancellation failure is already fenced by task identity.
    }
  };

  const clearDebounce = () => {
    debounceToken = null;
    const callback = cancelDebounce;
    cancelDebounce = null;
    cancel(callback);
  };

  const clearRetry = () => {
    retryToken = null;
    retryBlocked = false;
    const callback = cancelRetry;
    cancelRetry = null;
    cancel(callback);
  };

  const isCurrentAuthorization = (candidate: LayoutSaveAuthorization): boolean =>
    !stopped &&
    !currentBlocked &&
    currentAttempt === candidate.attempt &&
    authorization === candidate;

  const blockCurrent = (attempt: number): boolean => {
    if (stopped || currentAttempt !== attempt) return false;
    currentBlocked = true;
    authorization = null;
    pending = null;
    exactRetry = null;
    errorOutstanding = false;
    clearDebounce();
    clearRetry();
    return true;
  };

  let pump = () => {};

  const scheduleDebounce = (attempt: number) => {
    clearDebounce();
    const token = {};
    debounceToken = token;
    let scheduledCancel: (() => void) | null = null;
    let scheduling = true;
    let firedSynchronously = false;
    const run = () => {
      if (scheduling) {
        firedSynchronously = true;
        return;
      }
      if (
        stopped ||
        debounceToken !== token ||
        currentAttempt !== attempt
      ) {
        return;
      }
      const currentPending = pending;
      if (currentPending === null || currentPending.attempt !== attempt) return;
      debounceToken = null;
      cancelDebounce = null;
      currentPending.debounceReady = true;
      pump();
    };
    try {
      scheduledCancel = options.schedule(run, options.debounceMs);
    } catch (error) {
      scheduling = false;
      if (debounceToken === token && blockCurrent(attempt)) {
        notify(() => options.onBlocked(error));
      }
      return;
    }
    scheduling = false;
    if (debounceToken === token) {
      cancelDebounce = scheduledCancel;
      if (firedSynchronously) queueMicrotask(run);
    } else {
      cancel(scheduledCancel);
    }
  };

  const scheduleRetry = (
    attempt: number,
    failure: unknown,
  ): boolean => {
    clearRetry();
    retryBlocked = true;
    const token = {};
    retryToken = token;
    notify(() => options.onError(failure));
    if (
      stopped ||
      currentBlocked ||
      currentAttempt !== attempt ||
      retryToken !== token
    ) {
      return false;
    }
    let delayMs: number;
    try {
      delayMs = options.retryDelayMs();
    } catch (error) {
      if (retryToken === token && blockCurrent(attempt)) {
        notify(() => options.onBlocked(error));
      }
      return false;
    }

    let scheduledCancel: (() => void) | null = null;
    let scheduling = true;
    let firedSynchronously = false;
    const run = () => {
      if (scheduling) {
        firedSynchronously = true;
        return;
      }
      if (
        stopped ||
        retryToken !== token ||
        currentAttempt !== attempt ||
        currentBlocked
      ) {
        return;
      }
      retryToken = null;
      cancelRetry = null;
      retryBlocked = false;
      pump();
    };
    try {
      scheduledCancel = options.schedule(run, delayMs);
    } catch (error) {
      scheduling = false;
      if (retryToken === token && blockCurrent(attempt)) {
        notify(() => options.onBlocked(error));
      }
      return false;
    }
    scheduling = false;
    if (retryToken === token) {
      cancelRetry = scheduledCancel;
      if (firedSynchronously) queueMicrotask(run);
    } else {
      cancel(scheduledCancel);
    }
    return true;
  };

  const settleSuccess = (flight: InFlightSave) => {
    if (inFlight !== flight) return;
    inFlight = null;
    if (!isCurrentAuthorization(flight.authorization)) {
      pump();
      return;
    }
    if (pending === null && exactRetry === null && errorOutstanding) {
      errorOutstanding = false;
      notify(options.onRecovered);
    }
    pump();
  };

  const settleFailure = (flight: InFlightSave, error: unknown) => {
    if (inFlight !== flight) return;
    inFlight = null;
    if (!isCurrentAuthorization(flight.authorization)) {
      pump();
      return;
    }

    let classification: LayoutSaveFailureClassification = "block";
    try {
      classification = flight.authorization.classifyFailure(error);
    } catch {
      classification = "block";
    }
    if (!isCurrentAuthorization(flight.authorization)) {
      pump();
      return;
    }
    if (classification !== "retry") {
      if (blockCurrent(flight.attempt)) notify(() => options.onBlocked(error));
      pump();
      return;
    }

    exactRetry = {
      attempt: flight.attempt,
      snapshot: flight.snapshot,
    };
    errorOutstanding = true;
    scheduleRetry(flight.attempt, error);
  };

  const startWrite = (
    candidateAuthorization: LayoutSaveAuthorization,
    entry: ExactRetrySave,
  ) => {
    const flight: InFlightSave = {
      attempt: entry.attempt,
      authorization: candidateAuthorization,
      snapshot: entry.snapshot,
    };
    inFlight = flight;

    let result: Promise<void>;
    try {
      result = candidateAuthorization.write(entry.snapshot);
    } catch (error) {
      settleFailure(flight, error);
      return;
    }
    try {
      void result.then(
        () => settleSuccess(flight),
        (error) => settleFailure(flight, error),
      );
    } catch (error) {
      settleFailure(flight, error);
    }
  };

  pump = () => {
    if (
      stopped ||
      inFlight !== null ||
      retryBlocked ||
      authorization === null ||
      currentBlocked ||
      currentAttempt !== authorization.attempt
    ) {
      return;
    }
    if (
      exactRetry !== null &&
      exactRetry.attempt === currentAttempt
    ) {
      const retry = exactRetry;
      exactRetry = null;
      startWrite(authorization, retry);
      return;
    }
    if (
      pending === null ||
      !pending.debounceReady ||
      pending.attempt !== currentAttempt
    ) {
      return;
    }
    const latest = pending;
    pending = null;
    clearDebounce();
    startWrite(authorization, latest);
  };

  return {
    beginAttempt(attempt) {
      if (stopped || (currentAttempt !== null && attempt <= currentAttempt)) return;
      currentAttempt = attempt;
      currentBlocked = false;
      authorization = null;
      pending = null;
      exactRetry = null;
      errorOutstanding = false;
      clearDebounce();
      clearRetry();
    },

    authorize(candidateAuthorization) {
      if (
        stopped ||
        currentBlocked ||
        currentAttempt !== candidateAuthorization.attempt
      ) {
        return;
      }
      authorization = candidateAuthorization;
      pump();
    },

    enqueue(attempt, snapshot) {
      if (
        stopped ||
        currentBlocked ||
        currentAttempt !== attempt ||
        authorization?.attempt !== attempt
      ) {
        return;
      }
      clearDebounce();
      pending = null;
      pending = {
        attempt,
        debounceReady: false,
        snapshot: cloneLayoutSnapshot(snapshot),
      };
      scheduleDebounce(attempt);
    },

    block(attempt) {
      blockCurrent(attempt);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      currentBlocked = true;
      authorization = null;
      pending = null;
      exactRetry = null;
      errorOutstanding = false;
      clearDebounce();
      clearRetry();
    },
  };
}
