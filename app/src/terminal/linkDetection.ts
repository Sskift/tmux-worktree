import type { Terminal as XTerm } from "@xterm/xterm";
import { detectLinks, type LinkMatch } from "../linkDetect";

type BufferPosition = { x: number; y: number };
type LogicalLine = {
  text: string;
  charToCell: BufferPosition[];
};
export type ResolvedLink = LinkMatch & {
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

export function buildLogicalLine(term: XTerm, lineIndex: number): LogicalLine | null {
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

export function getBufferPositionFromMouse(term: XTerm, event: MouseEvent): BufferPosition | null {
  const viewportPos = getViewportPositionFromMouse(term, event);
  if (!viewportPos) return null;
  return {
    x: viewportPos.x,
    y: term.buffer.active.viewportY + viewportPos.y,
  };
}

export function getViewportPositionFromMouse(term: XTerm, event: MouseEvent): BufferPosition | null {
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

export function sgrMouseWheel(button: 64 | 65, pos: BufferPosition): string {
  return `\x1b[<${button};${pos.x};${pos.y}M`;
}

export function getLinkAtPosition(term: XTerm, pos: BufferPosition): ResolvedLink | null {
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

export function sameLink(a: ResolvedLink, b: ResolvedLink): boolean {
  return (
    a.text === b.text &&
    a.range.start.x === b.range.start.x &&
    a.range.start.y === b.range.start.y &&
    a.range.end.x === b.range.end.x &&
    a.range.end.y === b.range.end.y
  );
}
