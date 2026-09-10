import { TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES } from "./protocol";

/** tmux option storing the current output-capture generation on a session. */
export const OUTPUT_GENERATION_OPTION = "@tw_terminal_control_output_generation_v1";

/** Default timeout for a single tmux command. */
export const COMMAND_TIMEOUT_MS = 5_000;

/** Upper bound on tmux stdout/stderr captured for a single command. */
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

/** Maximum size of one output-capture file before rotation is required. */
export const MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;

/** Size of each segmented output-capture segment. */
export const OUTPUT_SEGMENT_BYTES = TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES;

/** Number of segmented output-capture segments retained per generation. */
export const MAX_OUTPUT_SEGMENTS = 2;

/** Pace between agent-message submit retries. */
export const AGENT_MESSAGE_SUBMIT_PACE_MS = 100;

/** Upper bound on a captured pane snapshot used as a render source. */
export const MAX_RENDERED_SNAPSHOT_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Idle-exit budget for an auto-started terminal-control daemon. The daemon
 * exits this long after its last request once no live terminal work remains
 * (no open Relay v2 observation/compound channel, no active input lease), so
 * detached+unref'd autostart children cannot accumulate as launchd orphans.
 * Kept in lockstep with the Rust spawner's `DAEMON_IDLE_EXIT_MS`
 * (app/src-tauri/src/features/terminal_control.rs): the two spawn paths must
 * retire daemons on the same schedule.
 */
export const TERMINAL_CONTROL_DAEMON_IDLE_EXIT_MS = 600_000;
