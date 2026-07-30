export const RELAY_V2_HOST_CONNECTOR_MONITOR_INTERVAL_MS = 250;
export const RELAY_V2_HOST_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const RELAY_V2_HOST_RECONNECT_MAXIMUM_DELAY_MS = 15_000;

export function nextRelayV2HostReconnectDelayMs(
  currentDelayMs: number,
  maximumDelayMs: number,
): number {
  return Math.min(currentDelayMs * 2, maximumDelayMs);
}

export function waitForRelayV2HostReconnectDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
