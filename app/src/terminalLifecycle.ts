type ReconnectInput = {
  cancelled: boolean;
  hasTmuxSession: boolean;
  sessionStillExists: boolean;
};

export const TMUX_RECONNECT_DELAY_MS = 200;

export function shouldReconnectTmuxAttach({
  cancelled,
  hasTmuxSession,
  sessionStillExists,
}: ReconnectInput): boolean {
  return !cancelled && hasTmuxSession && sessionStillExists;
}
