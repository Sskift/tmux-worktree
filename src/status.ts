import { readdir, stat } from "node:fs/promises";
import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

// ─── Config ───
const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const RUNNING_THRESHOLD_SEC = 10;
const REFRESH_INTERVAL_MS = 2000;

// ─── ANSI / terminal escape sequences ───
const esc = {
  altScreenEnter: "\x1b[?1049h",
  altScreenExit: "\x1b[?1049l",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  cursorHome: "\x1b[H",
  clearScreen: "\x1b[2J",
  clearLine: "\x1b[2K",
  mouseOn: "\x1b[?1000h\x1b[?1006h",
  mouseOff: "\x1b[?1000l\x1b[?1006l",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[0m`,
};

// ─── Terminal helpers ───
function write(s: string) {
  process.stdout.write(s);
}

function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 200,
  };
}

// ─── Shell exec helper ───
function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

// ─── Types ───
type AgentType = "claude" | "codex" | "coco" | "none";
type AgentState = "running" | "idle" | "permission" | "shell";

interface ClaudeMetadata {
  state: AgentState;
  model: string;
  gitBranch: string;
  durationMs: number;
  ageSeconds: number;
  lastUserText: string;
}

interface SessionInfo {
  name: string;
  agent: AgentType;
  state: AgentState;
  meta?: ClaudeMetadata;
  cwd: string;
}

// ─── Row-to-session mapping (for mouse clicks) ───
let rowSessionMap: Map<
  number,
  { name: string; colStart: number; colEnd: number }
> = new Map();

// ─── Detect agent type from process tree ───
let psCache: string = "";

function refreshPsCache() {
  psCache = sh("ps -eo pid,ppid,command");
}

function detectAgent(panePid: string): AgentType {
  if (!psCache) return "none";

  const lines = psCache.split("\n").slice(1);
  const children = new Map<string, string[]>();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const ppid = parts[1];
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(line);
  }

  const descendantCmds: string[] = [];
  const queue = [panePid];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    for (const line of children.get(pid) || []) {
      descendantCmds.push(line);
      queue.push(line.trim().split(/\s+/)[0]);
    }
  }

  const joined = descendantCmds.join("\n");
  if (/claude|claude-code/.test(joined)) return "claude";
  if (/codex/.test(joined)) return "codex";
  if (/coco(?:[^a-z]|$)/.test(joined)) return "coco";
  return "none";
}

// ─── Pane content helpers ───
function paneHasPermissionPrompt(session: string): boolean {
  const content = sh(
    `tmux capture-pane -t "${session}" -p 2>/dev/null | tail -10`
  );
  return /Allow |Do you want to|Yes.*No.*Always/.test(content);
}

function detectPaneState(session: string): AgentState {
  const content = sh(
    `tmux capture-pane -t "${session}" -p 2>/dev/null | tail -15`
  );
  if (!content) return "shell";
  if (/Allow |Do you want to|Yes.*No.*Always/.test(content))
    return "permission";
  if (/^❯/m.test(content)) return "idle";
  const lastNonBlank = content
    .split("\n")
    .filter((l) => l.trim())
    .pop();
  if (lastNonBlank && /\$\s*$/.test(lastNonBlank)) return "shell";
  return "running";
}

// ─── Read tail of a file using Node.js fs ───
function readFileTail(filePath: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return "";
  }
  try {
    const totalSize = fstatSync(fd).size;
    const chunkSize = Math.min(totalSize, maxBytes);
    const offset = totalSize - chunkSize;
    const buf = Buffer.alloc(chunkSize);
    readSync(fd, buf, 0, chunkSize, offset);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

// ─── Get Claude Code metadata from JSONL ───
async function getClaudeMetadata(cwd: string): Promise<ClaudeMetadata | null> {
  const projectDirName = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  const projectPath = join(PROJECTS_DIR, projectDirName);

  let entries: string[];
  try {
    entries = await readdir(projectPath);
  } catch {
    return null;
  }

  const jsonlFiles: { path: string; mtime: number }[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = join(projectPath, f);
    try {
      const st = await stat(fp);
      jsonlFiles.push({ path: fp, mtime: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  if (jsonlFiles.length === 0) return null;

  jsonlFiles.sort((a, b) => b.mtime - a.mtime);
  const latestJsonl = jsonlFiles[0];
  const ageSeconds = (Date.now() - latestJsonl.mtime) / 1000;

  const tail = readFileTail(latestJsonl.path, 200_000);
  const lines = tail.trim().split("\n");

  let model = "";
  let gitBranch = "";
  let durationMs = 0;
  let lastUserText = "";
  let lastType = "";
  let lastSubtype = "";

  for (const rawLine of lines.slice(-30)) {
    let d: any;
    try {
      d = JSON.parse(rawLine);
    } catch {
      continue;
    }
    const t: string = d.type ?? "";
    if (t === "progress" || t === "file-history-snapshot") continue;

    lastType = t;
    lastSubtype = d.subtype ?? "";
    gitBranch = d.gitBranch || gitBranch;

    if (t === "assistant") {
      model = d.message?.model || model;
    } else if (t === "user") {
      const content = d.message?.content;
      if (typeof content === "string" && content.trim()) {
        lastUserText = content.trim().slice(0, 60);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === "text" && item.text?.trim()) {
            lastUserText = item.text.trim().slice(0, 60);
          }
        }
      }
    } else if (t === "system" && d.subtype === "turn_duration") {
      durationMs = d.durationMs ?? 0;
    }
  }

  const isTurnDone = lastType === "system" && lastSubtype === "turn_duration";
  const isFresh = ageSeconds < RUNNING_THRESHOLD_SEC;

  let state: AgentState;
  if (isTurnDone) state = "idle";
  else if (isFresh) state = "running";
  else state = "idle";

  return { state, model, gitBranch, durationMs, ageSeconds, lastUserText };
}

// ─── Format helpers ───
function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

function formatAge(secs: number): string {
  if (secs < 0) return "";
  secs = Math.floor(secs);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number): string {
  const needed = Math.max(0, width - visibleLen(s));
  return s + " ".repeat(needed);
}

function truncate(s: string, maxVisible: number): string {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= maxVisible) return s;

  let visible = 0;
  let i = 0;
  while (i < s.length && visible < maxVisible - 1) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visible++;
    i++;
  }
  return s.slice(0, i) + "…\x1b[0m";
}

// ─── Status / labels ───
const STATUS_ICONS: Record<AgentState, string> = {
  running: "🟢 running",
  idle: "🟡 idle",
  permission: "🔵 waiting",
  shell: "⚪ shell",
};

const AGENT_LABELS: Record<AgentType, string> = {
  claude: esc.cyan("claude"),
  codex: esc.green("codex"),
  coco: esc.blue("coco"),
  none: esc.dim("—"),
};

// ─── Current session detection ───
let currentSession = "";

function refreshCurrentSession() {
  currentSession = sh("tmux display-message -p '#{session_name}'");
}

// ─── Build session info ───
async function collectSessions(): Promise<SessionInfo[]> {
  const sessionList = sh("tmux list-sessions -F '#{session_name}'");
  if (!sessionList) return [];
  refreshCurrentSession();

  const sessions = sessionList.split("\n").filter(Boolean);
  refreshPsCache();

  return Promise.all(
    sessions.map(async (session) => {
      const panePid = sh(
        `tmux list-panes -t "${session}" -F '#{pane_pid}' | head -1`
      );
      if (!panePid) {
        return {
          name: session,
          agent: "none" as AgentType,
          state: "shell" as AgentState,
          cwd: "",
        };
      }

      const agentType = detectAgent(panePid);
      const cwd = sh(
        `tmux display-message -t "${session}" -p '#{pane_current_path}'`
      );
      let state: AgentState;
      let meta: ClaudeMetadata | null = null;

      if (agentType === "claude") {
        meta = await getClaudeMetadata(cwd);
        if (meta) {
          state = meta.state;
          if (paneHasPermissionPrompt(session)) {
            state = "permission";
            meta.state = state;
          }
        } else {
          state = "idle";
        }
      } else if (agentType !== "none") {
        state = detectPaneState(session);
      } else {
        state = "shell";
        meta = await getClaudeMetadata(cwd);
      }

      return {
        name: session,
        agent: agentType,
        state,
        meta: meta ?? undefined,
        cwd,
      };
    })
  );
}

// ─── Render a frame ───
function renderFrame(results: SessionInfo[]): string[] {
  const { cols } = getTermSize();
  const lines: string[] = [];

  rowSessionMap = new Map();

  lines.push("");

  const NAME_COL_START = 4;
  const nameColWidth = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const info of results) {
    const rowIndex = lines.length;
    const nameEnd = NAME_COL_START + info.name.length - 1;
    rowSessionMap.set(rowIndex, {
      name: info.name,
      colStart: NAME_COL_START,
      colEnd: nameEnd,
    });

    const isCurrent = info.name === currentSession;
    const marker = isCurrent ? "\x1b[31m●\x1b[0m" : esc.dim("○");
    const name = pad(
      isCurrent ? `\x1b[31m${info.name}\x1b[0m` : info.name,
      nameColWidth
    );
    const agent = pad(AGENT_LABELS[info.agent], 8);
    const status = STATUS_ICONS[info.state];

    let row = ` ${marker} ${name} ${agent} ${status}`;
    if (visibleLen(row) > cols) {
      row = truncate(row, cols);
    }

    lines.push(row);
  }

  lines.push("");
  lines.push("  " + "─".repeat(Math.min(cols - 4, 65)));
  lines.push(
    `  ${esc.dim(new Date().toLocaleTimeString("en-GB"))}  ${esc.dim("click session title to switch · q to quit")}`
  );

  return lines;
}

// ─── Parse SGR mouse events ───
interface MouseEvent {
  type: "press" | "release" | "motion";
  button: number;
  col: number;
  row: number;
}

function parseSGRMouse(data: string): MouseEvent | null {
  const match = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return null;

  const rawButton = parseInt(match[1], 10);
  const col = parseInt(match[2], 10);
  const row = parseInt(match[3], 10);
  const isRelease = match[4] === "m";

  const isMotion = (rawButton & 32) !== 0;
  const button = rawButton & 3;

  return {
    type: isRelease ? "release" : isMotion ? "motion" : "press",
    button,
    col,
    row,
  };
}

// ─── Handle mouse click → switch tmux session ───
function handleMouseClick(row: number, col: number) {
  const lineIndex = row - 1;
  const entry = rowSessionMap.get(lineIndex);
  if (!entry) return;

  if (col >= entry.colStart && col <= entry.colEnd) {
    sh(`tmux switch-client -t "${entry.name}" 2>/dev/null`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── TUI loop ───
async function runTUI() {
  write(
    esc.altScreenEnter + esc.cursorHide + esc.clearScreen + esc.mouseOn
  );

  let running = true;

  function cleanup() {
    running = false;
    write(esc.mouseOff + esc.cursorShow + esc.altScreenExit);
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      const str = data.toString();

      const mouse = parseSGRMouse(str);
      if (mouse) {
        if (mouse.type === "press" && mouse.button === 0) {
          handleMouseClick(mouse.row, mouse.col);
        }
        return;
      }

      if (str === "q" || str === "Q" || str === "\x03") {
        cleanup();
      }
    });
  }

  process.stdout.on("resize", () => {
    write(esc.clearScreen);
  });

  while (running) {
    try {
      const results = await collectSessions();
      const frameLines = renderFrame(results);

      write(esc.cursorHome);
      const { rows } = getTermSize();
      for (let i = 0; i < rows; i++) {
        write(esc.clearLine);
        if (i < frameLines.length) {
          write(frameLines[i]);
        }
        if (i < rows - 1) write("\n");
      }
    } catch {
      // Ignore transient errors during refresh
    }

    await sleep(REFRESH_INTERVAL_MS);
  }
}

// ─── Single-shot mode ───
async function runOnce() {
  const results = await collectSessions();
  const lines = renderFrame(results);
  console.log(lines.join("\n"));
}

// ─── Entry ───
export async function run() {
  const onceMode = process.argv.includes("--once");
  if (onceMode) {
    await runOnce();
  } else {
    await runTUI();
  }
}
