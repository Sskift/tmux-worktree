import type {
  DashboardLayoutLoadResult,
  DashboardLayoutPersistenceError,
  DashboardLayoutPersistenceErrorCode,
  DashboardLayoutRevision,
  DashboardLayoutSaveResult,
} from "../platform/domainTypes.ts";
import type { DashboardBackend } from "../platform/dashboardBackend.ts";
import {
  createDashboardLayoutV2,
  decodeDashboardLayout,
  type DashboardLayoutDecodeOutcome,
  type DashboardLayoutExtensions,
} from "./layout/schema.ts";
import type { DashboardLayoutPreferences } from "./layout/types.ts";

type LayoutBackend = Pick<DashboardBackend, "persistence">;

export type DashboardLayoutPersistenceOutcome = DashboardLayoutDecodeOutcome & {
  revision: DashboardLayoutRevision;
};

const EMPTY_DASHBOARD_LAYOUT_EXTENSIONS: DashboardLayoutExtensions = Object.freeze({});
const DASHBOARD_LAYOUT_REVISION = /^twlr1_[A-Za-z0-9_-]{43}$/;
const LAYOUT_ERROR_CODES = new Set<DashboardLayoutPersistenceErrorCode>([
  "LAYOUT_REVISION_CONFLICT",
  "LAYOUT_STATE_BLOCKED",
  "LAYOUT_INVALID_REQUEST",
  "LAYOUT_IO_ERROR",
]);

function protocolError(message: string): DashboardLayoutPersistenceError {
  const error = Object.create(null) as DashboardLayoutPersistenceError;
  Object.defineProperties(error, {
    code: {
      configurable: false,
      enumerable: true,
      value: "LAYOUT_INVALID_REQUEST",
      writable: false,
    },
    message: {
      configurable: false,
      enumerable: true,
      value: message,
      writable: false,
    },
    retryable: {
      configurable: false,
      enumerable: true,
      value: false,
      writable: false,
    },
  });
  return error;
}

function ownDataEnvelope(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const stringKeys = keys as string[];
    if (
      stringKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !stringKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function isDashboardLayoutRevision(
  value: unknown,
): value is DashboardLayoutRevision {
  return typeof value === "string" && DASHBOARD_LAYOUT_REVISION.test(value);
}

function decodeLayoutLoadResult(value: unknown): DashboardLayoutLoadResult {
  const envelope = ownDataEnvelope(value, ["layout", "revision"]);
  if (!envelope || !isDashboardLayoutRevision(envelope.revision)) {
    throw protocolError("Invalid dashboard layout load envelope");
  }
  return {
    layout: envelope.layout,
    revision: envelope.revision,
  };
}

function decodeLayoutSaveResult(value: unknown): DashboardLayoutSaveResult {
  const envelope = ownDataEnvelope(value, ["revision", "unchanged"]);
  if (
    !envelope ||
    !isDashboardLayoutRevision(envelope.revision) ||
    typeof envelope.unchanged !== "boolean"
  ) {
    throw protocolError("Invalid dashboard layout save envelope");
  }
  return {
    revision: envelope.revision,
    unchanged: envelope.unchanged,
  };
}

function decodeDashboardLayoutPersistenceError(
  value: unknown,
): DashboardLayoutPersistenceError | null {
  if (!value || typeof value !== "object") return null;
  let keys: readonly string[];
  try {
    keys = Object.prototype.hasOwnProperty.call(value, "currentRevision")
      ? ["code", "message", "retryable", "currentRevision"]
      : ["code", "message", "retryable"];
  } catch {
    return null;
  }
  const error = ownDataEnvelope(value, keys);
  if (
    !error ||
    typeof error.code !== "string" ||
    !LAYOUT_ERROR_CODES.has(error.code as DashboardLayoutPersistenceErrorCode) ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean"
  ) {
    return null;
  }
  const hasCurrentRevision = Object.prototype.hasOwnProperty.call(
    error,
    "currentRevision",
  );
  if (hasCurrentRevision && !isDashboardLayoutRevision(error.currentRevision)) return null;
  let valid = false;
  switch (error.code as DashboardLayoutPersistenceErrorCode) {
    case "LAYOUT_IO_ERROR":
      valid = error.retryable === true && !hasCurrentRevision;
      break;
    case "LAYOUT_REVISION_CONFLICT":
    case "LAYOUT_STATE_BLOCKED":
      valid = error.retryable === false && hasCurrentRevision;
      break;
    case "LAYOUT_INVALID_REQUEST":
      valid = error.retryable === false && !hasCurrentRevision;
      break;
  }
  return valid ? error as DashboardLayoutPersistenceError : null;
}

export function isDashboardLayoutPersistenceError(
  value: unknown,
): value is DashboardLayoutPersistenceError {
  return decodeDashboardLayoutPersistenceError(value) !== null;
}

export function classifyDashboardLayoutPersistenceFailure(
  value: unknown,
): "retry" | "block" {
  const error = decodeDashboardLayoutPersistenceError(value);
  return error?.code === "LAYOUT_IO_ERROR"
    ? "retry"
    : "block";
}

export async function loadDashboardLayoutPreferences(
  backend: LayoutBackend,
): Promise<DashboardLayoutPersistenceOutcome> {
  const envelope = decodeLayoutLoadResult(await backend.persistence.loadLayout());
  return {
    ...decodeDashboardLayout(envelope.layout),
    revision: envelope.revision,
  };
}

export async function saveDashboardLayoutPreferences(
  backend: LayoutBackend,
  preferences: DashboardLayoutPreferences,
  expectedRevision: DashboardLayoutRevision,
  extensions: DashboardLayoutExtensions = EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,
): Promise<DashboardLayoutSaveResult> {
  if (!isDashboardLayoutRevision(expectedRevision)) {
    throw protocolError("Invalid dashboard layout expected revision");
  }
  const result = await backend.persistence.saveLayout(
    createDashboardLayoutV2(preferences, extensions),
    expectedRevision,
  );
  return decodeLayoutSaveResult(result);
}
