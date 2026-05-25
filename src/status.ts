import { execSync } from "node:child_process";

// ─── Config ───
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
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
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
interface SessionInfo {
  name: string;
  isCurrent: boolean;
}

// ─── Row-to-session mapping (for mouse clicks) ───
let rowSessionMap: Map<
  number,
  { name: string; colStart: number; colEnd: number; closeCol: number }
> = new Map();

// ─── Collect sessions ───
function collectSessions(): SessionInfo[] {
  const sessionList = sh("tmux list-sessions -F '#{session_name}'");
  if (!sessionList) return [];
  const currentSession = sh("tmux display-message -p '#{session_name}'");
  return sessionList
    .split("\n")
    .filter(Boolean)
    .map((name) => ({ name, isCurrent: name === currentSession }));
}

// ─── Project colors ───
const PROJECT_COLORS = [
  "\x1b[38;5;168m", // rose
  "\x1b[38;5;114m", // green
  "\x1b[38;5;215m", // orange
  "\x1b[38;5;75m",  // sky blue
  "\x1b[38;5;183m", // lavender
  "\x1b[38;5;44m",  // teal
  "\x1b[38;5;222m", // gold
  "\x1b[38;5;210m", // salmon
  "\x1b[38;5;157m", // mint
  "\x1b[38;5;147m", // periwinkle
  "\x1b[38;5;203m", // coral
  "\x1b[38;5;120m", // lime
];
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// ─── Display width (CJK chars = 2 columns) ───
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility, Fullwidth forms,
    // Hangul Syllables, CJK Radicals, Kangxi Radicals, Enclosed CJK, CJK Symbols
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK Radicals, Kangxi, CJK Symbols
      (cp >= 0x3040 && cp <= 0x33bf) ||  // Hiragana, Katakana, CJK Compatibility
      (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Extension A
      (cp >= 0x4e00 && cp <= 0xa4cf) ||  // CJK Unified, Yi
      (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) ||  // CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) ||  // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||  // Fullwidth Signs
      (cp >= 0x20000 && cp <= 0x2fa1f)   // CJK Extension B+ and Compatibility Supplement
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function getProjectName(sessionName: string): string {
  const idx = sessionName.indexOf("-");
  return idx > 0 ? sessionName.substring(0, idx) : sessionName;
}

function buildProjectColorMap(sessions: SessionInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  let colorIdx = 0;
  for (const s of sessions) {
    const project = getProjectName(s.name);
    if (!map.has(project)) {
      map.set(project, PROJECT_COLORS[colorIdx % PROJECT_COLORS.length]);
      colorIdx++;
    }
  }
  return map;
}

// ─── Render ───
function renderFrame(sessions: SessionInfo[]): string[] {
  const { cols } = getTermSize();
  const lines: string[] = [];
  rowSessionMap = new Map();
  const colorMap = buildProjectColorMap(sessions);

  lines.push("");

  // Calculate max session name display width for aligned "x" column
  const maxNameWidth = sessions.reduce((max, s) => Math.max(max, displayWidth(s.name)), 0);

  for (const info of sessions) {
    const rowIndex = lines.length;

    const project = getProjectName(info.name);
    const color = colorMap.get(project) || "\x1b[37m";

    const marker = info.isCurrent ? `${color}${BOLD}●${RESET}` : `${color}○${RESET}`;

    const dashIdx = info.name.indexOf("-");
    let name: string;
    if (dashIdx > 0) {
      const projectPart = info.name.substring(0, dashIdx);
      const titlePart = info.name.substring(dashIdx);
      if (info.isCurrent) {
        name = `${color}${BOLD}${projectPart}${RESET}${titlePart}`;
      } else {
        name = `${color}${projectPart}${RESET}${esc.dim(titlePart)}`;
      }
    } else {
      name = info.isCurrent ? `${color}${BOLD}${info.name}${RESET}` : `${color}${info.name}${RESET}`;
    }

    // Pad name to align the "x" column (use display width for CJK support)
    const padding = maxNameWidth - displayWidth(info.name);
    let row = ` ${marker} ${name}${" ".repeat(padding)}  ${esc.dim("x")}`;
    const stripped = row.replace(/\x1b\[[0-9;]*m/g, "");

    // Derive click columns using display width (1-based for SGR mouse)
    // Layout: " ● name<padding>  x" → name starts at display col 4
    const nameDisplayWidth = displayWidth(info.name);
    const colStart = 4; // 1-based: space(1) + marker(1) + space(1) + name at 4
    const colEnd = colStart + nameDisplayWidth - 1;
    const closeCol = colStart + maxNameWidth + 2; // after padding + 2-space gap
    rowSessionMap.set(rowIndex, { name: info.name, colStart, colEnd, closeCol });

    if (stripped.length > cols) {
      row = stripped.slice(0, cols - 1) + "…";
    }

    lines.push(row);
  }

  lines.push("");
  lines.push(esc.dim("─".repeat(Math.min(cols - 2, 20))));
  lines.push(esc.dim("q quit"));

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

// ─── Handle mouse click → switch or close tmux session ───
function handleMouseClick(row: number, col: number) {
  const lineIndex = row - 1;
  const entry = rowSessionMap.get(lineIndex);
  if (!entry) return;

  if (col === entry.closeCol) {
    // Close session: kill it and switch to next or first
    const sessions = collectSessions();
    const idx = sessions.findIndex((s) => s.name === entry.name);
    const remaining = sessions.filter((s) => s.name !== entry.name);
    if (remaining.length > 0) {
      // Pick the next session, or wrap to first
      const nextIdx = idx >= remaining.length ? 0 : idx;
      sh(`tmux switch-client -t "${remaining[nextIdx].name}" 2>/dev/null`);
    }
    sh(`tmux kill-session -t "${entry.name}" 2>/dev/null`);
    return;
  }

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
      const sessions = collectSessions();
      const frameLines = renderFrame(sessions);

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
function runOnce() {
  const sessions = collectSessions();
  const lines = renderFrame(sessions);
  console.log(lines.join("\n"));
}

// ─── Entry ───
export async function run() {
  const onceMode = process.argv.includes("--once");
  if (onceMode) {
    runOnce();
  } else {
    await runTUI();
  }
}
