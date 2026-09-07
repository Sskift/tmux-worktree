/** Maximum time allowed for the optional login-shell Codex environment snapshot. */
export const TERMINAL_CONTROL_CODEX_ENVIRONMENT_HYDRATION_TIMEOUT_MS = 10_000;

/**
 * Maximum post-hydration window used to resume an Agent and deliver one exact
 * submitted message into its fenced pane.
 */
export const TERMINAL_CONTROL_AGENT_RESUME_INPUT_TIMEOUT_MS = 20_000;

/** Longest legitimate backend window before an Agent message has been delivered. */
export const TERMINAL_CONTROL_AGENT_MESSAGE_BACKEND_MAX_MS =
  TERMINAL_CONTROL_CODEX_ENVIRONMENT_HYDRATION_TIMEOUT_MS
  + TERMINAL_CONTROL_AGENT_RESUME_INPUT_TIMEOUT_MS;

/**
 * End-to-end request cap. The margin covers daemon/channel setup and ensures
 * transports cannot retire an operation while the backend is still within
 * its documented cold-resume window.
 */
export const TERMINAL_CONTROL_AGENT_MESSAGE_REQUEST_TIMEOUT_MS =
  TERMINAL_CONTROL_AGENT_MESSAGE_BACKEND_MAX_MS + 15_000;

/** The daemon must never close an otherwise live request before its caller. */
export const TERMINAL_CONTROL_SERVER_SOCKET_IDLE_TIMEOUT_MS =
  TERMINAL_CONTROL_AGENT_MESSAGE_REQUEST_TIMEOUT_MS + 5_000;
