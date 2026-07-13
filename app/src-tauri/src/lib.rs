mod config;
mod features;
mod ipc;
mod remote;
mod support;

use config::*;
use features::*;
#[cfg(test)]
use ipc::*;
#[cfg(test)]
use remote::*;
use support::*;

use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
fn trigger_automation(app: tauri::AppHandle, id: String) -> Result<AutomationRun, String> {
    trigger_automation_with_creator(id, |args| create_worktree(app, args))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(PtyState::default()));
            app.manage(Arc::new(MobileRelayState::default()));
            app.manage(Arc::new(GitFetchState::default()));
            app.manage(Arc::new(HostState::default()));
            setup_clipboard_bindings();
            restore_window_layout(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dashboard_catalog,
            list_local_dashboard_catalog,
            list_sessions,
            tmux_session_exists,
            list_projects,
            add_project,
            remove_missing_project,
            create_worktree,
            kill_session,
            list_orphaned_worktrees,
            restore_worktree,
            delete_worktree,
            session_cwd,
            session_root,
            cancel_copy_mode,
            copy_mode_cancel_if_active,
            apply_tmux_theme,
            copy_tmux_selection,
            capture_pane_history,
            git_status,
            git_fetch_project_roots,
            git_graph_refs,
            git_graph,
            git_diff,
            list_tmux_terminals,
            create_terminal,
            ensure_terminal_session,
            kill_plain_terminal,
            load_terminals,
            save_terminals,
            load_layout,
            save_layout,
            list_automations,
            save_automation,
            delete_automation,
            trigger_automation,
            list_automation_runs,
            home_dir,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            read_dir,
            read_file,
            write_file,
            remote_read_file,
            remote_read_file_base64,
            remote_write_file,
            search_files,
            open_url,
            file_exists,
            remote_file_exists,
            list_hosts,
            list_ssh_host_candidates,
            add_host,
            update_host,
            remove_host,
            test_host,
            install_host_tw,
            host_statuses,
            list_remote_projects,
            remote_home_dir,
            remote_read_dir,
            probe_agents,
            mobile_relay_start,
            mobile_relay_start_broker,
            mobile_relay_save_config,
            mobile_relay_stop,
            mobile_relay_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                cleanup_pending_worktrees();
                let relay_state = app.state::<Arc<MobileRelayState>>();
                stop_mobile_relay_processes(relay_state.inner().as_ref());
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests;
