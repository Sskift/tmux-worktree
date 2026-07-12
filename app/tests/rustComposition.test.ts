import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const expectedTauriCommands = [
  "list_dashboard_catalog",
  "list_local_dashboard_catalog",
  "list_sessions",
  "tmux_session_exists",
  "list_projects",
  "add_project",
  "create_worktree",
  "kill_session",
  "list_orphaned_worktrees",
  "restore_worktree",
  "delete_worktree",
  "session_cwd",
  "session_root",
  "cancel_copy_mode",
  "copy_mode_cancel_if_active",
  "apply_tmux_theme",
  "copy_tmux_selection",
  "capture_pane_history",
  "git_status",
  "git_fetch_project_roots",
  "git_graph_refs",
  "git_graph",
  "git_diff",
  "list_tmux_terminals",
  "create_terminal",
  "ensure_terminal_session",
  "kill_plain_terminal",
  "load_terminals",
  "save_terminals",
  "load_layout",
  "save_layout",
  "list_automations",
  "save_automation",
  "delete_automation",
  "trigger_automation",
  "list_automation_runs",
  "home_dir",
  "pty_open",
  "pty_write",
  "pty_resize",
  "pty_kill",
  "read_dir",
  "read_file",
  "write_file",
  "remote_read_file",
  "remote_read_file_base64",
  "remote_write_file",
  "search_files",
  "open_url",
  "file_exists",
  "remote_file_exists",
  "list_hosts",
  "list_ssh_host_candidates",
  "add_host",
  "update_host",
  "remove_host",
  "test_host",
  "install_host_tw",
  "host_statuses",
  "list_remote_projects",
  "remote_home_dir",
  "remote_read_dir",
  "probe_agents",
  "mobile_relay_start",
  "mobile_relay_start_broker",
  "mobile_relay_save_config",
  "mobile_relay_stop",
  "mobile_relay_status",
] as const;

function leafName(path: string): string {
  const segments = path.trim().split("::");
  return segments.at(-1) ?? path.trim();
}

function readTauriCompositionSource(): string {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const testModuleStart = source.lastIndexOf("\n#[cfg(test)]\nmod tests {");
  return testModuleStart >= 0 ? source.slice(0, testModuleStart) : source;
}

test("tauri exposes exactly the frozen 68 dashboard commands", () => {
  const rust = readTauriCompositionSource();
  const handlerBlocks = [...rust.matchAll(/tauri::generate_handler!\[([\s\S]*?)\]/g)];

  assert.equal(handlerBlocks.length, 1, "there must be one authoritative Tauri handler registry");
  const commands = handlerBlocks[0][1]
    .split(",")
    .map((command) => command.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map(leafName);

  assert.equal(commands.length, 68);
  assert.deepEqual(commands, expectedTauriCommands);
  assert.equal(new Set(commands).size, commands.length, "Tauri commands must not be registered twice");
});

test("tauri composition owns the four long-lived states and exit cleanup", () => {
  const rust = readTauriCompositionSource();
  const managedStates = [...rust.matchAll(
    /app\.manage\(\s*Arc::new\(\s*([A-Za-z_][A-Za-z0-9_:]*)::default\(\)\s*\)\s*\)/g,
  )].map((match) => leafName(match[1]));

  assert.deepEqual(
    [...managedStates].sort(),
    ["PtyState", "MobileRelayState", "GitFetchState", "HostState"].sort(),
  );
  assert.equal(new Set(managedStates).size, 4, "each long-lived state must have one owner");
  assert.match(rust, /setup_clipboard_bindings\(\);/);
  assert.match(rust, /restore_window_layout\(&app\.handle\(\)\);/);
  assert.match(rust, /\.build\(tauri::generate_context!\(\)\)/);
  assert.match(
    rust,
    /tauri::RunEvent::ExitRequested \{ \.\. \} \| tauri::RunEvent::Exit => \{\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*cleanup_pending_worktrees\(\);\s*let relay_state = app\.state::<Arc<(?:[A-Za-z_][A-Za-z0-9_]*::)*MobileRelayState>>\(\);\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*stop_mobile_relay_processes\(relay_state\.inner\(\)\.as_ref\(\)\);\s*\}/s,
  );
});
