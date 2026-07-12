import type { DashboardWindow } from "../platform";
import type { WindowLayout } from "./layout/types";

export type WindowCaptureResult =
  | { mode: "fullscreen" }
  | { mode: "maximized" }
  | { layout: WindowLayout; mode: "normal" };

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

  const readExpanded = async () => {
    const [fullscreen, maximized] = await Promise.all([
      options.target.isFullscreen(),
      options.target.isMaximized(),
    ]);
    return { fullscreen, maximized };
  };

  let requestBaseline = () => {};

  const capture = async (token: number) => {
    if (!isCurrent(token)) return;
    let expanded: { fullscreen: boolean; maximized: boolean };
    try {
      expanded = await readExpanded();
    } catch {
      return;
    }
    if (!isCurrent(token)) return;
    if (expanded.fullscreen) {
      publish(token, { mode: "fullscreen" });
      return;
    }
    if (expanded.maximized) {
      publish(token, { mode: "maximized" });
      return;
    }

    if (!isCurrent(token)) return;
    let geometry: Awaited<ReturnType<DashboardWindow["innerSize"]>>;
    let position: Awaited<ReturnType<DashboardWindow["outerPosition"]>>;
    let factor: number;
    try {
      [geometry, position, factor] = await Promise.all([
        options.target.innerSize(),
        options.target.outerPosition(),
        options.target.scaleFactor(),
      ]);
    } catch {
      return;
    }
    if (!isCurrent(token)) return;
    if (
      !finitePositive(factor) ||
      !finitePositive(geometry.width) ||
      !finitePositive(geometry.height) ||
      !finite(position.x) ||
      !finite(position.y)
    ) {
      return;
    }

    if (!isCurrent(token)) return;
    let confirmed: { fullscreen: boolean; maximized: boolean };
    try {
      confirmed = await readExpanded();
    } catch {
      return;
    }
    if (!isCurrent(token)) return;
    if (
      confirmed.fullscreen !== expanded.fullscreen ||
      confirmed.maximized !== expanded.maximized
    ) {
      requestBaseline();
      return;
    }

    const layout: WindowLayout = {
      width: Math.round(geometry.width / factor),
      height: Math.round(geometry.height / factor),
      x: Math.round(position.x / factor),
      y: Math.round(position.y / factor),
      maximized: false,
    };
    if (
      !finitePositive(layout.width) ||
      !finitePositive(layout.height) ||
      !finite(layout.x) ||
      !finite(layout.y) ||
      !isCurrent(token)
    ) {
      return;
    }
    publish(token, { layout, mode: "normal" });
  };

  requestBaseline = () => {
    if (!active) return;
    const token = ++generation;
    clearDebounce();
    void capture(token);
  };

  const scheduleCapture = () => {
    if (!active) return;
    const token = ++generation;
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
      clearDebounce();
      for (const unlisten of unlisteners) unlisten();
      unlisteners.clear();
    },
  };
}
