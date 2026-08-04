import { useEffect, useLayoutEffect, useRef } from "react";
import { PollingController } from "./pollingController";

type Options = {
  enabled?: boolean;
  visibleIntervalMs: number;
  hiddenIntervalMs: number;
  refreshKey?: string;
  restartKey?: unknown;
};

export function useVisibilityAwarePolling(
  task: () => void | Promise<void>,
  {
    enabled = true,
    visibleIntervalMs,
    hiddenIntervalMs,
    refreshKey = "",
    restartKey,
  }: Options,
): void {
  const taskRef = useRef(task);
  useLayoutEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new PollingController({
      task: () => taskRef.current(),
      visibleIntervalMs,
      hiddenIntervalMs,
      clock: {
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (id) => window.clearTimeout(id as number),
      },
      visibility: {
        isHidden: () => document.hidden,
        subscribe: (handler) => {
          document.addEventListener("visibilitychange", handler);
          return () => document.removeEventListener("visibilitychange", handler);
        },
      },
    });
    controller.start();
    return () => controller.stop();
  }, [enabled, hiddenIntervalMs, refreshKey, restartKey, visibleIntervalMs]);
}
