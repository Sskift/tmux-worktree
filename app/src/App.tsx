import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Terminal } from "./Terminal";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { NewTerminalModal, type TerminalDraft } from "./NewTerminalModal";
import { AddHostModal } from "./AddHostModal";
import { ThemePicker } from "./ThemePicker";
import { GitStatusPanel } from "./GitStatusPanel";
import { FileTree } from "./FileTree";
import { FileEditor } from "./FileEditor";
import { DiffViewer } from "./DiffViewer";
import { AutomationPanel } from "./AutomationPanel";
import { useSortable } from "./useSortable";
import { applyTheme, loadTheme, type ThemeId } from "./themes";
import {
  automationFromRecord,
  automationRunFromRecord,
  automationSaveInputFromDraft,
  createAutomationDraft,
  shouldRunAutomationSchedule,
  triggerLabel,
  type Automation,
  type AutomationDraft,
  type AutomationRecord,
  type AutomationRun,
  type AutomationRunRecord,
} from "./automationTypes";
import {
  describeSessionActivity,
  type PreviousSessionActivity,
  type SessionActivityInfo,
} from "./sessionActivity";
import {
  SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
  SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
  SIDEBAR_GIT_MIN_HEIGHT,
  SIDEBAR_TERMINALS_MIN_HEIGHT,
  SIDEBAR_WORKTREES_MIN_HEIGHT,
  isStableSidebarLayoutHeight,
  normalizeSidebarSplits,
  resizeWorktreeAutomationSplit,
} from "./sidebarLayout";
import "./App.css";

type Session = {
  name: string;
  attached: boolean;
  window_count: number;
  created: number;
  activity: number;
  output_signature?: string | null;
  agent_running?: boolean | null;
  hostId?: string | null;
  rawName?: string;
};

type HostConfig = {
  id: string;
  label: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
  worktreeBase?: string | null;
  tmuxPath?: string | null;
  twPath?: string | null;
};

type HostStatus = {
  id: string;
  label: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  twAvailable?: boolean;
  twVersion?: string;
  twError?: string;
};

type PlainTerminal = {
  id: string;
  label: string;
  cwd: string;
  tmuxName: string;
  hostId?: string | null;
  rawName?: string;
  aiCmd?: string;
  discovered?: boolean;
};

type CreatedTerminal = {
  tmuxName: string;
  hostId?: string | null;
  rawName: string;
};

type ProjectPreset = {
  name: string;
  path: string;
  branch?: string | null;
};

type Selection =
  | { kind: "session"; name: string }
  | { kind: "terminal"; id: string }
  | { kind: "automation"; id: string }
  | null;

type WindowLayout = {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
};

type SessionGroup = {
  key: string;
  project: string;
  colorKey: string;
  hostLabel: string | null;
  sessions: Session[];
};

type MobileRelayStatus = {
  active: boolean;
  relayUrl: string;
  hostId: string;
  secret: string;
  token: string;
  error?: string | null;
};

const REFRESH_MS = 2000;
const HOST_STATUS_REFRESH_MS = 15000;
const PRELOAD_HISTORY_LINES = 300;
const WINDOW_DEFAULTS = { width: 1440, height: 900 };

const PROJECT_COLORS = [
  "#f687b3",
  "#9ae6b4",
  "#f6ad55",
  "#90cdf4",
  "#d6bcfa",
  "#81e6d9",
  "#fbd38d",
  "#feb2b2",
  "#9ae6b4",
  "#b794f6",
];

function projectKey(name: string): string {
  const i = name.indexOf("-");
  return i > 0 ? name.slice(0, i) : name;
}

/** Get the display name for a session (raw tmux name, not composite key) */
function sessionDisplayName(s: Session): string {
  return s.rawName ?? s.name;
}

/** Get the project key for coloring (uses raw name for remote sessions) */
function sessionProjectKey(s: Session): string {
  return projectKey(sessionDisplayName(s));
}

function groupSessionsByProject(sessions: Session[], hosts: HostConfig[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byKey = new Map<string, SessionGroup>();
  const hostLabels = new Map(hosts.map((host) => [host.id, host.label]));

  for (const session of sessions) {
    const project = sessionProjectKey(session);
    const hostId = session.hostId ?? null;
    const hostLabel = hostId ? hostLabels.get(hostId) ?? hostId : null;
    const colorKey = hostId ? `${hostId}:${project}` : project;
    const key = hostId ? `ssh:${hostId}:${project}` : `local:${project}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, project, colorKey, hostLabel, sessions: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }

  return groups;
}

/** Build SSH attach args for a remote session */
function buildSshAttachArgs(host: HostConfig, rawName: string): string[] {
  const args: string[] = ["-tt", "-o", "StrictHostKeyChecking=accept-new"];
  if (host.port) {
    args.push("-p", String(host.port));
  }
  if (host.identityFile) {
    args.push("-i", host.identityFile);
  }
  const target = host.user ? `${host.user}@${host.host}` : host.host;
  const exact = `=${rawName}`;
  const exactArg = shellQuoteArg(exact);
  const tmux = remoteShellPathExpr(host.tmuxPath || "tmux");
  args.push(
    target,
    "--",
    [
      "set -e",
      "export TERM=xterm-256color",
      `${tmux} has-session -t ${exactArg}`,
      `exec ${tmux} attach-session -t ${exactArg}`,
    ].join("; "),
  );
  return args;
}

function remoteShellPathExpr(value: string): string {
  const trimmed = value.trim() || "tmux";
  if (trimmed === "~") return '"$HOME"';
  if (trimmed.startsWith("~/")) {
    const escapedPath = trimmed
      .slice(2)
      .replace(/["\\$]/g, "\\$&")
      .replace(/`/g, "\\`");
    return `"$HOME/${escapedPath}"`;
  }
  return shellQuoteArg(trimmed);
}

function shellQuoteArg(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildSshShellArgs(host: HostConfig, cwd: string): string[] {
  const args: string[] = ["-tt", "-o", "StrictHostKeyChecking=accept-new"];
  if (host.port) {
    args.push("-p", String(host.port));
  }
  if (host.identityFile) {
    args.push("-i", host.identityFile);
  }
  const target = host.user ? `${host.user}@${host.host}` : host.host;
  args.push(
    target,
    "--",
    `cd ${shellQuoteArg(cwd)} && exec "\${SHELL:-/bin/sh}"`,
  );
  return args;
}

function terminalRawName(terminal: PlainTerminal): string {
  if (terminal.rawName) return terminal.rawName;
  if (terminal.hostId && terminal.tmuxName.startsWith(`${terminal.hostId}:`)) {
    return terminal.tmuxName.slice(terminal.hostId.length + 1);
  }
  return terminal.tmuxName;
}

function terminalSessionKey(terminal: PlainTerminal): string {
  return terminal.hostId ? `${terminal.hostId}:${terminalRawName(terminal)}` : terminalRawName(terminal);
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

function sameSessions(a: Session[], b: Session[]): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return (
      left.name === right.name &&
      left.attached === right.attached &&
      left.window_count === right.window_count &&
      left.created === right.created &&
      left.activity === right.activity &&
      (left.output_signature ?? null) === (right.output_signature ?? null) &&
      (left.agent_running ?? null) === (right.agent_running ?? null) &&
      (left.hostId ?? null) === (right.hostId ?? null) &&
      (left.rawName ?? "") === (right.rawName ?? "")
    );
  });
}

function samePlainTerminals(a: PlainTerminal[], b: PlainTerminal[]): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return (
      left.id === right.id &&
      left.label === right.label &&
      left.cwd === right.cwd &&
      left.tmuxName === right.tmuxName &&
      (left.hostId ?? null) === (right.hostId ?? null) &&
      (left.rawName ?? "") === (right.rawName ?? "") &&
      (left.aiCmd ?? "") === (right.aiCmd ?? "") &&
      (left.discovered ?? false) === (right.discovered ?? false)
    );
  });
}

function sameSessionActivity(
  a: Record<string, SessionActivityInfo>,
  b: Record<string, SessionActivityInfo>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return !!right &&
      left.state === right.state &&
      left.label === right.label &&
      left.changed === right.changed &&
      left.ageSeconds === right.ageSeconds &&
      left.lastChangedAt === right.lastChangedAt &&
      (left.outputSignature ?? null) === (right.outputSignature ?? null);
  });
}
function colorForProject(map: Map<string, string>, project: string): string {
  if (!map.has(project)) {
    map.set(project, PROJECT_COLORS[map.size % PROJECT_COLORS.length]);
  }
  return map.get(project)!;
}

function automationDotColor(automation: Automation): string {
  if (!automation.active) return "var(--text-faint)";
  if (automation.status === "failed") return "#ff8272";
  if (automation.status === "running" || automation.status === "queued") return "#90cdf4";
  if (automation.status === "skipped") return "#f6ad55";
  return "#9ae6b4";
}

function automationMetaLabel(automation: Automation): string {
  if (!automation.active) return "paused";
  return automation.status && automation.status !== "idle" ? automation.status : "active";
}

function isWindowLayout(value: unknown): value is WindowLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.maximized === "boolean"
  );
}

function isSelection(value: unknown): value is Selection {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "session" && typeof candidate.name === "string") ||
    (candidate.kind === "terminal" && typeof candidate.id === "string") ||
    (candidate.kind === "automation" && typeof candidate.id === "string")
  );
}

function isDiffFile(value: unknown): value is { path: string; cwd: string; hostId?: string | null } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.cwd === "string" &&
    (candidate.hostId === undefined || candidate.hostId === null || typeof candidate.hostId === "string")
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function getWindowExpandedState(win: ReturnType<typeof getCurrentWindow>) {
  const [fullscreen, maximized] = await Promise.all([
    win.isFullscreen().catch(() => false),
    win.isMaximized().catch(() => false),
  ]);
  return { fullscreen, maximized };
}

type ScratchTerm = { id: string; label: string };
type ScratchState = { list: ScratchTerm[]; nextNum: number };
type LayoutColumn = "file" | "main" | "scratch" | "editor";
type ResizableColumn = Exclude<LayoutColumn, "main">;

const LAYOUT_DEFAULTS = {
  left: 240,
  right: 380,
  gitHeight: 220,
  sectionSplit: 200,
  automationHeight: SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
};
const DEFAULT_COLUMN_ORDER: LayoutColumn[] = ["file", "main", "scratch", "editor"];
const COLUMN_DRAG_THRESHOLD = 5;
const COLUMN_WIDTH_LIMITS: Record<ResizableColumn, { min: number; max: number }> = {
  file: { min: 180, max: 600 },
  scratch: { min: 220, max: 800 },
  editor: { min: 250, max: 900 },
};

let termIdCounter = 0;
let scratchIdCounter = 0;

function isLayoutColumn(value: unknown): value is LayoutColumn {
  return value === "file" || value === "main" || value === "scratch" || value === "editor";
}

function normalizeColumnOrder(value: unknown): LayoutColumn[] {
  const seen = new Set<LayoutColumn>();
  const restored = Array.isArray(value)
    ? value.filter((item): item is LayoutColumn => {
        if (!isLayoutColumn(item) || seen.has(item)) return false;
        seen.add(item);
        return true;
      })
    : [];
  return [...restored, ...DEFAULT_COLUMN_ORDER.filter((column) => !seen.has(column))];
}

function reorderActiveColumns(
  currentOrder: LayoutColumn[],
  activeOrder: LayoutColumn[],
  from: LayoutColumn,
  to: LayoutColumn,
): LayoutColumn[] {
  const fromIndex = activeOrder.indexOf(from);
  const toIndex = activeOrder.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return currentOrder;

  const reorderedActive = [...activeOrder];
  const [moved] = reorderedActive.splice(fromIndex, 1);
  reorderedActive.splice(toIndex, 0, moved);

  const activeSet = new Set(activeOrder);
  const queue = [...reorderedActive];
  return currentOrder.map((column) => (activeSet.has(column) ? queue.shift()! : column));
}

function placeScratchAfterMain(order: LayoutColumn[]): LayoutColumn[] {
  const normalized = normalizeColumnOrder(order);
  const withoutScratch = normalized.filter((column) => column !== "scratch");
  const mainIndex = withoutScratch.indexOf("main");
  const insertAt = mainIndex < 0 ? withoutScratch.length : mainIndex + 1;
  return [
    ...withoutScratch.slice(0, insertAt),
    "scratch",
    ...withoutScratch.slice(insertAt),
  ];
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [terminals, setTerminals] = useState<PlainTerminal[]>([]);
  const [discoveredTerminals, setDiscoveredTerminals] = useState<PlainTerminal[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [projectPresets, setProjectPresets] = useState<ProjectPreset[]>([]);
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivityInfo>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [openedSessions, setOpenedSessions] = useState<string[]>([]);
  const [openedTerminals, setOpenedTerminals] = useState<string[]>([]);
  const [tmuxPreviews, setTmuxPreviews] = useState<Record<string, string>>({});
  const [cwdsBySession, setCwdsBySession] = useState<Record<string, string>>({});
  const [lastAutomationContextPath, setLastAutomationContextPath] = useState<string | null>(null);
  const [lastAutomationContextProject, setLastAutomationContextProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostConfig[]>([]);
  const [sshHostCandidates, setSshHostCandidates] = useState<HostConfig[]>([]);
  const [hostStatuses, setHostStatuses] = useState<Record<string, HostStatus>>({});
  const [mobileRelayBrokerHostId, setMobileRelayBrokerHostId] = useState("");
  const [installingHostId, setInstallingHostId] = useState<string | null>(null);
  const [showAddHost, setShowAddHost] = useState(false);
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => {
    const id = loadTheme();
    applyTheme(id);
    return id;
  });
  const [cols, setCols] = useState<{ left: number; right: number }>({
    left: LAYOUT_DEFAULTS.left,
    right: LAYOUT_DEFAULTS.right,
  });
  const [gitHeight, setGitHeight] = useState<number>(LAYOUT_DEFAULTS.gitHeight);
  const [sectionSplit, setSectionSplit] = useState<number>(LAYOUT_DEFAULTS.sectionSplit);
  const [automationHeight, setAutomationHeight] = useState<number>(
    LAYOUT_DEFAULTS.automationHeight,
  );
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [renamingTerminal, setRenamingTerminal] = useState<string | null>(null);
  const [scratchTerminals, setScratchTerminals] = useState<Map<string, ScratchState>>(new Map());
  const [scratchCollapsed, setScratchCollapsed] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [mobileRelayActive, setMobileRelayActive] = useState(false);
  const [mobileRelayUrl, setMobileRelayUrl] = useState("wss://relay.example.com");
  const [mobileRelayHostId, setMobileRelayHostId] = useState("mac-admin");
  const [mobileRelaySecret, setMobileRelaySecret] = useState("");
  const [mobileRelayDraftUrl, setMobileRelayDraftUrl] = useState("wss://relay.example.com");
  const [mobileRelayDraftHostId, setMobileRelayDraftHostId] = useState("mac-admin");
  const [mobileRelayDraftSecret, setMobileRelayDraftSecret] = useState("");
  const [mobileRelayPopover, setMobileRelayPopover] = useState(false);
  const [mobileRelayLoading, setMobileRelayLoading] = useState(false);
  const [mobileRelaySaving, setMobileRelaySaving] = useState(false);
  const [mobileRelayBrokerStarting, setMobileRelayBrokerStarting] = useState(false);
  const [mobileRelayError, setMobileRelayError] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<{ path: string; cwd: string; hostId?: string | null } | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [fileTreeWidth, setFileTreeWidth] = useState(280);
  const [editorWidth, setEditorWidth] = useState(420);
  const [columnOrder, setColumnOrder] = useState<LayoutColumn[]>(DEFAULT_COLUMN_ORDER);
  const [columnDrag, setColumnDrag] = useState<{ from: LayoutColumn; over: LayoutColumn } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [windowLayout, setWindowLayout] = useState<WindowLayout | null>(null);
  const [windowRestoreReady, setWindowRestoreReady] = useState(false);
  const appRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef<Map<LayoutColumn, HTMLElement>>(new Map());
  const activeColumnOrderRef = useRef<LayoutColumn[]>(DEFAULT_COLUMN_ORDER);
  const pendingColumnDragRef = useRef<{ column: LayoutColumn; startX: number; startY: number } | null>(null);
  const columnDragRef = useRef<{ from: LayoutColumn; over: LayoutColumn } | null>(null);
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);
  const cwdRequested = useRef<Set<string>>(new Set());
  const tmuxPreviewRequested = useRef<Set<string>>(new Set());
  const tmuxPreviewLiveRef = useRef<Set<string>>(new Set());
  const sidebarSplitRef = useRef<HTMLDivElement | null>(null);
  const sessionsListRef = useRef<HTMLDivElement | null>(null);
  const layoutLoadedRef = useRef(false);
  const autoResizeColumnsReadyRef = useRef(false);
  const gitHeightValueRef = useRef(gitHeight);
  const sectionSplitValueRef = useRef(sectionSplit);
  const automationHeightValueRef = useRef(automationHeight);
  const automationsRef = useRef<Automation[]>([]);
  const sessionActivityRef = useRef<Map<string, PreviousSessionActivity>>(new Map());
  const scheduledAutomationMinuteRef = useRef<Set<string>>(new Set());
  gitHeightValueRef.current = gitHeight;
  sectionSplitValueRef.current = sectionSplit;
  automationHeightValueRef.current = automationHeight;
  automationsRef.current = automations;

  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerWidth(e.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = sidebarSplitRef.current;
    if (!el) return;

    const normalizeForHeight = (totalHeight: number) => {
      if (!isStableSidebarLayoutHeight(totalHeight)) return;
      const next = normalizeSidebarSplits({
        totalHeight,
        sectionSplit: sectionSplitValueRef.current,
        gitHeight: gitHeightValueRef.current,
        automationHeight: automationHeightValueRef.current,
      });
      if (next.sectionSplit !== sectionSplitValueRef.current) {
        sectionSplitValueRef.current = next.sectionSplit;
        setSectionSplit(next.sectionSplit);
      }
      if (next.automationHeight !== automationHeightValueRef.current) {
        automationHeightValueRef.current = next.automationHeight;
        setAutomationHeight(next.automationHeight);
      }
      if (next.gitHeight !== gitHeightValueRef.current) {
        gitHeightValueRef.current = next.gitHeight;
        setGitHeight(next.gitHeight);
      }
    };

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) normalizeForHeight(e.contentRect.height);
    });
    ro.observe(el);
    normalizeForHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = sidebarSplitRef.current;
    if (!el) return;
    const totalHeight = el.getBoundingClientRect().height;
    if (!isStableSidebarLayoutHeight(totalHeight)) return;
    const next = normalizeSidebarSplits({
      totalHeight,
      sectionSplit,
      gitHeight,
      automationHeight,
    });
    if (next.sectionSplit !== sectionSplit) setSectionSplit(next.sectionSplit);
    if (next.automationHeight !== automationHeight) setAutomationHeight(next.automationHeight);
    if (next.gitHeight !== gitHeight) setGitHeight(next.gitHeight);
  }, [sectionSplit, automationHeight, gitHeight]);

  useEffect(() => {
    invoke<string>("home_dir").then(setHomeDir).catch(() => {});
  }, []);

  const loadProjectPresets = useCallback(async () => {
    try {
      const list = await invoke<ProjectPreset[]>("list_projects");
      setProjectPresets(list);
    } catch {
      setProjectPresets([]);
    }
  }, []);

  useEffect(() => {
    void loadProjectPresets();
  }, [loadProjectPresets]);

  const loadHosts = useCallback(async () => {
    try {
      const [list, candidates] = await Promise.all([
        invoke<HostConfig[]>("list_hosts"),
        invoke<HostConfig[]>("list_ssh_host_candidates"),
      ]);
      setHosts(list);
      setSshHostCandidates(candidates);
    } catch {
      setHosts([]);
      setSshHostCandidates([]);
    }
  }, []);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

  const installRemoteTw = useCallback(async (hostId: string) => {
    setInstallingHostId(hostId);
    try {
      const status = await invoke<HostStatus>("install_host_tw", { hostId });
      setHostStatuses((prev) => ({ ...prev, [status.id]: status }));
    } catch (err) {
      setHostStatuses((prev) => {
        const current = prev[hostId];
        if (!current) return prev;
        return {
          ...prev,
          [hostId]: {
            ...current,
            twAvailable: false,
            twError: String(err),
          },
        };
      });
    } finally {
      setInstallingHostId(null);
    }
  }, []);

  const hostIdsKey = useMemo(() => hosts.map((host) => host.id).join("\0"), [hosts]);
  const refreshHostStatuses = useCallback(async () => {
    try {
      const statuses = await invoke<HostStatus[]>("host_statuses");
      setHostStatuses(Object.fromEntries(statuses.map((status) => [status.id, status])));
    } catch {
      setHostStatuses({});
    }
  }, []);

  useEffect(() => {
    if (!hostIdsKey) {
      setHostStatuses({});
      return;
    }
    void refreshHostStatuses();
    const id = setInterval(refreshHostStatuses, HOST_STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, [hostIdsKey, refreshHostStatuses]);

  useEffect(() => {
    if (!windowRestoreReady) return;
    const win = getCurrentWindow();
    let disposed = false;
    let timer: number | null = null;
    let unlistenResized: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;

    const capture = async () => {
      try {
        const { fullscreen, maximized } = await getWindowExpandedState(win);
        if (disposed) return;
        if (fullscreen) {
          setWindowLayout(
            (prev) =>
              prev ?? {
                width: WINDOW_DEFAULTS.width,
                height: WINDOW_DEFAULTS.height,
                x: 0,
                y: 0,
                maximized: false,
              },
          );
          return;
        }
        if (maximized) {
          setWindowLayout((prev) =>
            prev
              ? { ...prev, maximized: true }
              : {
                  width: WINDOW_DEFAULTS.width,
                  height: WINDOW_DEFAULTS.height,
                  x: 0,
                  y: 0,
                  maximized: true,
                },
          );
          return;
        }

        const [size, position, factor] = await Promise.all([
          win.innerSize(),
          win.outerPosition(),
          win.scaleFactor(),
        ]);
        if (disposed) return;
        setWindowLayout({
          width: Math.round(size.width / factor),
          height: Math.round(size.height / factor),
          x: Math.round(position.x / factor),
          y: Math.round(position.y / factor),
          maximized: false,
        });
      } catch {
        // Ignore platform/window-manager errors; persistence is best-effort.
      }
    };

    const scheduleCapture = () => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        void capture();
      }, 150);
    };

    void capture();
    void win.onResized(scheduleCapture).then((fn) => {
      unlistenResized = fn;
    });
    void win.onMoved(scheduleCapture).then((fn) => {
      unlistenMoved = fn;
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlistenResized?.();
      unlistenMoved?.();
    };
  }, [windowRestoreReady]);

  const fileTreeWidthRef = useRef(fileTreeWidth);
  fileTreeWidthRef.current = fileTreeWidth;
  const editorWidthRef = useRef(editorWidth);
  editorWidthRef.current = editorWidth;
  const prevColumnsRef = useRef({ fileBrowser: false, editor: false });

  useEffect(() => {
    const prev = prevColumnsRef.current;
    const curr = { fileBrowser: fileBrowserOpen, editor: !!(editingFile || diffFile) };
    if (!autoResizeColumnsReadyRef.current) {
      prevColumnsRef.current = curr;
      if (layoutLoadedRef.current) autoResizeColumnsReadyRef.current = true;
      return;
    }
    let delta = 0;
    if (curr.fileBrowser && !prev.fileBrowser) delta += fileTreeWidthRef.current + 1;
    if (!curr.fileBrowser && prev.fileBrowser) delta -= fileTreeWidthRef.current + 1;
    if (curr.editor && !prev.editor) delta += editorWidthRef.current + 1;
    if (!curr.editor && prev.editor) delta -= editorWidthRef.current + 1;
    prevColumnsRef.current = curr;
    if (delta !== 0) {
      (async () => {
        try {
          const win = getCurrentWindow();
          const { fullscreen, maximized } = await getWindowExpandedState(win);
          if (fullscreen || maximized) return;
          const size = await win.innerSize();
          const factor = await win.scaleFactor();
          const lw = size.width / factor + delta;
          const lh = size.height / factor;
          await win.setSize(new LogicalSize(Math.max(800, lw), lh));
        } catch {
          // Window resizing is a convenience; keep column toggles functional if it fails.
        }
      })();
    }
  }, [fileBrowserOpen, editingFile, diffFile]);

  // Load persisted data on mount
  useEffect(() => {
    invoke<PlainTerminal[]>("load_terminals")
      .then(async (saved) => {
        if (saved.length > 0) {
          const maxNum = saved.reduce((max, t) => {
            const m = t.id.match(/^term-(\d+)$/);
            return m ? Math.max(max, parseInt(m[1], 10)) : max;
          }, 0);
          termIdCounter = maxNum;
          for (const t of saved) {
            if (t.tmuxName) {
              await invoke("ensure_terminal_session", {
                args: {
                  name: t.tmuxName,
                  cwd: t.cwd,
                  aiCmd: t.aiCmd ?? "",
                  hostId: t.hostId ?? null,
                  rawName: t.rawName ?? null,
                },
              }).catch(() => {});
            }
          }
          setTerminals(saved.filter((t) => t.tmuxName));
        }
      })
      .catch(() => {});
    invoke<Record<string, unknown>>("load_layout")
      .then((lay) => {
        const restoredFileBrowserOpen =
          typeof lay.fileBrowserOpen === "boolean" ? (lay.fileBrowserOpen as boolean) : false;
        const restoredEditorOpen = isDiffFile(lay.diffFile) || typeof lay.editingFile === "string";
        prevColumnsRef.current = {
          fileBrowser: restoredFileBrowserOpen,
          editor: restoredEditorOpen,
        };
        autoResizeColumnsReadyRef.current = true;
        if (typeof lay.left === "number") setCols((c) => ({ ...c, left: lay.left as number }));
        if (typeof lay.right === "number") setCols((c) => ({ ...c, right: lay.right as number }));
        if (typeof lay.gitHeight === "number") setGitHeight(lay.gitHeight as number);
        if (typeof lay.fileTreeWidth === "number") {
          setFileTreeWidth(clamp(lay.fileTreeWidth as number, 180, 600));
        }
        if (typeof lay.editorWidth === "number") {
          setEditorWidth(clamp(lay.editorWidth as number, 250, 900));
        }
        if (typeof lay.sectionSplit === "number") {
          const v = lay.sectionSplit as number;
          setSectionSplit(v < 1 ? LAYOUT_DEFAULTS.sectionSplit : v);
        }
        if (typeof lay.automationHeight === "number") {
          const v = lay.automationHeight as number;
          setAutomationHeight(v < 1 ? LAYOUT_DEFAULTS.automationHeight : v);
        }
        if (Array.isArray(lay.sessionOrder)) {
          setSessionOrder((lay.sessionOrder as string[]).filter((n) => !n.startsWith("tw-term-")));
        }
        if (Array.isArray(lay.collapsedProjects)) {
          setCollapsedProjects(
            (lay.collapsedProjects as unknown[]).filter(
              (project): project is string => typeof project === "string" && project.length > 0,
            ),
          );
        }
        setColumnOrder(normalizeColumnOrder(lay.columnOrder));
        if (typeof lay.scratchCollapsed === "boolean") {
          setScratchCollapsed(lay.scratchCollapsed as boolean);
        }
        setFileBrowserOpen(restoredFileBrowserOpen);
        if (isDiffFile(lay.diffFile)) {
          setDiffFile(lay.diffFile);
          setEditingFile(null);
        } else if (typeof lay.editingFile === "string") {
          setEditingFile(lay.editingFile);
          setDiffFile(null);
        }
        if (isSelection(lay.selection)) {
          setSelection(lay.selection);
        }
        if (isWindowLayout(lay.window)) setWindowLayout(lay.window);
        setWindowRestoreReady(true);
      })
      .catch(() => {
        prevColumnsRef.current = { fileBrowser: false, editor: false };
        autoResizeColumnsReadyRef.current = true;
        setWindowRestoreReady(true);
      })
      .finally(() => {
        layoutLoadedRef.current = true;
      });
  }, []);

  // Persist terminals
  useEffect(() => {
    invoke("save_terminals", { terminals }).catch(() => {});
  }, [terminals]);

  // Persist layout (debounced)
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const sidebarHeight = sidebarSplitRef.current?.getBoundingClientRect().height ?? 0;
    if (!isStableSidebarLayoutHeight(sidebarHeight)) return;
    const t = setTimeout(() => {
      invoke("save_layout", {
        layout: {
          left: cols.left,
          right: cols.right,
          gitHeight,
          sectionSplit,
          automationHeight,
          sessionOrder,
          collapsedProjects,
          columnOrder,
          scratchCollapsed,
          fileBrowserOpen,
          fileTreeWidth,
          editorWidth,
          selection,
          editingFile,
          diffFile,
          ...(windowLayout ? { window: windowLayout } : {}),
        },
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [
    cols,
    gitHeight,
    sectionSplit,
    automationHeight,
    sessionOrder,
    collapsedProjects,
    columnOrder,
    scratchCollapsed,
    fileBrowserOpen,
    fileTreeWidth,
    editorWidth,
    selection,
    editingFile,
    diffFile,
    windowLayout,
  ]);

  const loadAutomations = useCallback(async () => {
    try {
      const [records, runRecords] = await Promise.all([
        invoke<AutomationRecord[]>("list_automations"),
        invoke<AutomationRunRecord[]>("list_automation_runs", { automationId: null }),
      ]);
      const nextAutomations = records.map(automationFromRecord);
      const automationsById = new Map(
        nextAutomations.map((automation) => [automation.id, automation]),
      );
      const nextRuns = runRecords.map((run) =>
        automationRunFromRecord(run, automationsById.get(run.automationId)),
      );

      setAutomations(nextAutomations);
      setAutomationRuns(nextRuns);
      setAutomationError(null);
      setSelection((current) => {
        if (current?.kind !== "automation" || !current.id || automationsById.has(current.id)) {
          return current;
        }
        return nextAutomations[0] ? { kind: "automation", id: nextAutomations[0].id } : null;
      });
      return nextAutomations;
    } catch (err) {
      setAutomationError(String(err));
      return automationsRef.current;
    }
  }, []);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  const anyModalOpen = showNewWorktree || showNewTerminal || showAddHost;
  const editorPanelOpen = !!(editingFile || diffFile);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startLeft = cols.left;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      setCols((prev) => ({ ...prev, left: clamp(startLeft + dx, 180, 500) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const isResizableColumn = (column: LayoutColumn): column is ResizableColumn => {
    if (column === "file") return fileBrowserOpen;
    if (column === "scratch") return !scratchCollapsed;
    return column === "editor" && editorPanelOpen;
  };

  const getColumnWidth = (column: ResizableColumn): number => {
    if (column === "file") return fileTreeWidth;
    if (column === "scratch") return cols.right;
    return editorWidth;
  };

  const setColumnWidth = (column: ResizableColumn, value: number) => {
    const next = Math.round(value);
    if (column === "file") {
      setFileTreeWidth(next);
    } else if (column === "scratch") {
      setCols((prev) => ({ ...prev, right: next }));
    } else {
      setEditorWidth(next);
    }
  };

  const canResizeColumns = (left: LayoutColumn, right: LayoutColumn) =>
    isResizableColumn(left) || isResizableColumn(right);

  const startColumnResize = (left: LayoutColumn, right: LayoutColumn) => (e: React.MouseEvent) => {
    const leftResizable = isResizableColumn(left) ? left : null;
    const rightResizable = isResizableColumn(right) ? right : null;
    if (!leftResizable && !rightResizable) return;

    e.preventDefault();
    const startX = e.clientX;
    const startLeft = leftResizable ? getColumnWidth(leftResizable) : null;
    const startRight = rightResizable ? getColumnWidth(rightResizable) : null;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (leftResizable && rightResizable && startLeft !== null && startRight !== null) {
        const leftLimits = COLUMN_WIDTH_LIMITS[leftResizable];
        const rightLimits = COLUMN_WIDTH_LIMITS[rightResizable];
        const total = startLeft + startRight;
        const minLeft = Math.max(leftLimits.min, total - rightLimits.max);
        const maxLeft = Math.min(leftLimits.max, total - rightLimits.min);

        if (minLeft <= maxLeft) {
          const nextLeft = clamp(startLeft + dx, minLeft, maxLeft);
          setColumnWidth(leftResizable, nextLeft);
          setColumnWidth(rightResizable, total - nextLeft);
          return;
        }

        setColumnWidth(leftResizable, clamp(startLeft + dx, leftLimits.min, leftLimits.max));
        setColumnWidth(rightResizable, clamp(startRight - dx, rightLimits.min, rightLimits.max));
      } else if (leftResizable && startLeft !== null) {
        const limits = COLUMN_WIDTH_LIMITS[leftResizable];
        setColumnWidth(leftResizable, clamp(startLeft + dx, limits.min, limits.max));
      } else if (rightResizable && startRight !== null) {
        const limits = COLUMN_WIDTH_LIMITS[rightResizable];
        setColumnWidth(rightResizable, clamp(startRight - dx, limits.min, limits.max));
      }
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const setColumnRef = useCallback(
    (column: LayoutColumn) => (element: HTMLElement | null) => {
      if (element) {
        columnRefs.current.set(column, element);
      } else {
        columnRefs.current.delete(column);
      }
    },
    [],
  );

  const startColumnDrag = useCallback(
    (column: LayoutColumn) => (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pendingColumnDragRef.current = { column, startX: e.clientX, startY: e.clientY };
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      const pending = pendingColumnDragRef.current;
      if (pending && !columnDragRef.current) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) >= COLUMN_DRAG_THRESHOLD) {
          const next = { from: pending.column, over: pending.column };
          columnDragRef.current = next;
          setColumnDrag(next);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          pendingColumnDragRef.current = null;
        }
        return;
      }

      const drag = columnDragRef.current;
      if (!drag) return;

      let best = drag.over;
      let bestDist = Infinity;
      for (const column of activeColumnOrderRef.current) {
        const element = columnRefs.current.get(column);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const dist = Math.abs(e.clientX - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = column;
        }
      }

      if (best !== drag.over) {
        const next = { ...drag, over: best };
        columnDragRef.current = next;
        setColumnDrag(next);
      }
    };

    const onUp = () => {
      pendingColumnDragRef.current = null;
      const drag = columnDragRef.current;
      if (!drag) return;

      if (drag.from !== drag.over) {
        const activeOrder = activeColumnOrderRef.current;
        setColumnOrder((currentOrder) =>
          reorderActiveColumns(currentOrder, activeOrder, drag.from, drag.over),
        );
      }

      columnDragRef.current = null;
      setColumnDrag(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, []);

  const startGitSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = sidebarSplitRef.current;
    if (!container) return;
    const startY = e.clientY;
    const startH = gitHeight;
    const total = container.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const maxGit = Math.max(
        SIDEBAR_GIT_MIN_HEIGHT,
        total -
          sectionSplitValueRef.current -
          SIDEBAR_TERMINALS_MIN_HEIGHT -
          automationHeightValueRef.current,
      );
      const h = clamp(startH - dy, SIDEBAR_GIT_MIN_HEIGHT, maxGit);
      setGitHeight(h);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startSectionSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const listContainer = sessionsListRef.current;
    if (!listContainer) return;
    const startY = e.clientY;
    const startH = sectionSplit;
    const startAutomationH = automationHeight;
    const containerH = listContainer.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      if (startAutomationH > 0) {
        const next = resizeWorktreeAutomationSplit({
          sectionSplit: startH,
          automationHeight: startAutomationH,
          deltaY: dy,
        });
        setSectionSplit(next.sectionSplit);
        setAutomationHeight(next.automationHeight);
        return;
      }

      const maxSection = Math.max(
        SIDEBAR_WORKTREES_MIN_HEIGHT,
        containerH - SIDEBAR_TERMINALS_MIN_HEIGHT - automationHeightValueRef.current,
      );
      const h = clamp(startH + dy, SIDEBAR_WORKTREES_MIN_HEIGHT, maxSection);
      setSectionSplit(h);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startAutomationSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const listContainer = sessionsListRef.current;
    if (!listContainer) return;
    const startY = e.clientY;
    const startH = automationHeight;
    const containerH = listContainer.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const maxAutomation = Math.max(
        SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
        containerH - sectionSplitValueRef.current - SIDEBAR_TERMINALS_MIN_HEIGHT,
      );
      const h = clamp(startH + dy, SIDEBAR_AUTOMATIONS_MIN_HEIGHT, maxAutomation);
      setAutomationHeight(h);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const sessionOrderRef = useRef(sessionOrder);
  sessionOrderRef.current = sessionOrder;
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;

  const allTerminals = useMemo(() => {
    const persistedKeys = new Set(terminals.map(terminalSessionKey));
    return [
      ...terminals,
      ...discoveredTerminals.filter((terminal) => !persistedKeys.has(terminalSessionKey(terminal))),
    ];
  }, [terminals, discoveredTerminals]);

  useEffect(() => {
    const names = [
      ...sessions.map((session) => session.name),
      ...allTerminals.map(terminalSessionKey),
    ];
    const live = new Set(names);
    tmuxPreviewLiveRef.current = live;
    for (const name of Array.from(tmuxPreviewRequested.current)) {
      if (!live.has(name)) tmuxPreviewRequested.current.delete(name);
    }
    setTmuxPreviews((prev) => {
      const next: Record<string, string> = {};
      for (const [name, history] of Object.entries(prev)) {
        if (live.has(name)) next[name] = history;
      }
      return sameStringRecord(prev, next) ? prev : next;
    });

    (async () => {
      for (const name of names) {
        if (tmuxPreviewRequested.current.has(name)) continue;
        tmuxPreviewRequested.current.add(name);
        const history = await invoke<string>("capture_pane_history", {
          name,
          lines: PRELOAD_HISTORY_LINES,
        }).catch(() => "");
        if (!tmuxPreviewLiveRef.current.has(name)) {
          tmuxPreviewRequested.current.delete(name);
          continue;
        }
        setTmuxPreviews((prev) => (
          prev[name] === history ? prev : { ...prev, [name]: history }
        ));
      }
    })();
  }, [sessions, allTerminals]);

  const refresh = useCallback(async () => {
    try {
      const [list, discovered] = await Promise.all([
        invoke<Session[]>("list_sessions"),
        invoke<PlainTerminal[]>("list_tmux_terminals").catch(() => [] as PlainTerminal[]),
      ]);
      const order = sessionOrderRef.current;
      const orderMap = new Map(order.map((n, i) => [n, i]));
      list.sort((a, b) => {
        const ai = orderMap.get(a.name) ?? Infinity;
        const bi = orderMap.get(b.name) ?? Infinity;
        return ai - bi;
      });
      const nowSeconds = Date.now() / 1000;
      const previousActivity = sessionActivityRef.current;
      const nextActivity = new Map<string, PreviousSessionActivity>();
      const nextActivityInfo: Record<string, SessionActivityInfo> = {};
      for (const session of list) {
        const activity = describeSessionActivity(
          {
            name: session.name,
            outputSignature: session.output_signature ?? null,
            agentRunning: session.agent_running ?? null,
          },
          previousActivity.get(session.name),
          nowSeconds,
        );
        nextActivityInfo[session.name] = activity;
        nextActivity.set(session.name, {
          outputSignature: activity.outputSignature,
          lastChangedAt: activity.lastChangedAt,
        });
      }
      sessionActivityRef.current = nextActivity;
      const nextDiscoveredTerminals = discovered.map((terminal) => ({ ...terminal, discovered: true }));
      setSessionActivity((prev) => sameSessionActivity(prev, nextActivityInfo) ? prev : nextActivityInfo);
      setSessions((prev) => sameSessions(prev, list) ? prev : list);
      setDiscoveredTerminals((prev) => samePlainTerminals(prev, nextDiscoveredTerminals) ? prev : nextDiscoveredTerminals);
      setError(null);
      const live = new Set(list.map((s) => s.name));
      const currentTerminals = terminalsRef.current;
      setOpenedSessions((prev) => {
        const next = prev.filter((n) => live.has(n));
        return sameStringArray(prev, next) ? prev : next;
      });
      setCwdsBySession((prev) => {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (live.has(k)) next[k] = v;
        }
        return sameStringRecord(prev, next) ? prev : next;
      });
      setSelection((cur) => {
        if (cur?.kind === "automation") return cur;
        if (
          cur?.kind === "terminal" &&
          [...currentTerminals, ...discovered].some((terminal) => terminal.id === cur.id)
        ) {
          return cur;
        }
        if (cur?.kind === "session" && live.has(cur.name)) return cur;
        if (list.length > 0) return { kind: "session", name: list[0].name };
        if (currentTerminals.length > 0) return { kind: "terminal", id: currentTerminals[0].id };
        if (discovered.length > 0) return { kind: "terminal", id: discovered[0].id };
        return null;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleAutomationCreate = useCallback(
    async (draft: AutomationDraft) => {
      const record = await invoke<AutomationRecord>("save_automation", {
        input: automationSaveInputFromDraft(draft),
      });
      const automation = automationFromRecord(record);
      setSelection({ kind: "automation", id: automation.id });
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationSave = useCallback(
    async (id: string, draft: AutomationDraft) => {
      const record = await invoke<AutomationRecord>("save_automation", {
        input: automationSaveInputFromDraft(draft, id),
      });
      const automation = automationFromRecord(record);
      setSelection({ kind: "automation", id: automation.id });
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationToggle = useCallback(
    async (id: string, active: boolean) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      if (!automation) return;
      await invoke<AutomationRecord>("save_automation", {
        input: automationSaveInputFromDraft(
          { ...createAutomationDraft(automation), active },
          id,
        ),
      });
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationDelete = useCallback(
    async (id: string) => {
      await invoke("delete_automation", { id });
      setAutomationRuns((prev) => prev.filter((run) => run.automationId !== id));
      setSelection((current) =>
        current?.kind === "automation" && current.id === id ? { kind: "automation", id: "" } : current,
      );
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationRun = useCallback(
    async (id: string) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      const runRecord = await invoke<AutomationRunRecord>("trigger_automation", { id });
      const run = automationRunFromRecord(runRecord, automation);
      setAutomationRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)]);
      await Promise.all([loadAutomations(), refresh()]);
    },
    [loadAutomations, refresh],
  );

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const minute = now.toISOString().slice(0, 16);
      for (const automation of automationsRef.current) {
        if (!shouldRunAutomationSchedule(automation, now)) continue;
        const key = `${automation.id}:${minute}`;
        if (scheduledAutomationMinuteRef.current.has(key)) continue;
        scheduledAutomationMinuteRef.current.add(key);
        void handleAutomationRun(automation.id).catch((err) => {
          setAutomationError(String(err));
        });
      }
    };

    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [handleAutomationRun]);

  // Mobile relay connector helpers
  const applyMobileRelayStatus = useCallback((status: MobileRelayStatus) => {
    setMobileRelayActive(status.active);
    setMobileRelayUrl(status.relayUrl);
    setMobileRelayHostId(status.hostId);
    setMobileRelaySecret(status.secret);
    setMobileRelayDraftUrl(status.relayUrl);
    setMobileRelayDraftHostId(status.hostId);
    setMobileRelayDraftSecret(status.secret);
    setMobileRelayError(status.error ?? null);
  }, []);

  const checkMobileRelayStatus = useCallback(async () => {
    try {
      const status = await invoke<MobileRelayStatus>("mobile_relay_status");
      applyMobileRelayStatus(status);
      return status;
    } catch {
      return { active: false, relayUrl: "wss://relay.example.com", hostId: "mac-admin", secret: "", token: "", error: null };
    }
  }, [applyMobileRelayStatus]);

  const handleMobileRelayToggle = useCallback(async () => {
    if (mobileRelayActive) {
      setMobileRelayPopover(true);
    } else {
      const status = await checkMobileRelayStatus();
      if (!status.secret.trim()) {
        setMobileRelayPopover(true);
        setMobileRelayError(null);
        return;
      }
      setMobileRelayLoading(true);
      setMobileRelayPopover(true);
      setMobileRelayError(null);
      try {
        await invoke("mobile_relay_start");
        const status = await invoke<MobileRelayStatus>("mobile_relay_status");
        applyMobileRelayStatus(status);
      } catch (err) {
        setMobileRelayError(String(err));
      } finally {
        setMobileRelayLoading(false);
      }
    }
  }, [applyMobileRelayStatus, checkMobileRelayStatus, mobileRelayActive]);

  const saveMobileRelayConfig = useCallback(async () => {
    const args = {
      relayUrl: mobileRelayDraftUrl.trim(),
      hostId: mobileRelayDraftHostId.trim(),
      secret: mobileRelayDraftSecret.trim(),
    };
    if (!args.relayUrl || !args.hostId) {
      throw new Error("Relay URL and host are required");
    }
    const status = await invoke<MobileRelayStatus>("mobile_relay_save_config", { args });
    applyMobileRelayStatus(status);
    return status;
  }, [applyMobileRelayStatus, mobileRelayDraftHostId, mobileRelayDraftSecret, mobileRelayDraftUrl]);

  const handleMobileRelaySave = useCallback(async () => {
    setMobileRelaySaving(true);
    setMobileRelayError(null);
    try {
      await saveMobileRelayConfig();
    } catch (err) {
      setMobileRelayError(String(err));
    } finally {
      setMobileRelaySaving(false);
    }
  }, [saveMobileRelayConfig]);

  const handleMobileRelayStart = useCallback(async () => {
    setMobileRelayLoading(true);
    setMobileRelayError(null);
    try {
      const saved = await saveMobileRelayConfig();
      if (!saved.secret.trim()) throw new Error("Relay token is required before Android can connect");
      await invoke("mobile_relay_start");
      const status = await invoke<MobileRelayStatus>("mobile_relay_status");
      applyMobileRelayStatus(status);
    } catch (err) {
      setMobileRelayError(String(err));
    } finally {
      setMobileRelayLoading(false);
    }
  }, [applyMobileRelayStatus, saveMobileRelayConfig]);

  const handleMobileRelayStartBroker = useCallback(async () => {
    if (!mobileRelayBrokerHostId) return;
    const wasActive = mobileRelayActive;
    setMobileRelayBrokerStarting(true);
    setMobileRelayError(null);
    try {
      const status = await invoke<MobileRelayStatus>("mobile_relay_start_broker", {
        args: { hostId: mobileRelayBrokerHostId, port: 8787 },
      });
      applyMobileRelayStatus(status);
      if (wasActive) {
        await invoke("mobile_relay_stop");
      }
      await invoke("mobile_relay_start");
      const activeStatus = await invoke<MobileRelayStatus>("mobile_relay_status");
      applyMobileRelayStatus(activeStatus);
    } catch (err) {
      setMobileRelayError(String(err));
    } finally {
      setMobileRelayBrokerStarting(false);
    }
  }, [applyMobileRelayStatus, mobileRelayActive, mobileRelayBrokerHostId]);

  const handleMobileRelayStop = useCallback(async () => {
    await invoke("mobile_relay_stop");
    const status = await invoke<MobileRelayStatus>("mobile_relay_status");
    applyMobileRelayStatus(status);
    setMobileRelayPopover(false);
    setMobileRelayError(null);
  }, [applyMobileRelayStatus]);

  const copyMobileLaunch = useCallback(() => {
    const command = [
      "adb shell am start -n com.tmuxworktree.mobile/.MainActivity",
      `  --es relayUrl '${mobileRelayUrl}'`,
      `  --es hostId '${mobileRelayHostId}'`,
      mobileRelaySecret ? `  --es relaySecret '${mobileRelaySecret}'` : "  --es relaySecret '<TW_RELAY_SECRET>'",
      "  --ez autoConnect true",
    ].join(" \\\n");
    void navigator.clipboard.writeText(command);
  }, [mobileRelayHostId, mobileRelaySecret, mobileRelayUrl]);

  const copyMobileRelayValue = useCallback((value: string) => {
    if (value) void navigator.clipboard.writeText(value);
  }, []);

  useEffect(() => { checkMobileRelayStatus(); }, [checkMobileRelayStatus]);

  useEffect(() => {
    if (mobileRelayBrokerHostId || hosts.length === 0) return;
    const preferred = hosts.find((host) => host.id === "devbox") ?? hosts[0];
    setMobileRelayBrokerHostId(preferred.id);
  }, [hosts, mobileRelayBrokerHostId]);

  // Lazily attach live PTYs; startup preloads snapshots instead.
  useEffect(() => {
    if (selection?.kind !== "session") return;
    const name = selection.name;
    setOpenedSessions((prev) =>
      prev.includes(name) ? prev : [...prev, name],
    );
    if (cwdsBySession[name] || cwdRequested.current.has(name)) return;
    cwdRequested.current.add(name);
    invoke<string>("session_root", { name })
      .then((cwd) => {
        if (cwd) setCwdsBySession((prev) => ({ ...prev, [name]: cwd }));
      })
      .catch(() => {})
      .finally(() => {
        cwdRequested.current.delete(name);
      });
  }, [selection, cwdsBySession]);

  // Lazily attach plain tmux terminals too.
  useEffect(() => {
    if (selection?.kind !== "terminal") return;
    const id = selection.id;
    setOpenedTerminals((prev) =>
      prev.includes(id) ? prev : [...prev, id],
    );
  }, [selection]);

  useEffect(() => {
    const liveTerminalIds = new Set(allTerminals.map((terminal) => terminal.id));
    setOpenedTerminals((prev) => {
      const next = prev.filter((id) => liveTerminalIds.has(id));
      return sameStringArray(prev, next) ? prev : next;
    });
  }, [allTerminals]);

  // Resolve current cwd for selected item
  const selectedAutomation =
    selection?.kind === "automation"
      ? automations.find((automation) => automation.id === selection.id) ?? null
      : null;
  const selectedAutomationProjectPath =
    selectedAutomation?.project.trim()
      ? projectPresets.find((project) => project.name === selectedAutomation.project)?.path.trim() || null
      : null;
  const selectedSession =
    selection?.kind === "session"
      ? sessions.find((session) => session.name === selection.name) ?? null
      : null;
  const selectedTerminal =
    selection?.kind === "terminal"
      ? allTerminals.find((terminal) => terminal.id === selection.id) ?? null
      : null;
  const selectedSessionIsRemote = !!selectedSession?.hostId;
  const selectedGitHostId =
    selection?.kind === "session"
      ? selectedSession?.hostId ?? null
      : selection?.kind === "terminal"
        ? selectedTerminal?.hostId ?? null
        : null;
  const selectedCwd: string | null =
    selection?.kind === "session"
      ? cwdsBySession[selection.name] ?? null
      : selection?.kind === "terminal"
        ? selectedTerminal?.cwd ?? null
        : selection?.kind === "automation"
          ? selectedAutomation?.path || selectedAutomationProjectPath
          : null;

  const desktopRoot = homeDir ? `${homeDir.replace(/\/+$/, "")}/Desktop` : null;
  const localSelectedCwd = selectedGitHostId ? null : selectedCwd;
  const fileBrowserRoot =
    selection?.kind === "automation"
      ? selectedCwd ?? desktopRoot
      : localSelectedCwd ?? homeDir ?? "/";

  const projectPresetForSession = useCallback(
    (sessionName: string): string | null => {
      const key = projectKey(sessionName);
      return projectPresets.some((project) => project.name === key) ? key : null;
    },
    [projectPresets],
  );

  useEffect(() => {
    if ((selection?.kind === "session" || selection?.kind === "terminal") && selectedCwd && !selectedGitHostId) {
      setLastAutomationContextPath(selectedCwd);
      setLastAutomationContextProject(
        selection.kind === "session" ? projectPresetForSession(selection.name) : null,
      );
    }
  }, [projectPresetForSession, selection, selectedCwd, selectedGitHostId]);

  const handleNewAutomation = useCallback(() => {
    if ((selection?.kind === "session" || selection?.kind === "terminal") && selectedCwd && !selectedGitHostId) {
      setLastAutomationContextPath(selectedCwd);
      setLastAutomationContextProject(
        selection.kind === "session" ? projectPresetForSession(selection.name) : null,
      );
    } else if (selection?.kind === "session" && !selectedSessionIsRemote) {
      const name = selection.name;
      void invoke<string>("session_root", { name })
        .then((cwd) => {
          if (cwd) {
            setLastAutomationContextPath(cwd);
            setLastAutomationContextProject(projectPresetForSession(name));
          }
        })
        .catch(() => {});
    }
    setSelection({ kind: "automation", id: "" });
  }, [projectPresetForSession, selection, selectedCwd, selectedGitHostId, selectedSessionIsRemote]);

  const handleOpenFile = useCallback((path: string, _line?: number, _col?: number) => {
    setDiffFile(null);
    setEditingFile(path);
  }, []);

  const selectionKey =
    selection?.kind === "session"
      ? `s:${selection.name}`
      : selection?.kind === "terminal"
        ? `t:${selection.id}`
        : null;

  const ensureScratch = useCallback((key: string) => {
    setScratchTerminals((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, {
        list: [{ id: `scratch-${++scratchIdCounter}`, label: "zsh 1" }],
        nextNum: 2,
      });
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectionKey) ensureScratch(selectionKey);
  }, [selectionKey, ensureScratch]);

  const addScratchTerminal = useCallback(() => {
    if (!selectionKey) return;
    setScratchTerminals((prev) => {
      const state = prev.get(selectionKey) ?? { list: [], nextNum: 1 };
      const num = state.nextNum;
      const next = new Map(prev);
      next.set(selectionKey, {
        list: [...state.list, { id: `scratch-${++scratchIdCounter}`, label: `zsh ${num}` }],
        nextNum: num + 1,
      });
      return next;
    });
    // Reset inline flex so all sections share space equally
    const container = scratchSectionsRef.current;
    if (container) {
      for (const child of Array.from(container.children) as HTMLElement[]) {
        child.style.flex = "";
      }
    }
  }, [selectionKey]);

  const removeScratchTerminal = useCallback((scratchId: string) => {
    if (!selectionKey) return;
    setScratchTerminals((prev) => {
      const state = prev.get(selectionKey);
      if (!state || state.list.length <= 1) return prev;
      const next = new Map(prev);
      next.set(selectionKey, {
        ...state,
        list: state.list.filter((s) => s.id !== scratchId),
      });
      return next;
    });
    // Reset inline flex so remaining sections share space equally
    const container = scratchSectionsRef.current;
    if (container) {
      for (const child of Array.from(container.children) as HTMLElement[]) {
        child.style.flex = "";
      }
    }
  }, [selectionKey]);

  const startScratchSplit = (index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const container = scratchSectionsRef.current;
    if (!container) return;
    const sections = Array.from(container.children) as HTMLElement[];
    if (index < 1 || index >= sections.length) return;
    const prevSection = sections[index - 1];
    const currSection = sections[index];
    const startY = e.clientY;
    const startPrevH = prevSection.getBoundingClientRect().height;
    const startCurrH = currSection.getBoundingClientRect().height;
    const totalH = startPrevH + startCurrH;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const newPrevH = Math.max(60, Math.min(totalH - 60, startPrevH + dy));
      const newCurrH = totalH - newPrevH;
      prevSection.style.flex = `0 0 ${newPrevH}px`;
      currSection.style.flex = `0 0 ${newCurrH}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const openScratch = useCallback(() => {
    setColumnOrder((order) => placeScratchAfterMain(order));
    setScratchCollapsed(false);
  }, []);

  const colorMap = new Map<string, string>();
  const sessionGroups = groupSessionsByProject(sessions, hosts);
  const collapsedProjectSet = new Set(collapsedProjects);
  const toggleProjectCollapsed = (projectKey: string) => {
    setCollapsedProjects((prev) =>
      prev.includes(projectKey)
        ? prev.filter((item) => item !== projectKey)
        : [...prev, projectKey],
    );
  };
  const totalCount = sessions.length + allTerminals.length + automations.length;

  const sessionSortable = useSortable(
    sessions,
    (reordered) => {
      setSessions(reordered);
      setSessionOrder(reordered.map((s) => s.name));
    },
  );

  const terminalSortable = useSortable(
    terminals,
    (reordered) => setTerminals(reordered),
  );

  const SPLITTER_W = 1;
  const scratchWidth = cols.right;
  const isColumnActive = (column: LayoutColumn) => {
    if (column === "file") return fileBrowserOpen;
    if (column === "scratch") return !scratchCollapsed;
    if (column === "editor") return editorPanelOpen;
    return true;
  };
  const activeColumnOrder = columnOrder.filter(isColumnActive);
  activeColumnOrderRef.current = activeColumnOrder;

  const fixedColumnsWidth = activeColumnOrder.reduce((total, column) => {
    if (column === "file") return total + fileTreeWidth;
    if (column === "scratch") return total + scratchWidth;
    if (column === "editor") return total + editorWidth;
    return total;
  }, 0);
  const mainWidth = Math.max(
    200,
    containerWidth - cols.left - fixedColumnsWidth - activeColumnOrder.length * SPLITTER_W,
  );

  const columnTrackWidth = (column: LayoutColumn) => {
    if (column === "file") return fileTreeWidth;
    if (column === "scratch") return scratchWidth;
    if (column === "editor") return editorWidth;
    return mainWidth;
  };
  const gridCols = `${cols.left}px ${SPLITTER_W}px ${activeColumnOrder
    .map((column) => `${columnTrackWidth(column)}px`)
    .join(` ${SPLITTER_W}px `)}`;

  const columnGridColumn = (column: LayoutColumn) => {
    const index = activeColumnOrder.indexOf(column);
    return index < 0 ? undefined : 3 + index * 2;
  };

  const columnClass = (column: LayoutColumn, base: string) => {
    let cls = `${base} layout-column layout-column--draggable`;
    if (columnDrag?.from === column) cls += " layout-column--dragging";
    if (columnDrag && columnDrag.over === column && columnDrag.from !== column) {
      const fromIndex = activeColumnOrder.indexOf(columnDrag.from);
      const overIndex = activeColumnOrder.indexOf(column);
      cls += fromIndex > overIndex ? " layout-column--drop-before" : " layout-column--drop-after";
    }
    return cls;
  };

  const renderColumnHandle = (column: LayoutColumn, label: string) => (
    <button
      className="column-drag-handle"
      type="button"
      onPointerDown={startColumnDrag(column)}
      title={`reorder ${label}`}
      aria-label={`reorder ${label}`}
    >
      <span />
      <span />
    </button>
  );

  const columnSplitters = activeColumnOrder.slice(1).map((right, index) => {
    const left = activeColumnOrder[index];
    const resizable = canResizeColumns(left, right);
    return (
      <div
        key={`${left}-${right}`}
        className={`splitter${resizable ? "" : " splitter--disabled"}`}
        style={{ gridColumn: 4 + index * 2 }}
        onMouseDown={resizable ? startColumnResize(left, right) : undefined}
        aria-label={`resize ${left} and ${right}`}
      />
    );
  });

  const renderSessionRow = (s: Session, i: number) => {
    const displayName = sessionDisplayName(s);
    const key = sessionProjectKey(s);
    const color = colorForProject(colorMap, s.hostId ? `${s.hostId}:${key}` : key);
    const hostLabel = s.hostId ? hosts.find((h) => h.id === s.hostId)?.label ?? s.hostId : null;
    const isSelected = selection?.kind === "session" && selection.name === s.name;
    const isDragging = sessionSortable.dragIndex === i;
    const isDragOver =
      sessionSortable.dragIndex !== null &&
      sessionSortable.overIndex === i &&
      sessionSortable.dragIndex !== i;
    const dragOverClass = isDragOver
      ? sessionSortable.dragIndex! > i
        ? "session--drag-over-before"
        : "session--drag-over-after"
      : "";
    const activity = sessionActivity[s.name];
    const activityState = activity?.state ?? "unknown";
    const activityTitle =
      activity?.state === "running"
        ? "agent is running"
        : activity?.state === "stopped"
          ? activity.ageSeconds == null
            ? "agent is stopped"
            : `agent stopped ${activity.label} ago`
          : "agent status unknown";

    return (
      <div
        key={s.name}
        data-sort-index={i}
        className={`session session--activity-${activityState} ${isSelected ? "session--selected" : ""} ${isDragging ? "session--dragging" : ""} ${dragOverClass} ${s.hostId ? "session--remote" : ""}`}
        onClick={() => {
          if (sessionSortable.draggingRef.current) return;
          setSelection({ kind: "session", name: s.name });
        }}
        onPointerDown={sessionSortable.onPointerDown(i)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            setSelection({ kind: "session", name: s.name });
          }
        }}
        title={hostLabel ? `${hostLabel} - ${displayName}` : undefined}
      >
        <span
          className={`session__dot ${s.attached ? "session__dot--attached" : ""} session__dot--activity-${activityState}`}
          style={{ background: color }}
        />
        <span
          className={`session__host-badge ${hostLabel ? "" : "session__host-badge--empty"}`}
          title={hostLabel ?? undefined}
        >
          {hostLabel ? hostLabel.charAt(0).toUpperCase() : ""}
        </span>
        <span className="session__name">
          <span className="session__head" style={{ color }}>
            {displayName}
          </span>
        </span>
        <span
          className={`session__meta session__meta--activity-${activityState}`}
          title={activityTitle}
        >
          {activity?.label ?? (s.hostId ? "" : "--")}
        </span>
        <button
          type="button"
          className="session__kill"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await invoke("kill_session", { name: s.name });
              setSessions((prev) => prev.filter((x) => x.name !== s.name));
              setOpenedSessions((prev) => prev.filter((n) => n !== s.name));
              setSessionOrder((prev) => prev.filter((n) => n !== s.name));
              if (isSelected) {
                const remaining = sessions.filter((x) => x.name !== s.name);
                setSelection(
                  remaining.length > 0 ? { kind: "session", name: remaining[0].name } : null,
                );
              }
            } catch (err) {
              setError(String(err));
            }
          }}
          title="kill session"
          aria-label={`kill session ${displayName}`}
        >
          ×
        </button>
      </div>
    );
  };

  const mobileRelayStatus = mobileRelayLoading || mobileRelaySaving || mobileRelayBrokerStarting ? "starting" : mobileRelayActive ? "running" : "stopped";
  const mobileRelayStatusText = mobileRelayBrokerStarting ? "Starting broker" : mobileRelayLoading ? "Starting" : mobileRelaySaving ? "Saving" : mobileRelayActive ? "Running" : "Stopped";
  const mobileRelayTokenState = mobileRelaySecret ? "Configured" : "Missing";
  const mobileRelayButtonActive = mobileRelayActive || mobileRelayPopover || mobileRelayLoading || mobileRelayBrokerStarting;

  return (
    <div className="app" ref={appRef} style={{ gridTemplateColumns: gridCols }}>
      <div className="titlebar" data-tauri-drag-region />

      {/* ── Sidebar (always visible) ── */}
      <aside className="sidebar">
        <header className="sidebar__header">
          <div className="brand">
            <span className="brand__mark" />
            <span className="brand__text">tmux-worktree</span>
            <div style={{ position: "relative", marginLeft: "auto", display: "flex", alignItems: "center", gap: "2px" }}>
              <button
                className={`brand__file-btn${mobileRelayButtonActive ? " brand__file-btn--active" : ""}`}
                type="button"
                onClick={handleMobileRelayToggle}
                title="mobile relay"
                aria-label="mobile relay"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/>
                  <ellipse cx="8" cy="8" rx="3" ry="6.5" stroke="currentColor" strokeWidth="1.2"/>
                  <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
              </button>
              <button
                className={`brand__file-btn${fileBrowserOpen ? " brand__file-btn--active" : ""}`}
                type="button"
                onClick={() => setFileBrowserOpen((prev) => !prev)}
                title="toggle file browser"
                aria-label="toggle file browser"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1.5 13.5V2.5C1.5 2.1 1.9 1.5 2.5 1.5H6L8 3.5H13.5C14.1 3.5 14.5 4 14.5 4.5V13.5C14.5 14 14.1 14.5 13.5 14.5H2.5C1.9 14.5 1.5 14 1.5 13.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                </svg>
              </button>
              {mobileRelayPopover && (
                <div className="remote-popover">
                  <div className="remote-popover__header">
                    <div>
                      <div className="remote-popover__title">Mobile Relay</div>
                      <div className={`remote-popover__status remote-popover__status--${mobileRelayStatus}`}>
                        <span />
                        {mobileRelayStatusText}
                      </div>
                    </div>
                    <button
                      className="remote-popover__icon-btn"
                      type="button"
                      onClick={() => setMobileRelayPopover(false)}
                      title="Close"
                      aria-label="Close mobile relay menu"
                    >
                      ×
                    </button>
                  </div>

                  <div className="remote-popover__fields">
                    <div className="remote-popover__field">
                      <span className="remote-popover__label">Broker</span>
                      <select
                        className="remote-popover__input"
                        value={mobileRelayBrokerHostId}
                        onChange={(event) => setMobileRelayBrokerHostId(event.target.value)}
                        disabled={mobileRelayLoading || mobileRelaySaving || mobileRelayBrokerStarting || hosts.length === 0}
                      >
                        {hosts.length === 0 ? (
                          <option value="">No SSH hosts</option>
                        ) : (
                          hosts.map((host) => (
                            <option key={host.id} value={host.id}>
                              {host.label || host.id}
                            </option>
                          ))
                        )}
                      </select>
                      <span className="remote-popover__spacer" />
                    </div>
                    <div className="remote-popover__field">
                      <span className="remote-popover__label">Relay URL</span>
                      <input
                        className="remote-popover__input"
                        value={mobileRelayDraftUrl}
                        onChange={(event) => setMobileRelayDraftUrl(event.target.value)}
                        disabled={mobileRelayActive || mobileRelayLoading || mobileRelaySaving}
                        spellCheck={false}
                      />
                      <button
                        className="remote-popover__icon-btn"
                        type="button"
                        onClick={() => copyMobileRelayValue(mobileRelayDraftUrl)}
                        title="Copy relay URL"
                        aria-label="Copy relay URL"
                      >
                        ⎘
                      </button>
                    </div>
                    <div className="remote-popover__field">
                      <span className="remote-popover__label">Host</span>
                      <input
                        className="remote-popover__input"
                        value={mobileRelayDraftHostId}
                        onChange={(event) => setMobileRelayDraftHostId(event.target.value)}
                        disabled={mobileRelayActive || mobileRelayLoading || mobileRelaySaving}
                        spellCheck={false}
                      />
                      <button
                        className="remote-popover__icon-btn"
                        type="button"
                        onClick={() => copyMobileRelayValue(mobileRelayDraftHostId)}
                        title="Copy host"
                        aria-label="Copy host"
                      >
                        ⎘
                      </button>
                    </div>
                    <div className="remote-popover__field">
                      <span className="remote-popover__label">Token</span>
                      <input
                        className="remote-popover__input"
                        type="password"
                        value={mobileRelayDraftSecret}
                        onChange={(event) => setMobileRelayDraftSecret(event.target.value)}
                        disabled={mobileRelayActive || mobileRelayLoading || mobileRelaySaving}
                        placeholder={mobileRelayTokenState}
                        spellCheck={false}
                      />
                      <button
                        className="remote-popover__icon-btn"
                        type="button"
                        onClick={() => copyMobileRelayValue(mobileRelayDraftSecret)}
                        title="Copy token"
                        aria-label="Copy token"
                        disabled={!mobileRelayDraftSecret}
                      >
                        ⎘
                      </button>
                    </div>
                  </div>

                  {mobileRelayError && (
                    <div className="remote-popover__error">{mobileRelayError}</div>
                  )}

                  <div className="remote-popover__actions">
                    {mobileRelayActive ? (
                      <>
                        <button
                          className="remote-popover__action"
                          type="button"
                          onClick={copyMobileLaunch}
                          disabled={!mobileRelaySecret}
                        >
                          Copy Android Launch
                        </button>
                        <button
                          className="remote-popover__action remote-popover__action--primary"
                          type="button"
                          onClick={handleMobileRelayStartBroker}
                          disabled={mobileRelayBrokerStarting || mobileRelayLoading || mobileRelaySaving || !mobileRelayBrokerHostId}
                        >
                          Switch Broker
                        </button>
                        <button
                          className="remote-popover__action remote-popover__action--danger"
                          type="button"
                          onClick={handleMobileRelayStop}
                        >
                          Stop
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="remote-popover__action"
                          type="button"
                          onClick={handleMobileRelayStartBroker}
                          disabled={mobileRelayBrokerStarting || mobileRelayLoading || mobileRelaySaving || !mobileRelayBrokerHostId}
                        >
                          Start Broker
                        </button>
                        <button
                          className="remote-popover__action"
                          type="button"
                          onClick={handleMobileRelaySave}
                          disabled={mobileRelaySaving || mobileRelayLoading || mobileRelayBrokerStarting}
                        >
                          Save
                        </button>
                        <button
                          className="remote-popover__action remote-popover__action--primary"
                          type="button"
                          onClick={handleMobileRelayStart}
                          disabled={mobileRelaySaving || mobileRelayLoading || mobileRelayBrokerStarting || !mobileRelayDraftSecret.trim()}
                        >
                          Start
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="sidebar__buttons">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => setShowNewWorktree(true)}
            >
              + worktree
            </button>
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => setShowNewTerminal(true)}
            >
              + terminal
            </button>
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => setShowAddHost(true)}
              title="add ssh host"
            >
              + host
            </button>
          </div>
          {hosts.length > 0 && (
            <div className="sidebar__host-status hosts-bar">
              {hosts.map((h) => {
                const st = hostStatuses[h.id];
                const reachable = st?.reachable ?? false;
                const twAvailable = st?.twAvailable ?? false;
                const twLabel = st
                  ? twAvailable
                    ? `tw ${st.twVersion ?? "ok"}`
                    : reachable
                      ? "tw missing"
                      : ""
                  : "";
                return (
                  <span
                    key={h.id}
                    className={`hosts-bar__item ${reachable ? "hosts-bar__item--up" : "hosts-bar__item--down"}`}
                    title={st?.error ?? st?.twError ?? (reachable ? `connected (${st.latencyMs}ms)` : "connecting...")}
                  >
                    <span className="hosts-bar__dot" />
                    <span>{h.label}</span>
                    {twLabel && <span className="hosts-bar__tw">{twLabel}</span>}
                    {reachable && st && !twAvailable && (
                      <button
                        type="button"
                        className="hosts-bar__install"
                        onClick={(event) => {
                          event.stopPropagation();
                          void installRemoteTw(h.id);
                        }}
                        disabled={installingHostId === h.id}
                        title={st.twError ?? "install remote tw"}
                      >
                        {installingHostId === h.id ? "installing" : "install"}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </header>

        <div className="sidebar__split" ref={sidebarSplitRef}>
          <div className="sidebar__lists" ref={sessionsListRef}>
            {/* ── Worktrees section ── */}
            <div
              className="sidebar__section"
              style={{ height: sectionSplit, flexShrink: 0 }}
            >
              <div className="section-label">
                <span className="section-label__text">worktrees</span>
                <span className="section-label__line" />
              </div>
              <nav className={`sidebar__sessions ${sessionSortable.dragIndex !== null ? "sidebar__sessions--dragging" : ""}`} ref={sessionSortable.listRef as React.RefObject<HTMLElement>}>
                {sessions.length === 0 && !error && (
                  <div className="empty empty--small">no sessions</div>
                )}
                {error && <div className="empty empty--error">{error}</div>}
                {sessionGroups.map((group) => {
                  const color = colorForProject(colorMap, group.colorKey);
                  const collapsed = collapsedProjectSet.has(group.key);
                  return (
                    <div className="session-project" key={group.key}>
                      <button
                        type="button"
                        className="session-project__toggle"
                        onClick={() => toggleProjectCollapsed(group.key)}
                        aria-expanded={!collapsed}
                        title={`${collapsed ? "expand" : "collapse"} ${group.hostLabel ? `${group.hostLabel} / ` : ""}${group.project}`}
                      >
                        <span
                          className={`session-project__chevron${collapsed ? "" : " session-project__chevron--open"}`}
                          aria-hidden="true"
                        />
                        <span
                          className="session-project__dot"
                          style={{ background: color }}
                          aria-hidden="true"
                        />
                        <span
                          className={`session-project__host ${group.hostLabel ? "" : "session-project__host--empty"}`}
                          title={group.hostLabel ?? undefined}
                        >
                          {group.hostLabel ? group.hostLabel.charAt(0).toUpperCase() : ""}
                        </span>
                        <span className="session-project__name" title={group.project}>
                          {group.project}
                        </span>
                        <span className="session-project__count">{group.sessions.length}</span>
                      </button>
                      {!collapsed &&
                        group.sessions.map((s) => renderSessionRow(s, sessions.indexOf(s)))}
                    </div>
                  );
                })}
              </nav>
            </div>

            {/* ── Automations section ── */}
            <div
              className="sidebar__section sidebar__section--automations"
              style={{ flex: `0 0 ${automationHeight}px` }}
            >
              <div
                className="section-label section-label--draggable"
                onMouseDown={startSectionSplit}
              >
                <span className="section-label__text">automations</span>
                <span className="section-label__line" />
                <button
                  className="btn btn--small"
                  type="button"
                  onClick={handleNewAutomation}
                  title="new automation"
                  aria-label="new automation"
                >
                  +
                </button>
              </div>
              <nav className="sidebar__sessions sidebar__sessions--compact">
                {automationError && <div className="empty empty--error">{automationError}</div>}
                {automations.length === 0 && !automationError && (
                  <div className="empty empty--small">no automations</div>
                )}
                {automations.map((automation) => {
                  const isSelected =
                    selection?.kind === "automation" && selection.id === automation.id;
                  return (
                    <div
                      key={automation.id}
                      className={`session ${isSelected ? "session--selected" : ""}`}
                      onClick={() => setSelection({ kind: "automation", id: automation.id })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelection({ kind: "automation", id: automation.id });
                      }}
                    >
                      <span
                        className={`session__dot ${automation.active ? "session__dot--attached" : ""}`}
                        style={{ background: automationDotColor(automation) }}
                      />
                      <span className="session__name" title={automation.name}>
                        <span className="session__head">{automation.name || "(unnamed)"}</span>
                        <span className="session__tail"> · {triggerLabel(automation)}</span>
                      </span>
                      <span className="session__meta">{automationMetaLabel(automation)}</span>
                    </div>
                  );
                })}
              </nav>
            </div>

            {/* ── Terminals section ── */}
            <div
              className="sidebar__section"
              style={{ flex: "1 1 0", minHeight: 40 }}
            >
              <div
                className="section-label section-label--draggable"
                onMouseDown={startAutomationSplit}
              >
                <span className="section-label__text">terminals</span>
                <span className="section-label__line" />
              </div>
              <nav className={`sidebar__sessions ${terminalSortable.dragIndex !== null ? "sidebar__sessions--dragging" : ""}`} ref={terminalSortable.listRef as React.RefObject<HTMLElement>}>
                {allTerminals.length === 0 && (
                  <div className="empty empty--small">no terminals</div>
                )}
                {allTerminals.map((t, i) => {
                  const isPersistedTerminal = !t.discovered;
                  const isSelected =
                    selection?.kind === "terminal" && selection.id === t.id;
                  const isDragging = isPersistedTerminal && terminalSortable.dragIndex === i;
                  const isDragOver = isPersistedTerminal && terminalSortable.dragIndex !== null && terminalSortable.overIndex === i && terminalSortable.dragIndex !== i;
                  const dragOverClass = isDragOver
                    ? terminalSortable.dragIndex! > i ? "session--drag-over-before" : "session--drag-over-after"
                    : "";
                  const terminalHostLabel = t.hostId ? hosts.find((h) => h.id === t.hostId)?.label ?? t.hostId : null;
                  return (
                    <div
                      key={t.id}
                      className={`session ${isSelected ? "session--selected" : ""} ${isDragging ? "session--dragging" : ""} ${dragOverClass} ${t.hostId ? "session--remote" : ""}`}
                      onClick={() => {
                        if (terminalSortable.draggingRef.current) return;
                        setSelection({ kind: "terminal", id: t.id });
                      }}
                      onPointerDown={isPersistedTerminal ? terminalSortable.onPointerDown(i) : undefined}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelection({ kind: "terminal", id: t.id });
                      }}
                    >
                      <span className="session__dot" style={{ background: "var(--text-faint)" }} />
                      <span
                        className={`session__host-badge ${terminalHostLabel ? "" : "session__host-badge--empty"}`}
                        title={terminalHostLabel ?? undefined}
                      >
                        {terminalHostLabel ? terminalHostLabel.charAt(0).toUpperCase() : ""}
                      </span>
                      <span className="session__name" onDoubleClick={() => setRenamingTerminal(t.id)}>
                        {isPersistedTerminal && renamingTerminal === t.id ? (
                          <input
                            className="session__rename-input"
                            defaultValue={t.label}
                            autoFocus
                            spellCheck={false}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setRenamingTerminal(null);
                              } else if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            onBlur={(e) => {
                              const val = e.target.value.trim();
                              if (val && val !== t.label && !terminals.some((x) => x.id !== t.id && x.label === val)) {
                                setTerminals((prev) => prev.map((x) => x.id === t.id ? { ...x, label: val } : x));
                              }
                              setRenamingTerminal(null);
                            }}
                          />
                        ) : (
                          <span className="session__head">{t.label}</span>
                        )}
                      </span>
                      <span className="session__meta dim">{terminalHostLabel ? "ssh" : "zsh"}</span>
                      <button
                        type="button"
                        className="session__kill"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          const killName = terminalSessionKey(t);
                          const command = isPersistedTerminal ? "kill_plain_terminal" : "kill_session";
                          invoke(command, { name: killName }).catch(() => {});
                          if (isPersistedTerminal) {
                            setTerminals((prev) =>
                              prev.filter((x) => x.id !== t.id),
                            );
                          } else {
                            setDiscoveredTerminals((prev) =>
                              prev.filter((x) => x.id !== t.id),
                            );
                          }
                          setOpenedTerminals((prev) =>
                            prev.filter((x) => x !== t.id),
                          );
                          if (isSelected) {
                            const remainingTerminals = allTerminals.filter((x) => x.id !== t.id);
                            setSelection(
                              remainingTerminals.length > 0
                                ? { kind: "terminal", id: remainingTerminals[0].id }
                                : sessions.length > 0
                                  ? { kind: "session", name: sessions[0].name }
                                  : null,
                            );
                          }
                        }}
                        title="close terminal"
                        aria-label={`close terminal ${t.label}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </nav>
            </div>
          </div>

          <div className="sidebar__git" style={{ height: gitHeight }}>
            <div
              className="section-label section-label--draggable"
              onMouseDown={startGitSplit}
            >
              <span className="section-label__text">git</span>
              <span className="section-label__line" />
            </div>
            <GitStatusPanel
              cwd={selectedCwd}
              sessionName={
                selection?.kind === "session"
                  ? selection.name
                  : undefined
              }
              hostId={selectedGitHostId}
              onFileClick={(filePath, cwd, hostId) => {
                if (cwd) {
                  setEditingFile(null);
                  setDiffFile({ path: filePath, cwd, hostId: hostId ?? null });
                }
              }}
            />
          </div>
        </div>

        <footer className="sidebar__footer">
          <span className="dim">
            {totalCount} item{totalCount === 1 ? "" : "s"}
          </span>
          <ThemePicker current={theme} onChange={setTheme} />
        </footer>
      </aside>

      {/* ── Left splitter (always visible) ── */}
      <div
        className="splitter"
        style={{ gridColumn: 2 }}
        onMouseDown={startSidebarResize}
        aria-label="resize sidebar"
      />

      {columnSplitters}

      {/* ── File tree column (inserted when open) ── */}
      {fileBrowserOpen && (
        <aside
          className={columnClass("file", "file-tree-panel")}
          ref={setColumnRef("file")}
          style={{ gridColumn: columnGridColumn("file") }}
        >
          {renderColumnHandle("file", "file tree")}
          {fileBrowserRoot ? (
            <FileTree
              root={fileBrowserRoot}
              selectedFile={editingFile}
              onFileSelect={(path) => { setDiffFile(null); setEditingFile(path); }}
            />
          ) : (
            <div className="empty empty--small">loading home directory</div>
          )}
        </aside>
      )}

      {/* ── Main terminal (always visible) ── */}
      <main
        className={columnClass("main", "main")}
        ref={setColumnRef("main")}
        style={{ gridColumn: columnGridColumn("main") }}
      >
        {renderColumnHandle("main", "main terminal")}
        {selection?.kind === "automation" ? (
          <div className="pane pane--automation">
            <div className="pane__bar">
              <span className="pane__title">
                {selectedAutomation?.name || "automations"}
              </span>
              <div className="pane__bar-actions">
                <span className="pane__hint dim">
                  {selectedAutomation ? triggerLabel(selectedAutomation) : "new"}
                </span>
              </div>
            </div>
            <div className="pane__body pane__body--automation">
              {automationError && <div className="modal__error">{automationError}</div>}
              <AutomationPanel
                automations={automations}
                selectedId={selection.id || null}
                runs={automationRuns}
                projectOptions={projectPresets}
                recentPath={lastAutomationContextPath}
                recentProject={lastAutomationContextProject}
                onSelect={(id) => setSelection({ kind: "automation", id })}
                onCreate={handleAutomationCreate}
                onToggle={handleAutomationToggle}
                onRun={handleAutomationRun}
                onDelete={handleAutomationDelete}
                onSave={handleAutomationSave}
                showList={false}
              />
            </div>
          </div>
        ) : selection ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">
                {selection.kind === "session"
                  ? (() => {
                      const sel = sessions.find((s) => s.name === selection.name);
                      const dispName = sel ? sessionDisplayName(sel) : selection.name;
                      if (sel?.hostId) {
                        const h = hosts.find((h) => h.id === sel.hostId);
                        return h ? `${h.label} › ${dispName}` : `${sel.hostId} › ${dispName}`;
                      }
                      return dispName;
                    })()
                  : allTerminals.find((t) => t.id === selection.id)?.label ??
                    selection.id}
              </span>
              <div className="pane__bar-actions">
                <span className="pane__hint dim">
                  {selection.kind === "session"
                    ? (() => {
                        const sel = sessions.find((s) => s.name === selection.name);
                        return sel?.hostId ? "ssh attach" : "tmux attach";
                      })()
                    : (() => {
                        const terminal = allTerminals.find((t) => t.id === selection.id);
                        return terminal?.hostId ? "ssh attach" : "zsh";
                      })()}
                </span>
                <button
                  className={`brand__file-btn scratch__toggle-btn${scratchCollapsed ? "" : " brand__file-btn--active"}`}
                  type="button"
                  onClick={() => {
                    if (scratchCollapsed) {
                      openScratch();
                    } else {
                      setScratchCollapsed(true);
                    }
                  }}
                  title={scratchCollapsed ? "展开 scratch" : "收起 scratch"}
                  aria-label={scratchCollapsed ? "展开 scratch" : "收起 scratch"}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M9.5 2.5V13.5" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M11.4 6L9.8 8L11.4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            <div className="pane__body pane__body--stack">
              {openedSessions.map((name) => {
                const sess = sessions.find((s) => s.name === name);
                const isRemote = sess?.hostId != null;
                const host = isRemote ? hosts.find((h) => h.id === sess!.hostId) : null;
                const rawName = sess?.rawName ?? name;
                const termCmd = isRemote && host ? "ssh" : "tmux";
                const termArgs = isRemote && host
                  ? buildSshAttachArgs(host, rawName)
                  : ["attach-session", "-t", rawName];
                return (
                  <div
                    key={`s:${name}`}
                    className="term-slot"
                    style={{
                      display:
                        selection?.kind === "session" && selection.name === name
                          ? "flex"
                          : "none",
                    }}
                  >
                    <Terminal
                      cmd={termCmd}
                      args={termArgs}
                      cwd={isRemote ? undefined : cwdsBySession[name]}
                      active={
                        !anyModalOpen &&
                        selection?.kind === "session" && selection.name === name
                      }
                      tmuxSession={name}
                      hostId={sess?.hostId ?? null}
                      initialHistory={tmuxPreviews[name]}
                      onOpenFile={isRemote ? undefined : handleOpenFile}
                    />
                  </div>
                );
              })}
              {openedTerminals.map((id) => {
                const t = allTerminals.find((x) => x.id === id);
                if (!t) return null;
                const remoteHost = t.hostId ? hosts.find((h) => h.id === t.hostId) : null;
                if (t.hostId && !remoteHost) return null;
                const rawName = terminalRawName(t);
                const sessionKey = terminalSessionKey(t);
                return (
                  <div
                    key={`t:${id}`}
                    className="term-slot"
                    style={{
                      display:
                        selection?.kind === "terminal" && selection.id === id
                          ? "flex"
                          : "none",
                    }}
                  >
                    <Terminal
                      cmd={t.hostId ? "ssh" : "tmux"}
                      args={
                        t.hostId && remoteHost
                          ? buildSshAttachArgs(remoteHost, rawName)
                          : ["attach-session", "-t", t.tmuxName]
                      }
                      cwd={t.hostId ? undefined : t.cwd}
                      active={
                        !anyModalOpen &&
                        selection?.kind === "terminal" && selection.id === id
                      }
                      tmuxSession={sessionKey}
                      hostId={t.hostId ?? null}
                      initialHistory={tmuxPreviews[sessionKey]}
                      onOpenFile={t.hostId ? undefined : handleOpenFile}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="pane pane--empty">
            <div className="pane__hint">
              select a session, terminal, or automation
            </div>
          </div>
        )}
      </main>

      {/* ── Scratch panel ── */}
      {!scratchCollapsed && (
        <aside
          className={columnClass("scratch", "scratch")}
          ref={setColumnRef("scratch")}
          style={{ gridColumn: columnGridColumn("scratch") }}
        >
          {renderColumnHandle("scratch", "scratch")}
          {scratchTerminals.size > 0 ? (
            <div className="pane pane--term">
              <div className="pane__bar">
                <span className="pane__title">scratch</span>
                <div className="pane__bar-actions">
                  <button
                    className="btn btn--small"
                    type="button"
                    onClick={addScratchTerminal}
                  >
                    +
                  </button>
                </div>
              </div>
              {Array.from(scratchTerminals.entries()).map(([key, state]) => {
                const isActive = key === selectionKey;
                const scratchContext = (() => {
                  if (key.startsWith("s:")) {
                    const sessionName = key.slice(2);
                    const session = sessions.find((s) => s.name === sessionName);
                    const cwd = cwdsBySession[sessionName] ?? null;
                    if (!cwd) return null;
                    if (!session?.hostId) return { cwd, host: null };
                    const host = hosts.find((h) => h.id === session.hostId) ?? null;
                    return host ? { cwd, host } : null;
                  }
                  if (key.startsWith("t:")) {
                    const terminal = allTerminals.find((t) => t.id === key.slice(2));
                    const cwd = terminal?.cwd ?? null;
                    if (!cwd) return null;
                    if (!terminal?.hostId) return { cwd, host: null };
                    const host = hosts.find((h) => h.id === terminal.hostId) ?? null;
                    return host ? { cwd, host } : null;
                  }
                  return null;
                })();
                if (!scratchContext) return null;
                return (
                  <div
                    key={key}
                    className="scratch__sections"
                    ref={isActive ? scratchSectionsRef : undefined}
                    style={{ display: isActive ? "flex" : "none" }}
                  >
                    {state.list.map((st, i) => (
                      <div key={st.id} className="scratch__section">
                        <div
                          className={`section-label${i > 0 ? " section-label--draggable" : ""}`}
                          onMouseDown={i > 0 ? startScratchSplit(i) : undefined}
                        >
                          <span className="section-label__text">{st.label}</span>
                          <div className="section-label__line" />
                          {state.list.length > 1 && (
                            <button
                              className="scratch__close"
                              type="button"
                              onClick={() => removeScratchTerminal(st.id)}
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <div className="scratch__term">
                          <Terminal
                            cmd={scratchContext.host ? "ssh" : "/bin/zsh"}
                            args={
                              scratchContext.host
                                ? buildSshShellArgs(scratchContext.host, scratchContext.cwd)
                                : ["-l"]
                            }
                            cwd={scratchContext.host ? undefined : scratchContext.cwd}
                            active={isActive && !anyModalOpen}
                            hostId={scratchContext.host?.id ?? null}
                            onOpenFile={scratchContext.host ? undefined : handleOpenFile}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pane pane--empty">
              <div className="pane__hint">scratch</div>
            </div>
          )}
        </aside>
      )}

      {/* ── Editor column (appended when a file is selected) ── */}
      {editorPanelOpen && (
        <aside
          className={columnClass("editor", "editor-panel")}
          ref={setColumnRef("editor")}
          style={{ gridColumn: columnGridColumn("editor") }}
        >
          {renderColumnHandle("editor", "editor")}
          {diffFile ? (
            <DiffViewer
              cwd={diffFile.cwd}
              filePath={diffFile.path}
              hostId={diffFile.hostId ?? null}
              onClose={() => setDiffFile(null)}
            />
          ) : editingFile ? (
            <FileEditor filePath={editingFile} onClose={() => setEditingFile(null)} onOpenFile={handleOpenFile} />
          ) : null}
        </aside>
      )}

      {showNewWorktree && (
        <NewWorktreeModal
          hosts={hosts}
          onClose={() => setShowNewWorktree(false)}
          onCreated={(sessionName) => {
            setShowNewWorktree(false);
            setSelection({ kind: "session", name: sessionName });
            void loadProjectPresets();
            refresh();
          }}
        />
      )}

      {showNewTerminal && (
        <NewTerminalModal
          hosts={hosts}
          existingLabels={allTerminals.map((t) => t.label)}
          onClose={() => setShowNewTerminal(false)}
          onCreated={async (draft: TerminalDraft) => {
            const created = await invoke<CreatedTerminal>("create_terminal", {
              args: {
                cwd: draft.cwd,
                aiCmd: draft.aiCmd,
                hostId: draft.hostId ?? null,
              },
            });
            const id = `term-${++termIdCounter}`;
            setTerminals((prev) => [
              ...prev,
              {
                id,
                label: draft.label,
                cwd: draft.cwd,
                tmuxName: created.tmuxName,
                hostId: created.hostId ?? draft.hostId ?? null,
                rawName: created.rawName,
                aiCmd: draft.aiCmd,
              },
            ]);
            setShowNewTerminal(false);
            setSelection({ kind: "terminal", id });
          }}
        />
      )}

      {showAddHost && (
        <AddHostModal
          existingIds={hosts.map((h) => h.id)}
          sshHosts={sshHostCandidates}
          onClose={() => setShowAddHost(false)}
          onAdded={(newHosts) => {
            setHosts(newHosts);
            setShowAddHost(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

export default App;
