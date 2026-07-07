type ReconnectInput = {
  cancelled: boolean;
  hasTmuxSession: boolean;
  sessionStillExists: boolean;
  isRemote?: boolean;
};

export const TMUX_RECONNECT_DELAY_MS = 200;

export function shouldReconnectTmuxAttach({
  cancelled,
  hasTmuxSession,
  sessionStillExists,
  isRemote = false,
}: ReconnectInput): boolean {
  return !isRemote && !cancelled && hasTmuxSession && sessionStillExists;
}
