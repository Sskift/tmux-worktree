import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRustProductionSource, readRustSourceFiles } from "./rustSource.ts";

const expectedTauriCommands = [
  "list_dashboard_catalog",
  "list_local_dashboard_catalog",
  "list_sessions",
  "tmux_session_exists",
  "list_projects",
  "add_project",
  "remove_missing_project",
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
  "pty_control_status",
  "pty_control_takeover",
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

const expectedRootRustTests = [
  "agent_probe_uses_only_the_fixed_allowlist_and_checks_executable_bits",
  "remote_commands_use_configured_tmux_and_tw_paths",
  "stable_output_signature_is_deterministic_and_content_sensitive",
  "fetchable_project_paths_dedupes_configured_git_roots",
  "reserve_git_fetch_target_throttles_and_tracks_in_flight_fetches",
  "git_fetch_args_runs_fetch_from_the_project_root",
  "git_graph_enumerates_canonical_refs_and_preserves_merge_topology",
  "git_graph_selected_refs_expand_head_and_limit_uses_one_extra_commit",
  "git_graph_preserves_control_characters_in_human_fields",
  "git_graph_all_excludes_internal_stash_refs",
  "git_graph_rejects_option_shaped_short_and_unknown_refs",
  "agent_running_from_pane_title_detects_codex_spinner_prefix",
  "automation_serializes_with_frontend_contract_field_names",
  "upsert_automation_defaults_create_and_preserves_created_at_on_update",
  "delete_automation_from_list_removes_only_matching_id",
  "automation_command_shell_quotes_non_empty_instruction",
  "overlap_skip_requires_running_or_queued_status_with_live_session",
  "append_automation_run_keeps_newest_first_and_bounded",
  "automation_trigger_delegates_to_canonical_worktree_creator",
  "derive_session_name_strips_random_suffix",
  "project_from_worktree_path_reads_project_segment",
  "no_config_orphan_scan_uses_canonical_home_default",
  "managed_worktree_session_requires_tw_name_and_git_worktree_shape",
  "config_parses_legacy_string_projects",
  "config_parses_object_projects_with_aliases",
  "config_parses_array_projects",
  "config_parses_remote_home_relative_paths",
  "missing_selected_project_is_removed_atomically_without_touching_other_config",
  "missing_project_cleanup_does_not_delete_a_concurrently_replaced_entry",
  "orphaned_worktrees_excludes_live_sessions",
  "worktrees_for_session_returns_only_matching_session",
  "is_git_worktree_dir_requires_git_entry",
  "try_cleanup_worktree_refuses_dirty_without_force",
  "worktree_dirty_check_detects_untracked_changes",
  "local_tw_rpc_argument_and_response_contract_is_strict",
  "canonical_kill_fails_closed_on_corrupt_managed_state_for_every_ui_hint",
  "canonical_kill_only_falls_back_for_explicit_legacy_compatibility",
  "local_tw_rpc_runtime_requires_bundled_node_or_exact_installed_version",
  "local_dashboard_create_delegates_every_field_to_bundled_tw_rpc",
  "local_dashboard_terminal_delegates_to_bundled_tw_rpc",
  "dashboard_terminal_without_ai_command_uses_the_frozen_optional_rpc_shape",
  "restore_worktree_delegates_to_canonical_tw_rpc",
  "kill_session_does_not_register_worktree_for_cleanup",
  "delete_worktree_requires_force_for_dirty_worktree",
  "cleanup_pending_worktrees_removes_registered_worktree",
  "create_remote_worktree_requires_remote_tw_rpc_when_tw_is_missing",
  "create_remote_worktree_with_config_project_still_requires_remote_tw_rpc",
  "create_remote_worktree_prefers_remote_tw_rpc",
  "create_remote_worktree_does_not_fallback_when_remote_tw_rejects_create",
  "list_remote_sessions_quotes_tmux_format_for_remote_shell",
  "list_remote_sessions_merges_rpc_state_with_legacy_tw_shaped_tmux_sessions",
  "remote_tmux_terminal_listing_only_includes_tw_managed_sessions",
  "remote_tmux_terminal_listing_merges_rpc_state_with_dashboard_tmux_sessions",
  "remote_project_catalog_reads_physical_home_config_over_ssh",
  "remote_directory_picker_reads_home_and_directories_over_ssh",
  "remote_file_editor_checks_reads_and_writes_over_ssh",
  "create_remote_terminal_delegates_to_tw_rpc_without_tmux_fallback",
  "ensure_and_kill_remote_terminal_use_the_configured_host",
  "remote_tmux_session_exists_distinguishes_missing_session_from_ssh_failure",
  "kill_remote_plain_terminal_surfaces_transport_failure_but_allows_already_missing",
  "test_host_reports_remote_tw_version",
  "test_host_reports_missing_remote_tw_without_marking_ssh_down",
  "test_host_does_not_misreport_missing_tmux_as_ssh_offline",
  "install_host_tw_uses_github_source_install",
  "test_parse_session_key",
  "ssh_host_validation_blocks_option_injection_and_control_characters",
  "host_compatibility_requires_hard_bounded_mutation_capabilities",
  "ssh_and_scp_end_options_before_the_destination",
  "unsafe_ssh_host_is_rejected_before_config_replacement_or_probe",
  "hosts_from_config_accepts_string_and_object_shorthand",
  "add_host_args_accepts_missing_optional_fields",
  "atomic_write_failure_preserves_existing_file_and_cleans_temp",
  "terminal_registry_save_is_atomic_private_and_releases_shared_lock",
  "stale_config_lock_owner_cannot_release_the_replacement_lock",
  "update_host_is_transactional_preserves_other_config_and_is_idempotent",
  "update_host_rejects_missing_and_duplicate_stable_ids_without_writing",
  "update_host_invalidates_only_its_cached_status",
  "remove_then_readd_same_host_id_never_reuses_cached_status",
  "layout_revision_contract_distinguishes_presence_and_raw_bytes",
  "layout_safe_integer_validation_matches_javascript_number_semantics",
  "layout_load_distinguishes_missing_from_present_empty_file",
  "layout_cas_supports_winner_conflict_and_stale_semantic_idempotence",
  "concurrent_layout_cas_has_exactly_one_winner",
  "layout_migration_backup_requires_authorized_write_and_uses_layout_lock_path",
  "layout_cas_blocks_future_malformed_and_invalid_current_state_even_when_revision_matches",
  "invalid_layout_save_request_fails_before_lock_backup_or_write",
  "startup_window_restore_skips_future_and_invalid_layouts",
  "ssh_config_aliases_are_candidates_not_auto_connected_hosts",
  "load_hosts_does_not_auto_connect_ssh_config_aliases",
  "ssh_host_candidates_filter_non_machine_aliases",
  "ssh_host_candidates_skip_git_jump_and_duplicate_root_entries",
] as const;

function leafName(path: string): string {
  const segments = path.trim().split("::");
  return segments.at(-1) ?? path.trim();
}

function readTauriCompositionSource(): string {
  return readRustProductionSource("lib.rs");
}

function maskRustCommentsAndLiterals(source: string): string {
  const chars = source.split("");
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  };

  for (let index = 0; index < source.length;) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      blank(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      if (depth !== 0) throw new Error("unterminated Rust block comment");
      blank(index, cursor);
      index = cursor;
      continue;
    }

    const raw = source.slice(index).match(/^(?:b|c)?r(#{0,32})"/);
    if (raw) {
      const marker = `"${raw[1]}`;
      const end = source.indexOf(marker, index + raw[0].length);
      if (end < 0) throw new Error("unterminated Rust raw string");
      const cursor = end + marker.length;
      blank(index, cursor);
      index = cursor;
      continue;
    }

    if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === '"') {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      if (cursor > source.length || source[cursor - 1] !== '"') {
        throw new Error("unterminated Rust string");
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }

    if (source[index] === "'") {
      let cursor = index + 1;
      if (source[cursor] === "\\") {
        cursor += 2;
        while (cursor < source.length && source[cursor] !== "\n") {
          if (source[cursor] === "\\") cursor += 2;
          else if (source[cursor] === "'") {
            cursor += 1;
            break;
          } else cursor += 1;
        }
      } else {
        const codePoint = source.codePointAt(cursor);
        cursor += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        if (source[cursor] === "'") cursor += 1;
        else cursor = index + 1;
      }
      if (cursor > index + 1 && source[cursor - 1] === "'") {
        blank(index, cursor);
        index = cursor;
        continue;
      }
    }

    index += 1;
  }
  return chars.join("");
}

function topLevelRustFunctions(source: string): Array<{ name: string; index: number }> {
  const masked = maskRustCommentsAndLiterals(source);
  const candidates = [...masked.matchAll(
    /^[ \t]*(?:(?:pub(?:[ \t]*\([^)]*\))?)[ \t]+)?(?:(?:const|async|unsafe|default|extern)[ \t]+)*fn[ \t]+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\b/gm,
  )];
  const functions: Array<{ name: string; index: number }> = [];
  let cursor = 0;
  let braceDepth = 0;
  for (const candidate of candidates) {
    for (; cursor < candidate.index; cursor += 1) {
      if (masked[cursor] === "{") braceDepth += 1;
      else if (masked[cursor] === "}") braceDepth -= 1;
      if (braceDepth < 0) throw new Error("unbalanced Rust braces");
    }
    if (braceDepth === 0) functions.push({ name: candidate[1], index: candidate.index });
  }
  return functions;
}

function matchingRustBrace(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unterminated Rust function body");
}

function topLevelRustFunctionBody(source: string, name: string): string {
  const functions = topLevelRustFunctions(source);
  const matches = functions.filter((candidate) => candidate.name === name);
  assert.equal(matches.length, 1, `expected one top-level Rust function ${name}`);
  const masked = maskRustCommentsAndLiterals(source);
  const open = masked.indexOf("{", matches[0].index);
  assert.notEqual(open, -1, `expected body for top-level Rust function ${name}`);
  const close = matchingRustBrace(masked, open);
  return source.slice(open + 1, close);
}

function rustFunctionDefinitionCount(source: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...maskRustCommentsAndLiterals(source).matchAll(
    new RegExp(`\\bfn\\s+(?:r#)?${escaped}\\b`, "g"),
  )].length;
}

function rustReferencesFeature(source: string, feature: string): boolean {
  const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const masked = maskRustCommentsAndLiterals(source);
  const compact = masked.replace(/\s+/g, "");
  if (new RegExp(`(?:\\bcrate::features|\\bsuper)::${escaped}(?=::|\\b)`).test(compact)) {
    return true;
  }

  for (const match of compact.matchAll(/\buse([^;]+);/g)) {
    const tree = match[1];
    const featureTree = tree.startsWith("crate::features::")
      || tree.startsWith("crate::{features")
      || tree.startsWith("super::")
      || tree.startsWith("super::{");
    if (
      featureTree
      && new RegExp(`(?:^|[,{:])${escaped}(?=::|[},]|$)`).test(tree)
    ) return true;
    if (
      /^crate::featuresas[A-Za-z_]/.test(tree)
      || /^crate::features::\{[^;]*selfas[A-Za-z_]/.test(tree)
    ) return true;
  }
  return new RegExp(`\\b${escaped}\\b`).test(masked);
}

test("tauri exposes exactly the frozen 70 dashboard commands", () => {
  const rust = readTauriCompositionSource();
  const handlerBlocks = [...rust.matchAll(/tauri::generate_handler!\[([\s\S]*?)\]/g)];

  assert.equal(handlerBlocks.length, 1, "there must be one authoritative Tauri handler registry");
  const commands = handlerBlocks[0][1]
    .split(",")
    .map((command) => command.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map(leafName);

  assert.equal(commands.length, 70);
  assert.deepEqual(commands, expectedTauriCommands);
  assert.equal(new Set(commands).size, commands.length, "Tauri commands must not be registered twice");
});

test("tauri composition owns the five long-lived states and exit cleanup", () => {
  const rust = readTauriCompositionSource();
  const managedStates = [...rust.matchAll(
    /app\.manage\(\s*Arc::new\(\s*([A-Za-z_][A-Za-z0-9_:]*)::default\(\)\s*\)\s*\)/g,
  )].map((match) => leafName(match[1]));

  assert.deepEqual(
    [...managedStates].sort(),
    ["PtyState", "MobileRelayState", "GitFetchState", "HostState"].sort(),
  );
  assert.match(rust, /app\.manage\(Arc::new\(TerminalControlState::new\(\)\)\);/);
  assert.equal(new Set(managedStates).size, 4, "each Default long-lived state must have one owner");
  assert.match(rust, /setup_clipboard_bindings\(\);/);
  assert.match(rust, /restore_window_layout\(&app\.handle\(\)\);/);
  assert.match(rust, /\.build\(tauri::generate_context!\(\)\)/);
  assert.match(
    rust,
    /tauri::RunEvent::ExitRequested \{ \.\. \} \| tauri::RunEvent::Exit => \{\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*cleanup_pending_worktrees\(\);\s*let relay_state = app\.state::<Arc<(?:[A-Za-z_][A-Za-z0-9_]*::)*MobileRelayState>>\(\);\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*stop_mobile_relay_processes\(relay_state\.inner\(\)\.as_ref\(\)\);/s,
  );
  assert.doesNotMatch(rust, /stop_terminal_control_process/);
  assert.match(rust, /Dashboard must not fence every other/);
});

test("tauri production composition stays thin and initializes the environment first", () => {
  const rust = readTauriCompositionSource();
  assert.deepEqual(
    topLevelRustFunctions(rust).map((entry) => entry.name),
    ["trigger_automation", "run"],
  );
  assert.deepEqual(
    topLevelRustFunctions(`
const TOP_LEVEL_BRACE_DECOY: &str = "{";
/* } fn block_comment_decoy() {} */
    fn indented_top_level() {}
fn outer() {
const NESTED_BRACE_DECOY: &str = "}";
fn column_zero_nested() {}
}
fn r#hidden_extra() {}
`).map((entry) => entry.name),
    ["indented_top_level", "outer", "hidden_extra"],
  );

  assert.match(
    rust,
    /^#\[tauri::command\]\s*\nfn trigger_automation\(app: tauri::AppHandle, id: String\) -> Result<AutomationRun, String> \{/m,
  );
  const expectedAdapterBody =
    "trigger_automation_with_creator(id,|args|create_worktree(app,args))";
  const adapterBody = topLevelRustFunctionBody(rust, "trigger_automation")
    .replace(/\s+/g, "");
  assert.equal(adapterBody, expectedAdapterBody);
  assert.notEqual(
    "audit(); trigger_automation_with_creator(id, |args| create_worktree(app, args))"
      .replace(/\s+/g, ""),
    expectedAdapterBody,
  );
  const run = topLevelRustFunctionBody(rust, "run");
  const inherit = run.indexOf("inherit_shell_env();");
  const builder = run.indexOf("tauri::Builder::default()");
  assert.notEqual(inherit, -1);
  assert.notEqual(builder, -1);
  assert.ok(inherit < builder, "shell environment must be inherited before building Tauri");
});

test("automation trigger orchestration has one owner and no worktree dependency", () => {
  const productionFiles = readRustSourceFiles();
  const definitions = productionFiles
    .map((file) => ({
      path: file.path,
      count: rustFunctionDefinitionCount(file.source, "trigger_automation_with_creator"),
    }))
    .filter((file) => file.count > 0);
  assert.deepEqual(definitions, [{ path: "features/automation.rs", count: 1 }]);
  assert.equal(
    rustFunctionDefinitionCount(`
fn trigger_automation_with_creator() {}
pub fn trigger_automation_with_creator() {}
pub(crate) fn trigger_automation_with_creator() {}
pub(super) fn trigger_automation_with_creator() {}
pub(in crate) fn trigger_automation_with_creator() {}
async fn trigger_automation_with_creator() {}
const fn trigger_automation_with_creator() {}
unsafe fn trigger_automation_with_creator() {}
extern "C" fn trigger_automation_with_creator() {}
fn r#trigger_automation_with_creator() {}
// fn trigger_automation_with_creator() {}
const DECOY: &str = "fn trigger_automation_with_creator() {}";
`, "trigger_automation_with_creator"),
    10,
  );

  const automation = readRustProductionSource("features/automation.rs");
  assert.equal(rustReferencesFeature(automation, "sessions"), true);
  assert.match(automation, /^use crate::ipc::CreateArgs;/m);
  assert.equal(rustReferencesFeature(automation, "worktrees"), false);

  for (const file of productionFiles.filter((candidate) =>
    candidate.path.startsWith("features/sessions/")
      || candidate.path.startsWith("features/worktrees/")
  )) {
    assert.equal(
      rustReferencesFeature(file.source, "automation"),
      false,
      `${file.path} must not depend on automation`,
    );
  }

  assert.equal(
    rustReferencesFeature(`
use crate::features::{
  sessions::tmux_session_exists,
  worktrees::{create_worktree},
};
`, "worktrees"),
    true,
  );
  assert.equal(
    rustReferencesFeature(
      "fn bypass() { crate::features::worktrees::create_worktree(); }",
      "worktrees",
    ),
    true,
  );
  assert.equal(
    rustReferencesFeature("use crate::{features::{automation::run}};", "automation"),
    true,
  );
  assert.equal(
    rustReferencesFeature(
      "fn bypass() { crate::features::automation::run(); }",
      "automation",
    ),
    true,
  );
  assert.equal(
    rustReferencesFeature(`
use crate::{features as f};
fn bypass() { f::worktrees::create_worktree(); }
`, "worktrees"),
    true,
  );
  assert.equal(
    rustReferencesFeature(`
use crate::{features::{self as f}};
fn bypass() { f::automation::run(); }
`, "automation"),
    true,
  );
  assert.equal(
    rustReferencesFeature(
      "const DECOY: &str = \"crate::features::worktrees::create_worktree\";",
      "worktrees",
    ),
    false,
  );
});

test("root Rust tests move once and preserve the exact frozen name set", () => {
  const rawLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const rootTests = readFileSync(
    new URL("../src-tauri/src/tests/mod.rs", import.meta.url),
    "utf8",
  );

  assert.equal([...rawLib.matchAll(/#\[cfg\(test\)\]\s*mod tests;/g)].length, 1);
  assert.doesNotMatch(rawLib, /mod tests\s*\{/);
  assert.doesNotMatch(rawLib, /#\[test\]/);
  assert.doesNotMatch(rootTests, /^\s*mod tests\s*\{/m);
  assert.match(rootTests, /pub\(crate\) fn test_env_lock\(\)/);

  const names = [...rootTests.matchAll(
    /#\[test\]\s*\n\s*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
  )].map((match) => match[1]);
  assert.deepEqual(names, expectedRootRustTests);
  assert.equal(new Set(names).size, expectedRootRustTests.length);
});
