import type { DashboardWindow } from "../platform";
import type { WindowLayout } from "./layout/types";

export type WindowCaptureResult =
  | { mode: "fullscreen" }
  | { mode: "maximized" }
  | { layout: WindowLayout; mode: "normal" };

export type WindowCaptureReadResult =
  | { kind: "captured"; result: WindowCaptureResult }
  | { kind: "changed" }
  | { kind: "unavailable" }
  | { kind: "cancelled" };

export type WindowCaptureCoordinatorOptions = {
  debounceMs: number;
  publish(result: WindowCaptureResult): void;
  schedule(callback: () => void, delayMs: number): () => void;
  target: DashboardWindow;
};

export type WindowCaptureCoordinator = {
  start(): void;
  stop(): void;
};

const WINDOW_DEFAULTS = { height: 900, width: 1440 };

function safeOnce(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    try {
      callback();
    } catch {
      // Window listener and timer cleanup is best-effort.
    }
  };
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

type WindowRead<T> =
  | { ok: true; value: T }
  | { ok: false };

function startWindowRead<T>(read: () => Promise<T>): Promise<WindowRead<T>> {
  try {
    return Promise.resolve(read()).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
  } catch {
    return Promise.resolve({ ok: false });
  }
}

async function readExpandedMode(
  target: DashboardWindow,
  signal: AbortSignal,
): Promise<
  | { kind: "available"; fullscreen: boolean; maximized: boolean }
  | { kind: "unavailable" }
  | { kind: "cancelled" }
> {
  if (signal.aborted) return { kind: "cancelled" };
  const fullscreenRead = startWindowRead(() => target.isFullscreen());
  const maximizedRead = startWindowRead(() => target.isMaximized());
  const fullscreen = await fullscreenRead;
  if (signal.aborted) return { kind: "cancelled" };
  if (!fullscreen.ok) return { kind: "unavailable" };
  const maximized = await maximizedRead;
  if (signal.aborted) return { kind: "cancelled" };
  if (!maximized.ok) return { kind: "unavailable" };
  return {
    kind: "available",
    fullscreen: fullscreen.value,
    maximized: maximized.value,
  };
}

export async function readWindowCapture(
  target: DashboardWindow,
  signal: AbortSignal,
): Promise<WindowCaptureReadResult> {
  if (signal.aborted) return { kind: "cancelled" };
  const expanded = await readExpandedMode(target, signal);
  if (signal.aborted || expanded.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  if (expanded.kind === "unavailable") return expanded;
  if (expanded.fullscreen) {
    return { kind: "captured", result: { mode: "fullscreen" } };
  }
  if (expanded.maximized) {
    return { kind: "captured", result: { mode: "maximized" } };
  }

  const geometryRead = startWindowRead(() => target.innerSize());
  const positionRead = startWindowRead(() => target.outerPosition());
  const factorRead = startWindowRead(() => target.scaleFactor());
  const geometry = await geometryRead;
  if (signal.aborted) return { kind: "cancelled" };
  if (!geometry.ok) return { kind: "unavailable" };
  const position = await positionRead;
  if (signal.aborted) return { kind: "cancelled" };
  if (!position.ok) return { kind: "unavailable" };
  const factor = await factorRead;
  if (signal.aborted) return { kind: "cancelled" };
  if (!factor.ok) return { kind: "unavailable" };
  if (
    !finitePositive(factor.value) ||
    !finitePositive(geometry.value.width) ||
    !finitePositive(geometry.value.height) ||
    !finite(position.value.x) ||
    !finite(position.value.y)
  ) {
    return { kind: "unavailable" };
  }

  const confirmed = await readExpandedMode(target, signal);
  if (signal.aborted || confirmed.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  if (confirmed.kind === "unavailable") return confirmed;
  if (
    confirmed.fullscreen !== expanded.fullscreen ||
    confirmed.maximized !== expanded.maximized
  ) {
    return { kind: "changed" };
  }

  const layout: WindowLayout = {
    width: Math.round(geometry.value.width / factor.value),
    height: Math.round(geometry.value.height / factor.value),
    x: Math.round(position.value.x / factor.value),
    y: Math.round(position.value.y / factor.value),
    maximized: false,
  };
  if (
    !finitePositive(layout.width) ||
    !finitePositive(layout.height) ||
    !finite(layout.x) ||
    !finite(layout.y)
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "captured", result: { layout, mode: "normal" } };
}

export function windowLayoutFromCapture(
  previous: WindowLayout | null,
  result: WindowCaptureResult,
): WindowLayout {
  if (result.mode === "fullscreen") {
    return previous ?? {
      width: WINDOW_DEFAULTS.width,
      height: WINDOW_DEFAULTS.height,
      x: 0,
      y: 0,
      maximized: false,
    };
  }
  if (result.mode === "maximized") {
    return previous
      ? { ...previous, maximized: true }
      : {
          width: WINDOW_DEFAULTS.width,
          height: WINDOW_DEFAULTS.height,
          x: 0,
          y: 0,
          maximized: true,
        };
  }
  return result.layout;
}

export function createWindowCaptureCoordinator(
  options: WindowCaptureCoordinatorOptions,
): WindowCaptureCoordinator {
  let active = false;
  let started = false;
  let generation = 0;
  let cancelDebounce: (() => void) | null = null;
  let captureController: AbortController | null = null;
  const unlisteners = new Set<() => void>();

  const isCurrent = (token: number): boolean => active && token === generation;

  const publish = (token: number, result: WindowCaptureResult) => {
    if (!isCurrent(token)) return;
    try {
      options.publish(result);
    } catch {
      // A renderer state consumer must not turn capture into an unhandled rejection.
    }
  };

  const clearDebounce = () => {
    const cancel = cancelDebounce;
    cancelDebounce = null;
    cancel?.();
  };

  let requestBaseline = () => {};

  const capture = async (token: number) => {
    if (!isCurrent(token)) return;
    const controller = new AbortController();
    captureController = controller;
    const outcome = await readWindowCapture(options.target, controller.signal);
    if (captureController === controller) captureController = null;
    if (!isCurrent(token)) return;
    if (outcome.kind === "captured") {
      publish(token, outcome.result);
    } else if (outcome.kind === "changed") {
      requestBaseline();
    }
  };

  const nextGeneration = () => {
    const token = ++generation;
    captureController?.abort();
    captureController = null;
    return token;
  };

  requestBaseline = () => {
    if (!active) return;
    const token = nextGeneration();
    clearDebounce();
    void capture(token);
  };

  const scheduleCapture = () => {
    if (!active) return;
    const token = nextGeneration();
    clearDebounce();
    let scheduling = true;
    let firedSynchronously = false;
    const run = () => {
      if (scheduling) {
        firedSynchronously = true;
        return;
      }
      if (!isCurrent(token)) return;
      cancelDebounce = null;
      void capture(token);
    };
    let scheduledCancel: (() => void) | null = null;
    try {
      scheduledCancel = safeOnce(options.schedule(run, options.debounceMs));
    } catch {
      scheduling = false;
      if (isCurrent(token)) requestBaseline();
      return;
    }
    scheduling = false;
    if (!isCurrent(token)) {
      scheduledCancel();
      return;
    }
    cancelDebounce = scheduledCancel;
    if (firedSynchronously) queueMicrotask(run);
  };

  const requestTrailingCapture = () => {
    if (!active || cancelDebounce !== null) return;
    scheduleCapture();
  };

  const registerListener = (
    register: (handler: () => void) => Promise<() => void>,
  ) => {
    let pending: Promise<() => void>;
    try {
      pending = register(scheduleCapture);
    } catch {
      requestTrailingCapture();
      return;
    }
    void Promise.resolve(pending).then(
      (unlisten) => {
        const safeUnlisten = safeOnce(unlisten);
        if (!active) {
          safeUnlisten();
          return;
        }
        unlisteners.add(safeUnlisten);
        requestTrailingCapture();
      },
      () => {
        requestTrailingCapture();
      },
    );
  };

  return {
    start() {
      if (started) return;
      started = true;
      active = true;
      requestBaseline();
      registerListener((handler) => options.target.onResized(handler));
      registerListener((handler) => options.target.onMoved(handler));
    },

    stop() {
      if (!active) return;
      active = false;
      generation += 1;
      captureController?.abort();
      captureController = null;
      clearDebounce();
      for (const unlisten of unlisteners) unlisten();
      unlisteners.clear();
    },
  };
}
