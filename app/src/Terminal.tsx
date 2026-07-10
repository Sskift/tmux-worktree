import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ILinkProvider, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  THEME_CHANGED_EVENT,
  getCurrentPalette,
  type TerminalPalette,
} from "./themes";
import {
  TMUX_RECONNECT_DELAY_MS,
  shouldReconnectTmuxAttach,
} from "./terminalLifecycle";
import {
  detectLinks,
  resolvePath,
  checkFileExists,
  openUrlInBrowser,
  shouldActivateTerminalLink,
  type LinkMatch,
} from "./linkDetect";
import "@xterm/xterm/css/xterm.css";

type Props = {
  cmd: string;
  args: string[];
  cwd?: string;
  linkCwd?: string;
  active?: boolean;
  tmuxSession?: string;
  hostId?: string | null;
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

type TmuxStatusTheme = {
  statusBg: string;
  statusFg: string;
  activeBg: string;
  activeFg: string;
  inactiveFg: string;
  accent: string;
};

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

function applyTmuxStatusTheme(tmuxSession: string | undefined, palette: TerminalPalette) {
  if (!tmuxSession) return;
  invoke("apply_tmux_theme", {
    name: tmuxSession,
    theme: tmuxStatusThemeFromPalette(palette),
  }).catch(() => {});
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

export function Terminal({ cmd, args, cwd, linkCwd, active = true, tmuxSession, hostId, initialHistory, onOpenFile }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const initialHistoryRef = useRef<string | undefined>(initialHistory);
  const activeRef = useRef(active);
  const linkCwdRef = useRef(linkCwd ?? cwd);
  const onOpenFileRef = useRef(onOpenFile);
  const [reconnectSeq, setReconnectSeq] = useState(0);
  linkCwdRef.current = linkCwd ?? cwd;
  onOpenFileRef.current = onOpenFile;

  useEffect(() => {
    if (initialHistory !== undefined) {
      initialHistoryRef.current = initialHistory;
    }
  }, [initialHistory]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let ptyId: string | null = null;
    let unlistenChunk: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let reconnectTimer: number | null = null;
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
    term.loadAddon(fit);
    term.open(host);

    const isActionableLink = (link: Pick<LinkMatch, "kind">) =>
      link.kind === "url" || (!!linkCwdRef.current && !!onOpenFileRef.current);

    const openFileLink = (link: Extract<LinkMatch, { kind: "file" }>) => {
      const fileCwd = linkCwdRef.current;
      const openFile = onOpenFileRef.current;
      if (!fileCwd || !openFile) return;
      const resolved = resolvePath(link.path, fileCwd);
      checkFileExists(resolved, hostId).then((exists) => {
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
                openUrlInBrowser(match.url).catch(() => {});
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

    let pendingLink: ResolvedLink | null = null;
    const consumeLinkMouseEvent = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      term.focus();
    };
    const openResolvedLink = (link: ResolvedLink) => {
      if (link.kind === "url") {
        openUrlInBrowser(link.url).catch(() => {});
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

    let wheelAccum = 0;
    const handleRemoteWheel = (event: WheelEvent): boolean => {
      if (!hostId || !ptyId || event.deltaY === 0) return true;
      const pos = getViewportPositionFromMouse(term, event);
      if (!pos) return true;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const deltaLines = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY / 35
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * Math.max(1, term.rows)
          : event.deltaY;
      wheelAccum += deltaLines;

      const steps = Math.min(12, Math.floor(Math.abs(wheelAccum)));
      if (steps <= 0) return false;
      const button: 64 | 65 = wheelAccum > 0 ? 65 : 64;
      wheelAccum -= Math.sign(wheelAccum) * steps;

      let data = "";
      for (let i = 0; i < steps; i++) {
        data += sgrMouseWheel(button, pos);
      }
      invoke("pty_write", { id: ptyId, data }).catch(() => {});
      return false;
    };
    const onRemoteWheel = (event: WheelEvent) => {
      handleRemoteWheel(event);
    };
    if (hostId) {
      term.attachCustomWheelEventHandler(handleRemoteWheel);
      host.addEventListener("wheel", onRemoteWheel, { capture: true, passive: false });
    }

    termRef.current = term;
    fitRef.current = fit;

    const writePty = (data: string) => {
      if (ptyId) invoke("pty_write", { id: ptyId, data }).catch(() => {});
    };

    const copyTmuxOrInterrupt = () => {
      if (!tmuxSession) return true;
      if (term.hasSelection()) return true;
      invoke<boolean>("copy_tmux_selection", { name: tmuxSession }).then((copied) => {
        if (!copied) writePty("\x03");
      }).catch(() => writePty("\x03"));
      return false;
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape" && tmuxSession) {
        // Let ESC reach the PTY so TUIs (vim/less/fzf) receive it, and in
        // parallel ask tmux to exit copy-mode *only if* the pane is actually
        // in a mode (scrolled-up history). When not in copy-mode this is a
        // no-op, so normal apps keep their ESC. Do not swallow the key.
        invoke("copy_mode_cancel_if_active", { name: tmuxSession }).catch(() => {});
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
        invoke("cancel_copy_mode", { name: tmuxSession }).catch(() => {});
      };
      host.addEventListener("focusout", blurHandler);
    }

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // ignore — host not yet sized
      }
    };

    safeFit();
    term.focus();

    const onThemeChange = (e: Event) => {
      const detail = (e as CustomEvent<TerminalPalette>).detail;
      if (!detail) return;
      if (!activeRef.current) return;
      term.options.theme = detail;
      applyTmuxStatusTheme(tmuxSession, detail);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);

    const start = async () => {
      try {
        if (tmuxSession) {
          const cachedHistory = initialHistoryRef.current;
          const history = cachedHistory !== undefined
            ? cachedHistory
            : await invoke<string>("capture_pane_history", { name: tmuxSession }).catch(() => "");
          if (history) {
            term.write(history + "\r\n");
          }
        }

        const { cols, rows } = term;
        const id = createPtyId();

        unlistenChunk = await listen<{ id: string; data: string }>(
          `pty:${id}`,
          (e) => term.write(e.payload.data),
        );
        unlistenExit = await listen<{ id: string; code: number }>(
          `pty-exit:${id}`,
          async (e) => {
            if (e.payload.id !== id) return;
            ptyId = null;
            const sessionStillExists = tmuxSession
              ? await invoke<boolean>("tmux_session_exists", {
                  name: tmuxSession,
                }).catch(() => false)
              : false;
            if (
              shouldReconnectTmuxAttach({
                cancelled,
                hasTmuxSession: !!tmuxSession,
                sessionStillExists,
                isRemote: !!hostId,
              })
            ) {
              const reconnectDelay = hostId ? 2000 : TMUX_RECONNECT_DELAY_MS;
              const msg = hostId
                ? "\r\n\x1b[2m[ssh disconnected, reconnecting]\x1b[0m\r\n"
                : "\r\n\x1b[2m[tmux detached, reconnecting]\x1b[0m\r\n";
              term.write(msg);
              reconnectTimer = window.setTimeout(() => {
                if (!cancelled) setReconnectSeq((value) => value + 1);
              }, reconnectDelay);
              return;
            }
            term.write(`\r\n\x1b[2m[exit ${e.payload.code}]\x1b[0m\r\n`);
          },
        );

        const openedId = await invoke<string>("pty_open", {
          args: { id, cmd, args, cwd, cols, rows },
        });
        if (openedId !== id) {
          throw new Error(`pty id mismatch: expected ${id}, got ${openedId}`);
        }
        if (cancelled) {
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;

        term.onData((data) => {
          if (ptyId) invoke("pty_write", { id: ptyId, data }).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          if (ptyId)
            invoke("pty_resize", { id: ptyId, cols, rows }).catch(() => {});
        });
      } catch (e) {
        unlistenChunk?.();
        unlistenChunk = null;
        unlistenExit?.();
        unlistenExit = null;
        term.write(`\r\n\x1b[31m[pty error] ${String(e)}\x1b[0m\r\n`);
      }
    };

    start();

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(host);

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ro.disconnect();
      host.removeEventListener("mousedown", onLinkMouseDown, true);
      host.removeEventListener("mouseup", onLinkMouseUp, true);
      if (hostId) host.removeEventListener("wheel", onRemoteWheel, true);
      if (blurHandler) host.removeEventListener("focusout", blurHandler);
      window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      unlistenChunk?.();
      unlistenExit?.();
      if (ptyId) invoke("pty_kill", { id: ptyId }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cmd, args.join("\x1f"), cwd, tmuxSession, hostId, reconnectSeq]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
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
    if (term.textarea) term.textarea.disabled = false;
    const palette = getCurrentPalette();
    term.options.theme = palette;
    applyTmuxStatusTheme(tmuxSession, palette);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {}
      term.focus();
    });
  }, [active, tmuxSession]);

  return <div ref={hostRef} className="term" />;
}
