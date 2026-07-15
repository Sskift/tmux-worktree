import type {
  DashboardTransport,
  DashboardWindow,
  DashboardWindowCloseLifecycle,
  ConfirmDialogOptions,
  DirectoryDialogOptions,
  PtyConnection,
  PtyDataEvent,
  PtyExitEvent,
  PtyHandlers,
  PtyOpenArgs,
  PtyControlStatus,
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
  DashboardLayoutLoadResult,
  DashboardLayoutRevision,
  DashboardLayoutSaveResult,
  DeleteWorktreeInput,
  DirEntry,
  EnsureTerminalInput,
  FileSearchMode,
  FileSearchResult,
  FeishuBinding,
  FeishuBindingInput,
  FeishuBridgeSnapshot,
  FeishuChat,
  FeishuAddProfileInput,
  FeishuAddProfileResult,
  FeishuIntegrationStatus,
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
  MobileRelayV2CreateEnrollmentInput,
  MobileRelayV2DashboardState,
  MobileRelayV2RevokeClientGrantInput,
  OrphanedWorktree,
  PlainTerminal,
  ProjectPreset,
  RemoveMissingProjectInput,
  RemoveMissingProjectResult,
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
import { MobileRelayV2BackendOperationError } from "./relayV2Domain";

type HostId = string | null | undefined;

export interface FeishuProductAdapter {
  integrationStatus(): Promise<FeishuIntegrationStatus>;
  addProfile(input: FeishuAddProfileInput): Promise<FeishuAddProfileResult>;
  selectProfile(profile: string): Promise<FeishuIntegrationStatus>;
  removeProfile(profile: string): Promise<FeishuIntegrationStatus>;
  status(): Promise<FeishuBridgeSnapshot>;
  groups(): Promise<FeishuChat[]>;
  create(args: FeishuBindingInput): Promise<FeishuBinding>;
  pause(bindingId: string, force?: boolean): Promise<FeishuBinding>;
  resume(bindingId: string): Promise<FeishuBinding>;
  repair(bindingId: string): Promise<FeishuBinding>;
  remove(bindingId: string, force?: boolean): Promise<void>;
  takeover(bindingId: string, ptyId: string, force?: boolean): Promise<void>;
  returnToFeishu(bindingId: string, ptyId: string): Promise<FeishuBinding>;
}

export interface MobileRelayV2ProductAdapter {
  /** Status reads are serialized; adapters must stop promptly when the signal aborts. */
  status(signal?: AbortSignal): Promise<MobileRelayV2DashboardState>;
  bootstrapHost(): Promise<MobileRelayV2DashboardState>;
  refreshHost(): Promise<MobileRelayV2DashboardState>;
  startConnector(): Promise<MobileRelayV2DashboardState>;
  stopConnector(): Promise<MobileRelayV2DashboardState>;
  createEnrollment(
    input: MobileRelayV2CreateEnrollmentInput,
  ): Promise<MobileRelayV2DashboardState>;
  revokeClientGrant(
    input: MobileRelayV2RevokeClientGrantInput,
  ): Promise<MobileRelayV2DashboardState>;
}

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
    kill(name: string, managed?: boolean): Promise<void>;
    cancelCopyMode(name: string): Promise<void>;
    cancelCopyModeIfActive(name: string): Promise<boolean>;
    copySelection(name: string): Promise<boolean>;
    applyTheme(name: string, theme: TmuxStatusTheme): Promise<void>;
  };
  projects: {
    list(): Promise<ProjectPreset[]>;
    listRemote(hostId: string): Promise<ProjectPreset[]>;
    add(args: AddProjectInput): Promise<ProjectPreset[]>;
    removeMissing(args: RemoveMissingProjectInput): Promise<RemoveMissingProjectResult>;
  };
  worktrees: {
    listOrphaned(hostId?: string): Promise<OrphanedWorktree[]>;
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
    kill(name: string, managed?: boolean): Promise<void>;
  };
  pty: {
    connect(
      args: PtyOpenArgs,
      handlers: PtyHandlers,
      signal?: AbortSignal,
    ): Promise<PtyConnection>;
    write(id: string, data: string): Promise<void>;
    scroll(id: string, direction: "up" | "down", lines: number): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    controlStatus(id: string): Promise<PtyControlStatus>;
    releaseControl(id: string): Promise<PtyControlStatus>;
    requestTakeover(id: string): Promise<PtyControlStatus>;
    requestRecovery(id: string): Promise<PtyControlStatus>;
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
    v2: MobileRelayV2ProductAdapter;
  };
  feishu: FeishuProductAdapter;
  persistence: {
    homeDirectory(): Promise<string>;
    loadLayout(): Promise<DashboardLayoutLoadResult>;
    saveLayout(
      layout: DashboardLayout,
      expectedRevision: DashboardLayoutRevision,
    ): Promise<DashboardLayoutSaveResult>;
  };
  dialog: {
    selectDirectory(options: DirectoryDialogOptions): Promise<string | null>;
    confirm(options: ConfirmDialogOptions): Promise<boolean>;
  };
  window: {
    current(): DashboardWindow;
    closeLifecycle?: DashboardWindowCloseLifecycle;
  };
}

export const MOBILE_RELAY_V2_NODE_ADAPTER_GAP =
  "Relay v2 enrollment is unavailable until the bundled Node issuer/credential control API is implemented.";

export function createUnavailableMobileRelayV2Adapter(
  reason = MOBILE_RELAY_V2_NODE_ADAPTER_GAP,
): MobileRelayV2ProductAdapter {
  const state = (): MobileRelayV2DashboardState => ({
    authority: { kind: "unavailable", reason },
    v1Profile: {
      protocolVersion: 1,
      credentialKind: "legacy_shared_secret",
      sharedSecretConfigured: false,
    },
    hostCredential: {
      protocolVersion: 2,
      credentialKind: "twcap2_grant",
      status: "missing",
      credentialReference: null,
      expiresAtMs: null,
      error: null,
      retryable: null,
    },
    connector: {
      status: "stopped",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    },
    enrollment: { status: "idle" },
    knownClientGrant: { status: "unknown" },
  });
  const unavailable = async (): Promise<MobileRelayV2DashboardState> => {
    throw new MobileRelayV2BackendOperationError({
      code: "relay_v2_adapter_unavailable",
      message: reason,
      retryable: false,
    });
  };
  return {
    status: async () => state(),
    bootstrapHost: unavailable,
    refreshHost: unavailable,
    startConnector: unavailable,
    stopConnector: unavailable,
    createEnrollment: unavailable,
    revokeClientGrant: unavailable,
  };
}

function abortError(): Error {
  const error = new Error("PTY connection aborted");
  error.name = "AbortError";
  return error;
}

const MAX_COALESCED_PTY_WRITE_BYTES = 64 * 1024;
const ptyTextEncoder = new TextEncoder();

export function createDashboardBackend(
  transport: DashboardTransport,
  adapters: { relayV2?: MobileRelayV2ProductAdapter } = {},
): DashboardBackend {
  const closeLifecycle = transport.closeLifecycle;
  const writePty = (id: string, data: string) =>
    transport.invoke<void>("pty_write", { id, data });
  const writeTerminalReply = (id: string, data: string) =>
    transport.invoke<void>("pty_write_terminal_reply", { id, data });
  const scrollPty = (id: string, direction: "up" | "down", lines: number) =>
    transport.invoke<void>("pty_control_scroll", { id, direction, lines });
  const resizePty = (id: string, cols: number, rows: number) =>
    transport.invoke<void>("pty_resize", { id, cols, rows });
  const killPty = (id: string) => transport.invoke<void>("pty_kill", { id });
  const ptyControlStatus = (id: string) =>
    transport.invoke<PtyControlStatus>("pty_control_status", { id });
  const releasePtyControl = (id: string) =>
    transport.invoke<PtyControlStatus>("pty_control_release", { id });
  const requestPtyTakeover = (id: string) =>
    transport.invoke<PtyControlStatus>("pty_control_takeover", { id });
  const requestPtyRecovery = (id: string) =>
    transport.invoke<PtyControlStatus>("pty_control_recover", { id });

  const connectPty = async (
    args: PtyOpenArgs,
    handlers: PtyHandlers,
    signal?: AbortSignal,
  ): Promise<PtyConnection> => {
    let closed = false;
    let opened = false;
    let exited = false;
    let abortRequested = false;
    let mutationQueue: Promise<void> = Promise.resolve();
    let pendingWrite: {
      data: string;
      byteLength: number;
      started: boolean;
      result?: Promise<void>;
    } | null = null;
    let pendingResize: {
      cols: number;
      rows: number;
      started: boolean;
      result?: Promise<void>;
    } | null = null;
    let pendingScroll: {
      direction: "up" | "down";
      lines: number;
      started: boolean;
      result?: Promise<void>;
    } | null = null;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const unsubscribe = () => {
      unlistenData?.();
      unlistenData = null;
      unlistenExit?.();
      unlistenExit = null;
    };

    const enqueueMutation = <T,>(operation: () => Promise<T>): Promise<T> => {
      if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
      const result = mutationQueue.then(() => {
        if (closed || exited) throw new Error("PTY connection is closed");
        return operation();
      });
      mutationQueue = result.then(() => undefined, () => undefined);
      return result;
    };

    const enqueueWrite = (data: string): Promise<void> => {
      if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
      const byteLength = ptyTextEncoder.encode(data).byteLength;
      if (
        pendingWrite &&
        !pendingWrite.started &&
        pendingWrite.byteLength + byteLength <= MAX_COALESCED_PTY_WRITE_BYTES
      ) {
        pendingWrite.data += data;
        pendingWrite.byteLength += byteLength;
        return pendingWrite.result!;
      }
      const batch = { data, byteLength, started: false } as NonNullable<typeof pendingWrite>;
      pendingWrite = batch;
      const result = enqueueMutation(() => {
        batch.started = true;
        if (pendingWrite === batch) pendingWrite = null;
        return writePty(args.id, batch.data);
      });
      batch.result = result;
      return result;
    };

    const enqueueResize = (cols: number, rows: number): Promise<void> => {
      if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
      if (pendingResize && !pendingResize.started) {
        pendingResize.cols = cols;
        pendingResize.rows = rows;
        return pendingResize.result!;
      }
      const batch = { cols, rows, started: false } as NonNullable<typeof pendingResize>;
      pendingResize = batch;
      const result = enqueueMutation(() => {
        batch.started = true;
        if (pendingResize === batch) pendingResize = null;
        return resizePty(args.id, batch.cols, batch.rows);
      });
      batch.result = result;
      return result;
    };

    const enqueueScroll = (direction: "up" | "down", lines: number): Promise<void> => {
      if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
      if (pendingScroll && !pendingScroll.started && pendingScroll.direction === direction) {
        pendingScroll.lines = Math.min(100, pendingScroll.lines + lines);
        return pendingScroll.result!;
      }
      const batch = { direction, lines, started: false } as NonNullable<typeof pendingScroll>;
      pendingScroll = batch;
      const result = enqueueMutation(() => {
        batch.started = true;
        if (pendingScroll === batch) pendingScroll = null;
        return scrollPty(args.id, batch.direction, batch.lines);
      });
      batch.result = result;
      return result;
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      await mutationQueue;
      if (opened && !exited) await killPty(args.id).catch(() => {});
    };

    const onAbort = () => {
      abortRequested = true;
      unsubscribe();
      if (opened) {
        closed = true;
        if (!exited) void mutationQueue.finally(() => killPty(args.id).catch(() => {}));
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

      const openCommand = args.controlSession ? "pty_open_managed" : "pty_open";
      const openedId = await transport.invoke<string>(openCommand, { args });
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
        write: enqueueWrite,
        writeTerminalReply: (data) => enqueueMutation(() => writeTerminalReply(args.id, data)),
        scroll: enqueueScroll,
        resize: enqueueResize,
        controlStatus: () => {
          if (closed || exited) return Promise.reject(new Error("PTY connection is closed"));
          return ptyControlStatus(args.id);
        },
        releaseControl: () => {
          return enqueueMutation(() => releasePtyControl(args.id));
        },
        requestTakeover: () => {
          return enqueueMutation(() => requestPtyTakeover(args.id));
        },
        requestRecovery: () => {
          return enqueueMutation(() => requestPtyRecovery(args.id));
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
      kill: (name, managed) => transport.invoke<void>("kill_session", { name, managed: managed ?? false }),
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
      removeMissing: (args) =>
        transport.invoke<RemoveMissingProjectResult>("remove_missing_project", { args }),
    },
    worktrees: {
      listOrphaned: (hostId) => transport.invoke<OrphanedWorktree[]>(
        "list_orphaned_worktrees",
        { hostId: hostId ?? null },
      ),
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
      kill: (name, managed) => transport.invoke<void>("kill_plain_terminal", { name, managed: managed ?? false }),
    },
    pty: {
      connect: connectPty,
      write: writePty,
      scroll: scrollPty,
      resize: resizePty,
      kill: killPty,
      controlStatus: ptyControlStatus,
      releaseControl: releasePtyControl,
      requestTakeover: requestPtyTakeover,
      requestRecovery: requestPtyRecovery,
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
      v2: adapters.relayV2 ?? createUnavailableMobileRelayV2Adapter(),
    },
    feishu: {
      integrationStatus: () =>
        transport.invoke<FeishuIntegrationStatus>("feishu_integration_status"),
      addProfile: (input) =>
        transport.invoke<FeishuAddProfileResult>("feishu_integration_add_profile", {
          appId: input.appId,
          appSecret: input.appSecret,
          brand: input.brand,
        }),
      selectProfile: (profile) =>
        transport.invoke<FeishuIntegrationStatus>("feishu_integration_save_profile", { profile }),
      removeProfile: (profile) =>
        transport.invoke<FeishuIntegrationStatus>("feishu_integration_remove_profile", { profile }),
      status: () => transport.invoke<FeishuBridgeSnapshot>("feishu_bridge_status"),
      groups: () => transport.invoke<FeishuChat[]>("feishu_groups_list"),
      create: (args) => transport.invoke<FeishuBinding>("feishu_binding_create", { args }),
      pause: (bindingId, force) => transport.invoke<FeishuBinding>("feishu_binding_pause", {
        bindingId,
        force: force ?? false,
      }),
      resume: (bindingId) => transport.invoke<FeishuBinding>("feishu_binding_resume", { bindingId }),
      repair: (bindingId) => transport.invoke<FeishuBinding>("feishu_binding_repair", { bindingId }),
      remove: async (bindingId, force) => {
        await transport.invoke("feishu_binding_remove", { bindingId, force: force ?? false });
      },
      takeover: async (bindingId, ptyId, force) => {
        await transport.invoke("feishu_binding_takeover", {
          bindingId,
          ptyId,
          force: force ?? false,
        });
      },
      returnToFeishu: (bindingId, ptyId) =>
        transport.invoke<FeishuBinding>("feishu_binding_return", { bindingId, ptyId }),
    },
    persistence: {
      homeDirectory: () => transport.invoke<string>("home_dir"),
      loadLayout: () => transport.invoke<DashboardLayoutLoadResult>("load_layout"),
      saveLayout: (layout, expectedRevision) =>
        transport.invoke<DashboardLayoutSaveResult>("save_layout", {
          layout,
          expectedRevision,
        }),
    },
    dialog: {
      selectDirectory: (options) => transport.selectDirectory(options),
      confirm: (options) => transport.confirm(options),
    },
    window: {
      current: () => transport.currentWindow(),
      ...(closeLifecycle ? { closeLifecycle } : {}),
    },
  };
}
