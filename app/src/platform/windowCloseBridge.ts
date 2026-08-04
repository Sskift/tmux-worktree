import type {
  BackendUnlisten,
  DashboardCloseHandler,
  DashboardWindowCloseLifecycle,
} from "./types";

export type NativeDashboardCloseRequest = {
  preventDefault(): void;
};

export type WindowCloseBridgeDependencies = {
  onCloseRequested(
    handler: (event: NativeDashboardCloseRequest) => void,
  ): Promise<BackendUnlisten>;
  destroy(): Promise<void>;
  schedule?(callback: () => void, delayMs: number): BackendUnlisten;
};

type CloseBinding = {
  handler: DashboardCloseHandler;
  token: object;
};

type CloseCycle = {
  controller: AbortController;
  deadlineCancel: BackendUnlisten | null;
  destroyStarted: boolean;
  handlerStarted: boolean;
};

const CLOSE_DEADLINE_MS = 2_000;

function defaultSchedule(callback: () => void, delayMs: number): BackendUnlisten {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

export function createWindowCloseBridge(
  dependencies: WindowCloseBridgeDependencies,
): DashboardWindowCloseLifecycle {
  const schedule = dependencies.schedule ?? defaultSchedule;
  let binding: CloseBinding | null = null;
  let cycle: CloseCycle | null = null;
  let destroyed = false;

  const cancelDeadline = (candidate: CloseCycle) => {
    const cancel = candidate.deadlineCancel;
    candidate.deadlineCancel = null;
    if (!cancel) return;
    try {
      cancel();
    } catch {
      // Timer cancellation is fenced by the active cycle identity.
    }
  };

  const settleDestroy = (candidate: CloseCycle, succeeded: boolean) => {
    if (cycle !== candidate) return;
    cycle = null;
    if (succeeded) destroyed = true;
  };

  const finishCycle = (candidate: CloseCycle) => {
    if (cycle !== candidate || candidate.destroyStarted) return;
    candidate.destroyStarted = true;
    cancelDeadline(candidate);
    candidate.controller.abort();

    let result: Promise<void>;
    try {
      result = dependencies.destroy();
    } catch {
      settleDestroy(candidate, false);
      return;
    }
    try {
      void result.then(
        () => settleDestroy(candidate, true),
        () => settleDestroy(candidate, false),
      );
    } catch {
      settleDestroy(candidate, false);
    }
  };

  const startBoundHandler = (candidate: CloseCycle) => {
    if (
      cycle !== candidate ||
      candidate.destroyStarted ||
      candidate.handlerStarted ||
      binding === null
    ) {
      return;
    }
    candidate.handlerStarted = true;
    const handler = binding.handler;
    let result: void | Promise<void>;
    try {
      result = handler(candidate.controller.signal);
    } catch {
      finishCycle(candidate);
      return;
    }
    try {
      void Promise.resolve(result).then(
        () => finishCycle(candidate),
        () => finishCycle(candidate),
      );
    } catch {
      finishCycle(candidate);
    }
  };

  const startCycle = () => {
    if (destroyed || cycle !== null) return;
    const candidate: CloseCycle = {
      controller: new AbortController(),
      deadlineCancel: null,
      destroyStarted: false,
      handlerStarted: false,
    };
    cycle = candidate;

    let deadlineCancel: BackendUnlisten;
    try {
      deadlineCancel = schedule(() => finishCycle(candidate), CLOSE_DEADLINE_MS);
    } catch {
      finishCycle(candidate);
      return;
    }
    if (cycle === candidate && !candidate.destroyStarted) {
      candidate.deadlineCancel = deadlineCancel;
    } else {
      try {
        deadlineCancel();
      } catch {
        // The cycle is already fenced if scheduling completed reentrantly.
      }
    }
    startBoundHandler(candidate);
  };

  function handleNativeClose(event: NativeDashboardCloseRequest): void {
    event.preventDefault();
    startCycle();
  }

  try {
    void dependencies.onCloseRequested(handleNativeClose).catch(() => {});
  } catch {
    // Registration failures must not become startup or unhandled failures.
  }

  return {
    bind(handler) {
      const token = {};
      binding = { handler, token };
      if (cycle !== null) startBoundHandler(cycle);
      return () => {
        if (binding?.token === token) binding = null;
      };
    },
  };
}
