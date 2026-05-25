import { invoke } from "@tauri-apps/api/core";

export type LinkMatch = {
  text: string;
  startIndex: number;
  endIndex: number;
} & (
  | { kind: "url"; url: string }
  | { kind: "file"; path: string; line?: number; col?: number }
);

const URL_REGEX = /https?:\/\/[^\s'")\]}>]+/g;

// Matches file paths like:
//   ./src/foo.ts:42:10   ../bar.rs   src/baz.ts:10   /absolute/path.ts
const FILE_PATH_REGEX =
  /(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.\w+(?::(\d+)(?::(\d+))?)?/g;

export function detectLinks(line: string): LinkMatch[] {
  const matches: LinkMatch[] = [];

  URL_REGEX.lastIndex = 0;
  for (const m of line.matchAll(URL_REGEX)) {
    matches.push({
      text: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      kind: "url",
      url: m[0],
    });
  }

  FILE_PATH_REGEX.lastIndex = 0;
  for (const m of line.matchAll(FILE_PATH_REGEX)) {
    const start = m.index!;
    const end = start + m[0].length;
    // Skip if overlapping with a URL match
    const overlaps = matches.some(
      (existing) => start < existing.endIndex && end > existing.startIndex,
    );
    if (overlaps) continue;

    const colonIdx = m[0].indexOf(":");
    const filePart = colonIdx >= 0 ? m[0].slice(0, colonIdx) : m[0];
    const lineNum = m[1] ? parseInt(m[1], 10) : undefined;
    const col = m[2] ? parseInt(m[2], 10) : undefined;

    matches.push({
      text: m[0],
      startIndex: start,
      endIndex: end,
      kind: "file",
      path: filePart,
      line: lineNum,
      col,
    });
  }

  return matches;
}

export function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("/")) return filePath;
  const clean = filePath.startsWith("./") ? filePath.slice(2) : filePath;
  return `${cwd}/${clean}`;
}

export async function checkFileExists(absolutePath: string): Promise<boolean> {
  try {
    return await invoke<boolean>("file_exists", { path: absolutePath });
  } catch {
    return false;
  }
}

export async function openUrlInBrowser(url: string): Promise<void> {
  await invoke("open_url", { url });
}
