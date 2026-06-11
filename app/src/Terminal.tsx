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
import { detectLinks, resolvePath, checkFileExists, openUrlInBrowser, type LinkMatch } from "./linkDetect";
import "@xterm/xterm/css/xterm.css";

type Props = {
  cmd: string;
  args: string[];
  cwd?: string;
  active?: boolean;
  tmuxSession?: string;
  onOpenFile?: (path: string, line?: number, col?: number) => void;
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
    y: term.buffer.active.viewportY + viewportY,
  };
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

export function Terminal({ cmd, args, cwd, active = true, tmuxSession, onOpenFile }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [reconnectSeq, setReconnectSeq] = useState(0);

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

    // Register link provider for CMD+click support
    const linkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const logicalLine = buildLogicalLine(term, bufferLineNumber - 1);
        if (!logicalLine) { callback(undefined); return; }

        const detected = detectLinks(logicalLine.text);
        if (detected.length === 0) { callback(undefined); return; }

        const links: ILink[] = [];
        for (const match of detected) {
          const start = logicalLine.charToCell[match.startIndex];
          const end = logicalLine.charToCell[match.endIndex - 1];
          if (!start || !end) continue;
          if (bufferLineNumber < start.y || bufferLineNumber > end.y) continue;
          links.push({
            range: { start, end },
            text: match.text,
            decorations: { underline: true, pointerCursor: true },
            activate(event: MouseEvent, _text: string) {
              if (!event.metaKey) return;
              if (match.kind === "url") {
                openUrlInBrowser(match.url);
              } else if (match.kind === "file" && cwd) {
                const resolved = resolvePath(match.path, cwd);
                checkFileExists(resolved).then((exists) => {
                  if (exists && onOpenFile) {
                    onOpenFile(resolved, match.line, match.col);
                  }
                });
              }
            },
          });
        }
        if (links.length === 0) { callback(undefined); return; }
        callback(links);
      },
    };
    term.registerLinkProvider(linkProvider);

    let pendingMetaLink: ResolvedLink | null = null;
    const consumeMetaMouseEvent = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      term.focus();
    };
    const openResolvedLink = (link: ResolvedLink) => {
      if (link.kind === "url") {
        openUrlInBrowser(link.url);
      } else if (link.kind === "file" && cwd) {
        const resolved = resolvePath(link.path, cwd);
        checkFileExists(resolved).then((exists) => {
          if (exists && onOpenFile) {
            onOpenFile(resolved, link.line, link.col);
          }
        });
      }
    };
    const onMetaMouseDown = (event: MouseEvent) => {
      if (!event.metaKey || event.button !== 0) {
        pendingMetaLink = null;
        return;
      }
      const pos = getBufferPositionFromMouse(term, event);
      const link = pos ? getLinkAtPosition(term, pos) : null;
      if (!link) {
        pendingMetaLink = null;
        return;
      }
      pendingMetaLink = link;
      consumeMetaMouseEvent(event);
    };
    const onMetaMouseUp = (event: MouseEvent) => {
      const pending = pendingMetaLink;
      pendingMetaLink = null;
      if (!event.metaKey || event.button !== 0 || !pending) return;

      const pos = getBufferPositionFromMouse(term, event);
      const link = pos ? getLinkAtPosition(term, pos) : null;
      consumeMetaMouseEvent(event);
      if (link && sameLink(pending, link)) {
        openResolvedLink(link);
      }
    };
    host.addEventListener("mousedown", onMetaMouseDown, true);
    host.addEventListener("mouseup", onMetaMouseUp, true);

    termRef.current = term;
    fitRef.current = fit;

    let blurHandler: (() => void) | null = null;
    if (tmuxSession) {
      blurHandler = () => {
        invoke("cancel_copy_mode", { name: tmuxSession }).catch(() => {});
      };
      host.addEventListener("focusout", blurHandler);

      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.key === "Escape") {
          // Let ESC reach the PTY so TUIs (vim/less/fzf) receive it, and in
          // parallel ask tmux to exit copy-mode *only if* the pane is actually
          // in a mode (scrolled-up history). When not in copy-mode this is a
          // no-op, so normal apps keep their ESC. Do not swallow the key.
          invoke("copy_mode_cancel_if_active", { name: tmuxSession }).catch(() => {});
          return true;
        }
        if (e.type === "keydown" && e.metaKey && e.key === "c") {
          if (term.hasSelection()) return true;
          invoke<boolean>("copy_tmux_selection", { name: tmuxSession }).then((copied) => {
            if (!copied && ptyId) {
              invoke("pty_write", { id: ptyId, data: "\x03" }).catch(() => {});
            }
          }).catch(() => {});
          return false;
        }
        return true;
      });
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
      term.options.theme = detail;
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);

    const start = async () => {
      try {
        if (tmuxSession) {
          const history = await invoke<string>("capture_pane_history", {
            name: tmuxSession,
          }).catch(() => "");
          if (history) {
            term.write(history + "\r\n");
          }
        }

        const { cols, rows } = term;
        const id = await invoke<string>("pty_open", {
          args: { cmd, args, cwd, cols, rows },
        });
        if (cancelled) {
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;

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
              })
            ) {
              term.write("\r\n\x1b[2m[tmux detached, reconnecting]\x1b[0m\r\n");
              reconnectTimer = window.setTimeout(() => {
                if (!cancelled) setReconnectSeq((value) => value + 1);
              }, TMUX_RECONNECT_DELAY_MS);
              return;
            }
            term.write(`\r\n\x1b[2m[exit ${e.payload.code}]\x1b[0m\r\n`);
          },
        );

        term.onData((data) => {
          if (ptyId) invoke("pty_write", { id: ptyId, data }).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          if (ptyId)
            invoke("pty_resize", { id: ptyId, cols, rows }).catch(() => {});
        });
      } catch (e) {
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
      host.removeEventListener("mousedown", onMetaMouseDown, true);
      host.removeEventListener("mouseup", onMetaMouseUp, true);
      if (blurHandler) host.removeEventListener("focusout", blurHandler);
      window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      unlistenChunk?.();
      unlistenExit?.();
      if (ptyId) invoke("pty_kill", { id: ptyId }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cmd, args.join("\x1f"), cwd, tmuxSession, reconnectSeq]);

  useEffect(() => {
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
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {}
      term.focus();
    });
  }, [active]);

  return <div ref={hostRef} className="term" />;
}
