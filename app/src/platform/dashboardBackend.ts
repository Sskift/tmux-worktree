import type {
  DashboardTransport,
  DashboardWindow,
  ConfirmDialogOptions,
  DirectoryDialogOptions,
  PtyConnection,
  PtyDataEvent,
  PtyExitEvent,
  PtyHandlers,
  PtyOpenArgs,
} from "./types";
import type {
  AddHostInput,
  AddProjectInput,
  AgentProbeResult,
  AgentProbeTarget,
  CreateTerminalInput,
  CreatedTerminal,
  DashboardCatalogSnapshot,
  CreateWorktreeInput,
  DashboardLayout,
  DeleteWorktreeInput,
  DirEntry,
  EnsureTerminalInput,
  FileSearchMode,
  FileSearchResult,
  GitGraphQuery,
  GitGraphRefs,
  GitGraphResponse,
  GitStatus,
  HostConfig,
  HostInput,
  HostStatus,
  MobileRelayBrokerInput,
  MobileRelayConfigInput,
  MobileRelayStatus,
  OrphanedWorktree,
  PlainTerminal,
  ProjectPreset,
  RestoreWorktreeInput,
  Session,
  TmuxStatusTheme,
  UpdateHostInput,
} from "./domainTypes";
import type {
  AutomationRecord,
  AutomationRunRecord,
  SaveAutomationInput,
} from "../automationTypes";

type HostId = string | null | undefined;

export interface DashboardBackend {
  catalog?: {
    list(): Promise<DashboardCatalogSnapshot>;
    listLocal?(): Promise<DashboardCatalogSnapshot>;
  };
  sessions: {
    list(): Promise<Session[]>;
    exists(name: string): Promise<boolean>;
    root(name: string): Promise<string>;
    cwd(name: string): Promise<string>;
    captureHistory(name: string, lines?: number): Promise<string>;
    kill(name: string): Promise<void>;
    cancelCopyMode(name: string): Promise<void>;
    cancelCopyModeIfActive(name: string): Promise<boolean>;
    copySelection(name: string): Promise<boolean>;
    applyTheme(name: string, theme: TmuxStatusTheme): Promise<void>;
  };
  projects: {
    list(): Promise<ProjectPreset[]>;
    listRemote(hostId: string): Promise<ProjectPreset[]>;
    add(args: AddProjectInput): Promise<ProjectPreset[]>;
  };
  worktrees: {
    listOrphaned(): Promise<OrphanedWorktree[]>;
    create(args: CreateWorktreeInput): Promise<string>;
    restore(args: RestoreWorktreeInput): Promise<string>;
    delete(args: DeleteWorktreeInput): Promise<void>;
  };
  terminals: {
    listTmux(): Promise<PlainTerminal[]>;
    load(): Promise<PlainTerminal[]>;
    save(terminals: PlainTerminal[]): Promise<void>;
    ensure(args: EnsureTerminalInput): Promise<void>;
    create(args: CreateTerminalInput): Promise<CreatedTerminal>;
    kill(name: string): Promise<void>;
  };
  pty: {
    connect(
      args: PtyOpenArgs,
      handlers: PtyHandlers,
      signal?: AbortSignal,
    ): Promise<PtyConnection>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
  };
  git: {
    status(cwd: string, hostId?: HostId): Promise<GitStatus | null>;
    graphRefs(cwd: string, hostId?: HostId): Promise<GitGraphRefs>;
    graph(cwd: string, query: GitGraphQuery, hostId?: HostId): Promise<GitGraphResponse>;
    diff(cwd: string, path: string, hostId?: HostId): Promise<string>;
    fetchProjectRoots(): Promise<void>;
  };
  files: {
    readDirectory(path: string): Promise<DirEntry[]>;
    readRemoteDirectory(hostId: string, path: string): Promise<DirEntry[]>;
    search(root: string, query: string, mode: FileSearchMode): Promise<FileSearchResult[]>;
    read(path: string): Promise<string>;
    readRemote(hostId: string, path: string): Promise<string>;
    readRemoteBase64(hostId: string, path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    writeRemote(hostId: string, path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    existsRemote(hostId: string, path: string): Promise<boolean>;
    openUrl(url: string): Promise<void>;
    assetUrl(path: string): string;
  };
  automations: {
    list(): Promise<AutomationRecord[]>;
    listRuns(automationId?: string | null): Promise<AutomationRunRecord[]>;
    save(input: SaveAutomationInput): Promise<AutomationRecord>;
    delete(id: string): Promise<void>;
    trigger(id: string): Promise<AutomationRunRecord>;
  };
  hosts: {
    list(): Promise<HostConfig[]>;
    candidates(): Promise<HostConfig[]>;
    statuses(): Promise<HostStatus[]>;
    test(args: HostInput): Promise<HostStatus>;
    add(args: AddHostInput): Promise<HostConfig[]>;
    update(args: UpdateHostInput): Promise<HostConfig[]>;
    remove(id: string): Promise<HostConfig[]>;
    installTw(hostId: string): Promise<HostStatus>;
    remoteHome(hostId: string): Promise<string>;
  };
  agents: {
    probe(target: AgentProbeTarget): Promise<AgentProbeResult[]>;
  };
  relay: {
    status(): Promise<MobileRelayStatus>;
    start(): Promise<void>;
    saveConfig(args: MobileRelayConfigInput): Promise<MobileRelayStatus>;
    startBroker(args: MobileRelayBrokerInput): Promise<MobileRelayStatus>;
    stop(): Promise<void>;
  };
  persistence: {
    homeDirectory(): Promise<string>;
    loadLayout(): Promise<DashboardLayout>;
    saveLayout(layout: DashboardLayout): Promise<void>;
  };
  dialog: {
    selectDirectory(options: DirectoryDialogOptions): Promise<string | null>;
    confirm(options: ConfirmDialogOptions): Promise<boolean>;
  };
  window: {
    current(): DashboardWindow;
  };
}

function abortError(): Error {
  const error = new Error("PTY connection aborted");
  error.name = "AbortError";
  return error;
}

export function createDashboardBackend(transport: DashboardTransport): DashboardBackend {
  const writePty = (id: string, data: string) =>
    transport.invoke<void>("pty_write", { id, data });
  const resizePty = (id: string, cols: number, rows: number) =>
    transport.invoke<void>("pty_resize", { id, cols, rows });
  const killPty = (id: string) => transport.invoke<void>("pty_kill", { id });

  const connectPty = async (
    args: PtyOpenArgs,
    handlers: PtyHandlers,
    signal?: AbortSignal,
  ): Promise<PtyConnection> => {
    let closed = false;
    let opened = false;
    let exited = false;
    let abortRequested = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const unsubscribe = () => {
      unlistenData?.();
      unlistenData = null;
      unlistenExit?.();
      unlistenExit = null;
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (opened && !exited) await killPty(args.id).catch(() => {});
    };

    const onAbort = () => {
      abortRequested = true;
      unsubscribe();
      if (opened) {
        closed = true;
        if (!exited) void killPty(args.id).catch(() => {});
      }
    };

    try {
      if (signal?.aborted) throw abortError();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        throw abortError();
      }
      unlistenData = await transport.listen<PtyDataEvent>(`pty:${args.id}`, (event) => {
        if (!abortRequested && !closed && event.id === args.id) handlers.onData(event);
      });
      if (signal?.aborted || abortRequested) throw abortError();
      unlistenExit = await transport.listen<PtyExitEvent>(`pty-exit:${args.id}`, async (event) => {
        if (abortRequested || closed || event.id !== args.id) return;
        exited = true;
        closed = true;
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        await handlers.onExit(event);
      });
      if (signal?.aborted || abortRequested) throw abortError();

      const openedId = await transport.invoke<string>("pty_open", { args });
      if (openedId !== args.id) {
        await transport.invoke<void>("pty_kill", { id: openedId }).catch(() => {});
        throw new Error(`pty id mismatch: expected ${args.id}, got ${openedId}`);
      }
      opened = true;
      if (signal?.aborted || abortRequested) {
        if (!exited) await killPty(args.id).catch(() => {});
        closed = true;
        throw abortError();
      }

      return {
        id: args.id,
        get active() {
          return !closed && !exited;
        },
        write: (data) => {
          if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
          return writePty(args.id, data);
        },
        resize: (cols, rows) => {
          if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
          return resizePty(args.id, cols, rows);
        },
        close: async () => {
          signal?.removeEventListener("abort", onAbort);
          await close();
        },
      };
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      await close();
      throw error;
    }
  };

  return {
    catalog: {
      list: () =>
        transport.invoke<DashboardCatalogSnapshot>("list_dashboard_catalog"),
      listLocal: () =>
        transport.invoke<DashboardCatalogSnapshot>("list_local_dashboard_catalog"),
    },
    sessions: {
      list: () => transport.invoke<Session[]>("list_sessions"),
      exists: (name) => transport.invoke<boolean>("tmux_session_exists", { name }),
      root: (name) => transport.invoke<string>("session_root", { name }),
      cwd: (name) => transport.invoke<string>("session_cwd", { name }),
      captureHistory: (name, lines) =>
        transport.invoke<string>("capture_pane_history", { name, lines }),
      kill: (name) => transport.invoke<void>("kill_session", { name }),
      cancelCopyMode: (name) => transport.invoke<void>("cancel_copy_mode", { name }),
      cancelCopyModeIfActive: (name) =>
        transport.invoke<boolean>("copy_mode_cancel_if_active", { name }),
      copySelection: (name) =>
        transport.invoke<boolean>("copy_tmux_selection", { name }),
      applyTheme: (name, theme) =>
        transport.invoke<void>("apply_tmux_theme", { name, theme }),
    },
    projects: {
      list: () => transport.invoke<ProjectPreset[]>("list_projects"),
      listRemote: (hostId) =>
        transport.invoke<ProjectPreset[]>("list_remote_projects", { hostId }),
      add: (args) => transport.invoke<ProjectPreset[]>("add_project", { args }),
    },
    worktrees: {
      listOrphaned: () => transport.invoke<OrphanedWorktree[]>("list_orphaned_worktrees"),
      create: (args) => transport.invoke<string>("create_worktree", { args }),
      restore: (args) => transport.invoke<string>("restore_worktree", { args }),
      delete: (args) => transport.invoke<void>("delete_worktree", { args }),
    },
    terminals: {
      listTmux: () => transport.invoke<PlainTerminal[]>("list_tmux_terminals"),
      load: () => transport.invoke<PlainTerminal[]>("load_terminals"),
      save: (terminals) => transport.invoke<void>("save_terminals", { terminals }),
      ensure: (args) => transport.invoke<void>("ensure_terminal_session", { args }),
      create: (args) => transport.invoke<CreatedTerminal>("create_terminal", { args }),
      kill: (name) => transport.invoke<void>("kill_plain_terminal", { name }),
    },
    pty: {
      connect: connectPty,
      write: writePty,
      resize: resizePty,
      kill: killPty,
    },
    git: {
      status: (cwd, hostId) =>
        transport.invoke<GitStatus | null>("git_status", { cwd, hostId: hostId ?? null }),
      graphRefs: (cwd, hostId) =>
        transport.invoke<GitGraphRefs>("git_graph_refs", { cwd, hostId: hostId ?? null }),
      graph: (cwd, query, hostId) =>
        transport.invoke<GitGraphResponse>("git_graph", {
          cwd,
          query,
          hostId: hostId ?? null,
        }),
      diff: (cwd, path, hostId) =>
        transport.invoke<string>("git_diff", { cwd, path, hostId: hostId ?? null }),
      fetchProjectRoots: () => transport.invoke<void>("git_fetch_project_roots"),
    },
    files: {
      readDirectory: (path) => transport.invoke<DirEntry[]>("read_dir", { path }),
      readRemoteDirectory: (hostId, path) =>
        transport.invoke<DirEntry[]>("remote_read_dir", { hostId, path }),
      search: (root, query, mode) =>
        transport.invoke<FileSearchResult[]>("search_files", { root, query, mode }),
      read: (path) => transport.invoke<string>("read_file", { path }),
      readRemote: (hostId, path) =>
        transport.invoke<string>("remote_read_file", { hostId, path }),
      readRemoteBase64: (hostId, path) =>
        transport.invoke<string>("remote_read_file_base64", { hostId, path }),
      write: (path, content) => transport.invoke<void>("write_file", { path, content }),
      writeRemote: (hostId, path, content) =>
        transport.invoke<void>("remote_write_file", { hostId, path, content }),
      exists: (path) => transport.invoke<boolean>("file_exists", { path }),
      existsRemote: (hostId, path) =>
        transport.invoke<boolean>("remote_file_exists", { hostId, path }),
      openUrl: (url) => transport.invoke<void>("open_url", { url }),
      assetUrl: (path) => transport.assetUrl(path),
    },
    automations: {
      list: () => transport.invoke<AutomationRecord[]>("list_automations"),
      listRuns: (automationId) =>
        transport.invoke<AutomationRunRecord[]>("list_automation_runs", { automationId: automationId ?? null }),
      save: (input) => transport.invoke<AutomationRecord>("save_automation", { input }),
      delete: (id) => transport.invoke<void>("delete_automation", { id }),
      trigger: (id) => transport.invoke<AutomationRunRecord>("trigger_automation", { id }),
    },
    hosts: {
      list: () => transport.invoke<HostConfig[]>("list_hosts"),
      candidates: () => transport.invoke<HostConfig[]>("list_ssh_host_candidates"),
      statuses: () => transport.invoke<HostStatus[]>("host_statuses"),
      test: (args) => transport.invoke<HostStatus>("test_host", { args }),
      add: (args) => transport.invoke<HostConfig[]>("add_host", { args }),
      update: (args) => transport.invoke<HostConfig[]>("update_host", { args }),
      remove: (id) => transport.invoke<HostConfig[]>("remove_host", { id }),
      installTw: (hostId) => transport.invoke<HostStatus>("install_host_tw", { hostId }),
      remoteHome: (hostId) => transport.invoke<string>("remote_home_dir", { hostId }),
    },
    agents: {
      probe: (target) => transport.invoke<AgentProbeResult[]>("probe_agents", {
        hostId: target.kind === "host" ? target.hostId : null,
      }),
    },
    relay: {
      status: () => transport.invoke<MobileRelayStatus>("mobile_relay_status"),
      start: () => transport.invoke<void>("mobile_relay_start"),
      saveConfig: (args) =>
        transport.invoke<MobileRelayStatus>("mobile_relay_save_config", { args }),
      startBroker: (args) =>
        transport.invoke<MobileRelayStatus>("mobile_relay_start_broker", { args }),
      stop: () => transport.invoke<void>("mobile_relay_stop"),
    },
    persistence: {
      homeDirectory: () => transport.invoke<string>("home_dir"),
      loadLayout: () => transport.invoke<DashboardLayout>("load_layout"),
      saveLayout: (layout) => transport.invoke<void>("save_layout", { layout }),
    },
    dialog: {
      selectDirectory: (options) => transport.selectDirectory(options),
      confirm: (options) => transport.confirm(options),
    },
    window: {
      current: () => transport.currentWindow(),
    },
  };
}
