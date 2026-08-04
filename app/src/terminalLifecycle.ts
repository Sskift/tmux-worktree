type ReconnectInput = {
  cancelled: boolean;
  hasTmuxSession: boolean;
  sessionStillExists: boolean;
  sessionProbeFailed?: boolean;
  isRemote?: boolean;
  remoteReconnectAttempt?: number;
};

export const TMUX_RECONNECT_DELAY_MS = 200;
export const REMOTE_RECONNECT_BASE_DELAY_MS = 1_000;
export const REMOTE_RECONNECT_MAX_DELAY_MS = 15_000;
export const REMOTE_RECONNECT_MAX_ATTEMPTS = 6;

export function remoteReconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    REMOTE_RECONNECT_MAX_DELAY_MS,
    REMOTE_RECONNECT_BASE_DELAY_MS * 2 ** normalizedAttempt,
  );
}

export function shouldReconnectTmuxAttach({
  cancelled,
  hasTmuxSession,
  sessionStillExists,
  sessionProbeFailed = false,
  isRemote = false,
  remoteReconnectAttempt = 0,
}: ReconnectInput): boolean {
  if (cancelled || !hasTmuxSession) return false;
  if (!isRemote) return sessionStillExists;
  if (!sessionStillExists && !sessionProbeFailed) return false;

  // Both SSH probe failures and repeated attach failures can otherwise loop
  // forever. The caller applies backoff and only resets this shared budget
  // after the remote PTY has remained healthy.
  return remoteReconnectAttempt < REMOTE_RECONNECT_MAX_ATTEMPTS;
}
