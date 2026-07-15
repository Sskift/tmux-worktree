import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ILinkProvider, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useDashboardBackend } from "./platform";
import type { DashboardBackend, PtyConnection, PtyControlStatus, TmuxStatusTheme } from "./platform";
import {
  THEME_CHANGED_EVENT,
  getCurrentPalette,
  type TerminalPalette,
} from "./themes";
import {
  REMOTE_RECONNECT_MAX_ATTEMPTS,
  TMUX_RECONNECT_DELAY_MS,
  remoteReconnectDelayMs,
  shouldReconnectTmuxAttach,
} from "./terminalLifecycle";
import {
  detectLinks,
  resolvePath,
  shouldActivateTerminalLink,
  type LinkMatch,
} from "./linkDetect";
import { isTerminalProtocolReply } from "./terminal/terminalResponses";
import { checkFileExists, openUrlInBrowser } from "./linkActions";
import {
  ControlledTerminalOutputFilter,
  isControlledTerminalTransportReport,
} from "./terminalInput";
import "@xterm/xterm/css/xterm.css";

type Props = {
  cmd: string;
  args: string[];
  cwd?: string;
  linkCwd?: string;
  active?: boolean;
  tmuxSession?: string;
  hostId?: string | null;
  controlSession?: string;
  controlHostId?: string | null;
  onAttachmentIdChange?: (id: string | null) => void;
  initialHistory?: string;
  onOpenFile?: (path: string, line?: number, col?: number, hostId?: string | null) => void;
};

type BufferPosition = { x: number; y: number };
type LogicalLine = {
  text: string;
  charToCell: BufferPosition[];
};
type ResolvedLink = LinkMatch & {
  range: { start: BufferPosition; end: BufferPosition };
};
type BufferLineSlice = {
  text: string;
  charToCell: BufferPosition[];
  isWrapped: boolean;
  lastCellX: number;
};

const MAX_WRAPPED_LINK_LINES = 20;
const LINK_BREAK_CHAR = /[\s'")\]}>]/;
const URL_AT_END_REGEX = /https?:\/\/[^\s'")\]}>]+$/;
const URL_SCHEME_REGEX = /https?:\/\//;

function hexColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function tmuxStatusThemeFromPalette(palette: TerminalPalette): TmuxStatusTheme {
  const background = hexColor(palette.background, "#0d0e10");
  const foreground = hexColor(palette.foreground, "#e6e6e8");
  const surface = hexColor(palette.black, background);
  const dim = hexColor(palette.brightBlack, foreground);
  const accent = hexColor(palette.blue, hexColor(palette.cyan, foreground));
  return {
    statusBg: surface,
    statusFg: foreground,
    activeBg: accent,
    activeFg: background,
    inactiveFg: dim,
    accent,
  };
}

function applyTmuxStatusTheme(
  dashboardBackend: DashboardBackend,
  tmuxSession: string | undefined,
  palette: TerminalPalette,
) {
  if (!tmuxSession) return;
  dashboardBackend.sessions
    .applyTheme(tmuxSession, tmuxStatusThemeFromPalette(palette))
    .catch(() => {});
}

function getBufferLineSlice(term: XTerm, lineIndex: number): BufferLineSlice | null {
  const line = term.buffer.active.getLine(lineIndex);
  if (!line) return null;

  let text = "";
  const charToCell: BufferPosition[] = [];
  for (let cell = 0; cell < term.cols; cell++) {
    const bufCell = line.getCell(cell);
    if (!bufCell) break;
    const ch = bufCell.getChars();
    if (ch === "") continue; // right half of wide char
    for (let i = 0; i < ch.length; i++) {
      charToCell.push({ x: cell + 1, y: lineIndex + 1 });
    }
    text += ch;
  }

  while (text.length > 0 && /\s/.test(text[text.length - 1])) {
    text = text.slice(0, -1);
    charToCell.pop();
  }

  return {
    text,
    charToCell,
    isWrapped: line.isWrapped,
    lastCellX: charToCell.length > 0 ? charToCell[charToCell.length - 1].x : 0,
  };
}

function hasHardWrapBoundary(prev: BufferLineSlice, next: BufferLineSlice): boolean {
  if (!prev.text || !next.text) return false;
  return !LINK_BREAK_CHAR.test(prev.text[prev.text.length - 1]) && !LINK_BREAK_CHAR.test(next.text[0]);
}

function canJoinAsHardWrappedUrl(prev: BufferLineSlice, next: BufferLineSlice, cols: number, combinedText: string): boolean {
  if (!hasHardWrapBoundary(prev, next)) return false;
  if (prev.lastCellX === cols) return true;
  if (URL_AT_END_REGEX.test(prev.text)) return true;
  return URL_SCHEME_REGEX.test(combinedText) && URL_AT_END_REGEX.test(combinedText);
}

function canJoinAsUrlFragment(prev: BufferLineSlice, next: BufferLineSlice): boolean {
  return hasHardWrapBoundary(prev, next);
}

function shouldJoinLines(prev: BufferLineSlice, next: BufferLineSlice, cols: number, combinedText: string, allowFragmentProbe: boolean): boolean {
  if (next.isWrapped) return true;
  // tmux/captured history can replay visual wraps as hard terminal rows, so xterm
  // does not mark them with isWrapped. Treat URL tokens split across adjacent
  // hard rows as one link even when the wrap width came from tmux or the CLI.
  return (
    canJoinAsHardWrappedUrl(prev, next, cols, combinedText) ||
    (allowFragmentProbe && canJoinAsUrlFragment(prev, next))
  );
}

function buildLogicalLine(term: XTerm, lineIndex: number): LogicalLine | null {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const current = getBufferLineSlice(term, lineIndex);
  if (!current) return null;

  const parts: BufferLineSlice[] = [current];
  let start = lineIndex;
  let backwardProbe = !URL_SCHEME_REGEX.test(current.text) ? 3 : 0;
  while (start > 0 && parts.length < MAX_WRAPPED_LINK_LINES) {
    const prev = getBufferLineSlice(term, start - 1);
    if (!prev) break;
    const combinedText = [prev, ...parts].map((part) => part.text).join("");
    const allowFragmentProbe = backwardProbe > 0;
    if (!shouldJoinLines(prev, parts[0], cols, combinedText, allowFragmentProbe)) break;
    parts.unshift(prev);
    if (!URL_SCHEME_REGEX.test(combinedText)) {
      backwardProbe--;
    } else {
      backwardProbe = 0;
    }
    start--;
  }

  let end = lineIndex;
  while (end + 1 < buffer.length && parts.length < MAX_WRAPPED_LINK_LINES) {
    const next = getBufferLineSlice(term, end + 1);
    if (!next) break;
    const combinedText = [...parts, next].map((part) => part.text).join("");
    const hasUrl = URL_SCHEME_REGEX.test(parts.map((part) => part.text).join(""));
    if (!shouldJoinLines(parts[parts.length - 1], next, cols, combinedText, hasUrl)) break;
    parts.push(next);
    end++;
  }

  const text = parts.map((part) => part.text).join("");
  const charToCell = parts.flatMap((part) => part.charToCell);

  return text ? { text, charToCell } : null;
}

function bufferOffset(pos: BufferPosition, cols: number): number {
  return pos.y * cols + pos.x;
}

function isPositionInRange(pos: BufferPosition, start: BufferPosition, end: BufferPosition, cols: number): boolean {
  const offset = bufferOffset(pos, cols);
  return offset >= bufferOffset(start, cols) && offset <= bufferOffset(end, cols);
}

function getBufferPositionFromMouse(term: XTerm, event: MouseEvent): BufferPosition | null {
  const viewportPos = getViewportPositionFromMouse(term, event);
  if (!viewportPos) return null;
  return {
    x: viewportPos.x,
    y: term.buffer.active.viewportY + viewportPos.y,
  };
}

function getViewportPositionFromMouse(term: XTerm, event: MouseEvent): BufferPosition | null {
  const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screen) return null;

  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) {
    return null;
  }

  const style = window.getComputedStyle(screen);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const width = rect.width - paddingLeft - paddingRight;
  const height = rect.height - paddingTop - paddingBottom;
  if (width <= 0 || height <= 0) return null;

  const cellWidth = width / term.cols;
  const cellHeight = height / term.rows;
  const relativeX = event.clientX - rect.left - paddingLeft;
  const relativeY = event.clientY - rect.top - paddingTop;
  const x = Math.min(Math.max(Math.ceil(relativeX / cellWidth), 1), term.cols);
  const viewportY = Math.min(Math.max(Math.ceil(relativeY / cellHeight), 1), term.rows);

  return {
    x,
    y: viewportY,
  };
}

function sgrMouseWheel(button: 64 | 65, pos: BufferPosition): string {
  return `\x1b[<${button};${pos.x};${pos.y}M`;
}

function getLinkAtPosition(term: XTerm, pos: BufferPosition): ResolvedLink | null {
  const logicalLine = buildLogicalLine(term, pos.y - 1);
  if (!logicalLine) return null;

  for (const match of detectLinks(logicalLine.text)) {
    const start = logicalLine.charToCell[match.startIndex];
    const end = logicalLine.charToCell[match.endIndex - 1];
    if (!start || !end) continue;
    if (isPositionInRange(pos, start, end, term.cols)) {
      return { ...match, range: { start, end } };
    }
  }
  return null;
}

function sameLink(a: ResolvedLink, b: ResolvedLink): boolean {
  return (
    a.text === b.text &&
    a.range.start.x === b.range.start.x &&
    a.range.start.y === b.range.start.y &&
    a.range.end.x === b.range.end.x &&
    a.range.end.y === b.range.end.y
  );
}

function createPtyId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canTerminalClaimFocus(host: HTMLElement | null): boolean {
  const focused = document.activeElement;
  return (
    focused === null ||
    focused === document.body ||
    focused === document.documentElement ||
    Boolean(host?.contains(focused))
  );
}

export function Terminal({
  cmd,
  args,
  cwd,
  linkCwd,
  active = true,
  tmuxSession,
  hostId,
  controlSession,
  controlHostId,
  onAttachmentIdChange,
  initialHistory,
  onOpenFile,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const ptyConnectionRef = useRef<PtyConnection | null>(null);
  const initialHistoryRef = useRef<string | undefined>(initialHistory);
  const activeRef = useRef(active);
  const linkCwdRef = useRef(linkCwd ?? cwd);
  const onOpenFileRef = useRef(onOpenFile);
  const onAttachmentIdChangeRef = useRef(onAttachmentIdChange);
  const remoteReconnectAttemptRef = useRef(0);
  const [reconnectSeq, setReconnectSeq] = useState(0);
  const [controlStatus, setControlStatus] = useState<PtyControlStatus | null>(null);
  linkCwdRef.current = linkCwd ?? cwd;
  onOpenFileRef.current = onOpenFile;
  onAttachmentIdChangeRef.current = onAttachmentIdChange;

  useEffect(() => {
    if (initialHistory !== undefined) {
      initialHistoryRef.current = initialHistory;
    }
  }, [initialHistory]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let ptyId: string | null = null;
    let ptyConnection: PtyConnection | null = null;
    let parsingPtyOutput = 0;
    const pendingTerminalReplies: string[] = [];
    const ptyAbort = new AbortController();
    let reconnectTimer: number | null = null;
    let reconnectStabilityTimer: number | null = null;
    let controlStatusTimer: number | null = null;
    let fitAnimationFrame: number | null = null;
    let fitFollowupFrame: number | null = null;
    let lastControlReadOnly: boolean | null = null;
    let lastControlState: PtyControlStatus["state"] | null = null;
    let remoteRetryAvailable = false;
    let cancelled = false;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: false,
      theme: getCurrentPalette(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const controlledOutput = controlSession ? new ControlledTerminalOutputFilter() : null;
    term.loadAddon(fit);
    term.open(host);

    const isActionableLink = (link: Pick<LinkMatch, "kind">) =>
      link.kind === "url" || (!!linkCwdRef.current && !!onOpenFileRef.current);

    const openFileLink = (link: Extract<LinkMatch, { kind: "file" }>) => {
      const fileCwd = linkCwdRef.current;
      const openFile = onOpenFileRef.current;
      if (!fileCwd || !openFile) return;
      const resolved = resolvePath(link.path, fileCwd);
      checkFileExists(dashboardBackend, resolved, hostId).then((exists) => {
        if (exists) openFile(resolved, link.line, link.col, hostId);
      });
    };

    // Remote tmux owns ordinary mouse events, so web links also support direct
    // click there. Cmd/Ctrl+click remains available for every terminal link.
    const linkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const logicalLine = buildLogicalLine(term, bufferLineNumber - 1);
        if (!logicalLine) { callback(undefined); return; }

        const detected = detectLinks(logicalLine.text);
        if (detected.length === 0) { callback(undefined); return; }

        const links: ILink[] = [];
        for (const match of detected) {
          if (!isActionableLink(match)) continue;
          const start = logicalLine.charToCell[match.startIndex];
          const end = logicalLine.charToCell[match.endIndex - 1];
          if (!start || !end) continue;
          if (bufferLineNumber < start.y || bufferLineNumber > end.y) continue;
          links.push({
            range: { start, end },
            text: match.text,
            decorations: { underline: true, pointerCursor: true },
            activate(event: MouseEvent, _text: string) {
              if (!shouldActivateTerminalLink(event, match, !!hostId)) return;
              if (match.kind === "url") {
                openUrlInBrowser(dashboardBackend, match.url).catch(() => {});
              } else if (match.kind === "file") {
                openFileLink(match);
              }
            },
          });
        }
        if (links.length === 0) { callback(undefined); return; }
        callback(links);
      },
    };
    term.registerLinkProvider(linkProvider);

    const writePtyOutput = (data: string) => {
      parsingPtyOutput += 1;
      term.write(data, () => {
        parsingPtyOutput = Math.max(0, parsingPtyOutput - 1);
      });
    };

    const dataSubscription = term.onData((data) => {
      if (controlSession && parsingPtyOutput > 0 && isTerminalProtocolReply(data)) {
        if (ptyConnection?.active) {
          ptyConnection.writeTerminalReply(data).catch(() => {});
        } else {
          pendingTerminalReplies.push(data);
        }
        return;
      }
      if (controlSession && isControlledTerminalTransportReport(data)) return;
      if (ptyId) {
        ptyConnection?.write(data).catch(() => {
          ptyConnection?.controlStatus().then(setControlStatus).catch(() => {});
        });
      }
    });

    let pendingLink: ResolvedLink | null = null;
    const consumeLinkMouseEvent = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      term.focus();
    };
    const openResolvedLink = (link: ResolvedLink) => {
      if (link.kind === "url") {
        openUrlInBrowser(dashboardBackend, link.url).catch(() => {});
      } else if (link.kind === "file") {
        openFileLink(link);
      }
    };
    const onLinkMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        pendingLink = null;
        return;
      }
      const pos = getBufferPositionFromMouse(term, event);
      const link = pos ? getLinkAtPosition(term, pos) : null;
      if (!link || !isActionableLink(link) || !shouldActivateTerminalLink(event, link, !!hostId)) {
        pendingLink = null;
        return;
      }
      pendingLink = link;
      consumeLinkMouseEvent(event);
    };
    const onLinkMouseUp = (event: MouseEvent) => {
      const pending = pendingLink;
      pendingLink = null;
      if (event.button !== 0 || !pending || !shouldActivateTerminalLink(event, pending, !!hostId)) return;

      const pos = getBufferPositionFromMouse(term, event);
      const link = pos ? getLinkAtPosition(term, pos) : null;
      consumeLinkMouseEvent(event);
      if (link && sameLink(pending, link)) {
        openResolvedLink(link);
      }
    };
    host.addEventListener("mousedown", onLinkMouseDown, true);
    host.addEventListener("mouseup", onLinkMouseUp, true);

    const routesWheelThroughPty = Boolean(hostId || controlSession);
    let wheelAccum = 0;
    const handlePtyWheel = (event: WheelEvent): boolean => {
      if (!routesWheelThroughPty || !ptyId || event.deltaY === 0) return true;
      const pos = controlSession ? null : getViewportPositionFromMouse(term, event);
      if (!controlSession && !pos) return true;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const cellHeight = Math.max(
        1,
        (term.options.fontSize ?? 13) * (term.options.lineHeight ?? 1.2),
      );
      const deltaLines = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY / cellHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * Math.max(1, term.rows)
          : event.deltaY;
      wheelAccum += deltaLines;

      const steps = Math.min(12, Math.floor(Math.abs(wheelAccum)));
      if (steps <= 0) return false;
      const direction = wheelAccum > 0 ? "down" : "up";
      wheelAccum -= Math.sign(wheelAccum) * steps;

      if (controlSession) {
        ptyConnection?.scroll(direction, steps).catch(() => {
          ptyConnection?.controlStatus().then(setControlStatus).catch(() => {});
        });
      } else {
        const button: 64 | 65 = direction === "down" ? 65 : 64;
        let data = "";
        for (let i = 0; i < steps; i++) {
          data += sgrMouseWheel(button, pos!);
        }
        ptyConnection?.write(data).catch(() => {});
      }
      return false;
    };
    if (routesWheelThroughPty) {
      term.attachCustomWheelEventHandler(handlePtyWheel);
    }

    termRef.current = term;
    fitRef.current = fit;

    let latestSize = { cols: term.cols, rows: term.rows };
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      latestSize = { cols, rows };
      if (ptyId) ptyConnection?.resize(cols, rows).catch(() => {});
    });

    const writePty = (data: string) => {
      if (ptyId) ptyConnection?.write(data).catch(() => {});
    };

    const copyTmuxOrInterrupt = () => {
      if (!tmuxSession) return true;
      if (term.hasSelection()) return true;
      dashboardBackend.sessions.copySelection(tmuxSession).then((copied) => {
        if (!copied) writePty("\x03");
      }).catch(() => writePty("\x03"));
      return false;
    };

    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.key === "Enter" &&
        hostId &&
        remoteRetryAvailable
      ) {
        remoteRetryAvailable = false;
        remoteReconnectAttemptRef.current = 0;
        setReconnectSeq((value) => value + 1);
        return false;
      }
      if (e.type === "keydown" && e.key === "Escape" && tmuxSession) {
        // Let ESC reach the PTY so TUIs (vim/less/fzf) receive it, and in
        // parallel ask tmux to exit copy-mode *only if* the pane is actually
        // in a mode (scrolled-up history). When not in copy-mode this is a
        // no-op, so normal apps keep their ESC. Do not swallow the key.
        dashboardBackend.sessions.cancelCopyModeIfActive(tmuxSession).catch(() => {});
        return true;
      }
      if (e.type === "keydown" && e.metaKey && e.key.toLowerCase() === "c") {
        return copyTmuxOrInterrupt();
      }
      return true;
    });

    let blurHandler: (() => void) | null = null;
    if (tmuxSession) {
      blurHandler = () => {
        dashboardBackend.sessions.cancelCopyMode(tmuxSession).catch(() => {});
      };
      host.addEventListener("focusout", blurHandler);
    }

    const safeFit = () => {
      const bounds = host.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      try {
        fit.fit();
        return true;
      } catch {
        // ignore — host not yet sized
        return false;
      }
    };

    const scheduleStableFit = () => {
      if (fitAnimationFrame !== null) cancelAnimationFrame(fitAnimationFrame);
      if (fitFollowupFrame !== null) cancelAnimationFrame(fitFollowupFrame);
      fitAnimationFrame = requestAnimationFrame(() => {
        fitAnimationFrame = null;
        safeFit();
        // React can reveal the selected slot and settle the workspace grid in
        // separate layout passes. Refit on the following frame so a managed
        // tmux attachment never opens permanently at xterm's 10x4 fallback.
        fitFollowupFrame = requestAnimationFrame(() => {
          fitFollowupFrame = null;
          safeFit();
        });
      });
    };

    const fitBeforeOpen = async () => {
      if (!activeRef.current) return;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          safeFit();
          resolve();
        });
      });
      if (cancelled || !activeRef.current) return;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          safeFit();
          resolve();
        });
      });
    };

    scheduleStableFit();
    if (activeRef.current && canTerminalClaimFocus(host)) term.focus();

    const onThemeChange = (e: Event) => {
      const detail = (e as CustomEvent<TerminalPalette>).detail;
      if (!detail) return;
      if (!activeRef.current) return;
      term.options.theme = detail;
      applyTmuxStatusTheme(dashboardBackend, tmuxSession, detail);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);

    const start = async () => {
      try {
        // Fit before replaying captured output as well as before opening the
        // managed PTY. Otherwise xterm can hard-wrap the snapshot at its
        // fallback geometry and tmux briefly attaches at that stale size.
        await fitBeforeOpen();
        if (cancelled) return;

        if (tmuxSession) {
          const cachedHistory = initialHistoryRef.current;
          const history = cachedHistory !== undefined
            ? cachedHistory
            : await dashboardBackend.sessions.captureHistory(tmuxSession).catch(() => "");
          if (history) {
            const output = history + "\r\n";
            term.write(controlledOutput?.push(output) ?? output);
          }
        }

        const { cols, rows } = term;
        const id = createPtyId();

        ptyConnection = await dashboardBackend.pty.connect(
          {
            id,
            cmd,
            args,
            cwd,
            cols,
            rows,
            controlSession,
            controlHostId: controlHostId ?? undefined,
          },
          {
            onData: (event) => {
              if (cancelled) return;
              const output = controlledOutput?.push(event.data) ?? event.data;
              if (output) writePtyOutput(output);
              if (
                hostId &&
                remoteReconnectAttemptRef.current > 0 &&
                reconnectStabilityTimer === null
              ) {
                // SSH failures can emit stderr before exiting. Only reset the
                // retry budget if the PTY remains alive after producing data.
                reconnectStabilityTimer = window.setTimeout(() => {
                  reconnectStabilityTimer = null;
                  if (!cancelled && ptyId === id) {
                    remoteReconnectAttemptRef.current = 0;
                  }
                }, 2_000);
              }
            },
            onExit: async (event) => {
              if (event.id !== id) return;
              const pendingOutput = controlledOutput?.flush();
              if (pendingOutput) writePtyOutput(pendingOutput);
              ptyId = null;
              onAttachmentIdChangeRef.current?.(null);
              if (reconnectStabilityTimer !== null) {
                window.clearTimeout(reconnectStabilityTimer);
                reconnectStabilityTimer = null;
              }
              let sessionStillExists = false;
              let sessionProbeFailed = false;
              if (tmuxSession) {
                try {
                  sessionStillExists = await dashboardBackend.sessions.exists(tmuxSession);
                } catch {
                  sessionProbeFailed = true;
                }
              }
              if (cancelled) return;
              const remoteReconnectAttempt = hostId
                ? remoteReconnectAttemptRef.current
                : 0;
              if (
                shouldReconnectTmuxAttach({
                  cancelled,
                  hasTmuxSession: !!tmuxSession,
                  sessionStillExists,
                  sessionProbeFailed,
                  isRemote: !!hostId,
                  remoteReconnectAttempt,
                })
              ) {
                const reconnectDelay = hostId
                  ? remoteReconnectDelayMs(remoteReconnectAttempt)
                  : TMUX_RECONNECT_DELAY_MS;
                if (hostId) {
                  remoteReconnectAttemptRef.current = remoteReconnectAttempt + 1;
                }
                const msg = hostId
                  ? `\r\n\x1b[2m[ssh disconnected, reconnecting in ${Math.ceil(reconnectDelay / 1000)}s]\x1b[0m\r\n`
                  : "\r\n\x1b[2m[tmux detached, reconnecting]\x1b[0m\r\n";
                term.write(msg);
                reconnectTimer = window.setTimeout(() => {
                  if (!cancelled) setReconnectSeq((value) => value + 1);
                }, reconnectDelay);
                return;
              }
              if (
                hostId &&
                (sessionStillExists || sessionProbeFailed) &&
                remoteReconnectAttempt >= REMOTE_RECONNECT_MAX_ATTEMPTS
              ) {
                remoteRetryAvailable = true;
                term.write("\r\n\x1b[33m[remote terminal unavailable; press Enter to retry]\x1b[0m\r\n");
                return;
              }
              term.write(`\r\n\x1b[2m[exit ${event.code}]\x1b[0m\r\n`);
            },
          },
          ptyAbort.signal,
        );

        if (cancelled) {
          await ptyConnection.close().catch(() => {});
          return;
        }
        ptyConnectionRef.current = ptyConnection;
        for (const reply of pendingTerminalReplies.splice(0)) {
          await ptyConnection.writeTerminalReply(reply).catch(() => {});
        }
        ptyId = ptyConnection.active ? id : null;
        onAttachmentIdChangeRef.current?.(ptyId);
        if (ptyId && controlSession && !activeRef.current) {
          // TerminalDeck intentionally keeps inactive PTYs mounted for output
          // continuity. Mounted observation must not retain input ownership.
          const released = await ptyConnection.releaseControl().catch(() => null);
          if (released) {
            setControlStatus(released);
            lastControlReadOnly = released.readOnly;
            lastControlState = released.state;
          }
        }
        if (ptyId && controlSession) {
          // Controlled tmux attachments use ignore-size and therefore do not
          // resize the shared window from their read-only PTY. Seed the
          // canonical writer with the latest fitted dimensions so a layout
          // change during open cannot leave tmux at a stale size.
          void ptyConnection.resize(latestSize.cols, latestSize.rows).catch(() => {});
        }
        if (ptyId && controlSession) {
          const pollControlStatus = async () => {
            if (cancelled || !ptyConnection?.active) return;
            if (!activeRef.current) {
              const released = await ptyConnection.releaseControl().catch(() => null);
              if (released) {
                setControlStatus(released);
                lastControlReadOnly = released.readOnly;
                lastControlState = released.state;
              }
              controlStatusTimer = window.setTimeout(pollControlStatus, 1_000);
              return;
            }
            try {
              const nextStatus = await ptyConnection.controlStatus();
              setControlStatus(nextStatus);
              if (lastControlReadOnly === true && !nextStatus.readOnly) {
                void ptyConnection.resize(term.cols, term.rows).catch(() => {});
              }
              lastControlReadOnly = nextStatus.readOnly;
              lastControlState = nextStatus.state;
            } catch {}
            if (!cancelled && ptyConnection?.active) {
              // Only a HELD lease owned by this PTY uses the 20s renewal
              // cadence. FREE is writable-on-demand but still polls quickly so
              // a new Feishu binding becomes visible before the next input.
              const nextPollMs = lastControlState === "HELD" && lastControlReadOnly === false
                ? 20_000
                : 1_000;
              controlStatusTimer = window.setTimeout(pollControlStatus, nextPollMs);
            }
          };
          void pollControlStatus();
        }
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === "AbortError")) return;
        term.write(`\r\n\x1b[31m[pty error] ${String(e)}\x1b[0m\r\n`);
        if (hostId) {
          remoteRetryAvailable = true;
          term.write("\x1b[33m[press Enter to retry]\x1b[0m\r\n");
        }
      }
    };

    start();

    const ro = new ResizeObserver(() => scheduleStableFit());
    ro.observe(host);
    void document.fonts?.ready.then(() => {
      if (!cancelled) scheduleStableFit();
    });

    return () => {
      cancelled = true;
      ptyAbort.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (reconnectStabilityTimer !== null) window.clearTimeout(reconnectStabilityTimer);
      if (controlStatusTimer !== null) window.clearTimeout(controlStatusTimer);
      if (fitAnimationFrame !== null) cancelAnimationFrame(fitAnimationFrame);
      if (fitFollowupFrame !== null) cancelAnimationFrame(fitFollowupFrame);
      ro.disconnect();
      host.removeEventListener("mousedown", onLinkMouseDown, true);
      host.removeEventListener("mouseup", onLinkMouseUp, true);
      if (blurHandler) host.removeEventListener("focusout", blurHandler);
      window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      resizeSubscription.dispose();
      dataSubscription.dispose();
      void ptyConnection?.close();
      if (ptyConnectionRef.current === ptyConnection) ptyConnectionRef.current = null;
      ptyId = null;
      onAttachmentIdChangeRef.current?.(null);
      setControlStatus(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cmd, args.join("\x1f"), cwd, tmuxSession, hostId, controlSession, controlHostId, reconnectSeq]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      const connection = ptyConnectionRef.current;
      if (controlSession && connection?.active) {
        void connection.releaseControl().then(setControlStatus).catch(() => {});
      }
      const ta = termRef.current?.textarea;
      if (ta) {
        ta.blur();
        ta.disabled = true;
      }
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const connection = ptyConnectionRef.current;
    if (controlSession && connection?.active) {
      void connection.controlStatus().then(setControlStatus).catch(() => {});
    }
    if (term.textarea) term.textarea.disabled = false;
    const palette = getCurrentPalette();
    term.options.theme = palette;
    applyTmuxStatusTheme(dashboardBackend, tmuxSession, palette);
    let followupFrame: number | null = null;
    const animationFrame = requestAnimationFrame(() => {
      followupFrame = requestAnimationFrame(() => {
        if (!activeRef.current || termRef.current !== term || fitRef.current !== fit) return;
        try {
          fit.fit();
        } catch {}
        if (canTerminalClaimFocus(hostRef.current)) term.focus();
      });
    });
    return () => {
      cancelAnimationFrame(animationFrame);
      if (followupFrame !== null) cancelAnimationFrame(followupFrame);
    };
  }, [active, tmuxSession, controlSession]);

  const requestTakeover = () => {
    const connection = ptyConnectionRef.current;
    if (!connection) return;
    connection.requestTakeover().then((nextStatus) => {
      setControlStatus(nextStatus);
      const term = termRef.current;
      if (term && !nextStatus.readOnly) {
        void connection.resize(term.cols, term.rows).catch(() => {});
      }
    }).catch(() => {});
  };

  const requestRecovery = async () => {
    const connection = ptyConnectionRef.current;
    if (!connection) return;
    const confirmed = await dashboardBackend.dialog.confirm({
      title: "Recover local terminal input?",
      message:
        "The previous input lease expired or its controller restarted. Recovery advances the input fence and treats any uncertain in-flight operation as already attempted. Continue only if no other controller is still writing to this terminal.",
    });
    if (!confirmed || !connection.active) return;
    connection.requestRecovery().then((nextStatus) => {
      setControlStatus(nextStatus);
      const term = termRef.current;
      if (term && !nextStatus.readOnly) {
        void connection.resize(term.cols, term.rows).catch(() => {});
      }
    }).catch(() => {
      connection.controlStatus().then(setControlStatus).catch(() => {});
    });
  };

  return (
    <div className="term-shell">
      <div ref={hostRef} className="term" />
      {controlStatus?.controlled && controlStatus.readOnly && (
        <div className="term-control-banner" role="status" data-terminal-control-state={controlStatus.state}>
          <span>
            {controlStatus.state === "DRAINING"
              ? `Waiting for ${controlStatus.ownerKind ?? "the current owner"} to finish local handoff…`
              : controlStatus.state === "RECOVERY_REQUIRED"
                ? "Read-only · terminal input continuity needs local recovery"
                : `Read-only · input owned by ${controlStatus.ownerKind ?? "another controller"}`}
          </span>
          {controlStatus.canTakeOver && (
            <button type="button" onClick={requestTakeover}>Take over locally</button>
          )}
          {controlStatus.canRecover && (
            <button type="button" onClick={() => void requestRecovery()}>Recover local input</button>
          )}
        </div>
      )}
    </div>
  );
}
