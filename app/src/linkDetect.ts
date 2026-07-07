import { invoke } from "@tauri-apps/api/core";

export type LinkMatch = {
  text: string;
  startIndex: number;
  endIndex: number;
} & (
  | { kind: "url"; url: string }
  | { kind: "file"; path: string; line?: number; col?: number }
);

// Stop a URL only at whitespace, quotes, or angle brackets — parens/brackets are
// allowed *inside* (e.g. wikipedia `/Foo_(bar)`) and balanced/trimmed afterwards.
const URL_REGEX = /https?:\/\/[^\s'"<>`]+/g;

// Trailing chars that are almost never part of a URL when they end one (sentence
// punctuation, CJK punctuation). Closing brackets are handled separately so we
// keep balanced ones like `…/Foo_(bar)` but drop a stray `)` from `(see …)`.
const URL_TRAILING_PUNCT = ".,;:!?'\"`*。，、；：！？…";
const CLOSE_TO_OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

// Trim trailing punctuation / unbalanced closing brackets off a raw URL match.
function trimUrl(raw: string): string {
  let url = raw;
  while (url.length > 0) {
    const last = url[url.length - 1];
    const open = CLOSE_TO_OPEN[last];
    if (open) {
      // Keep the closing bracket only if it pairs with an opener inside the URL.
      if (countChar(url, last) > countChar(url, open)) {
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    if (URL_TRAILING_PUNCT.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

// Matches file paths like:
//   ./src/foo.ts:42:10   ../bar.rs   src/baz.ts:10   /absolute/path.ts
const FILE_PATH_REGEX =
  /(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.\w+(?::(\d+)(?::(\d+))?)?/g;

// "Medium" strictness: a bare `word.word` token (no path separator, no :line
// suffix) is only treated as a file link when its extension is a known source /
// config extension. This keeps `package.json` clickable while not underlining
// version strings (`0.10.9`), domains (`google.com`), or prose (`e.g.`).
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "rs", "py", "pyi", "go", "java", "kt", "kts", "c", "h", "cpp", "cc", "cxx",
  "hpp", "hh", "cs", "rb", "php", "swift", "scala", "clj", "cljs", "ex", "exs",
  "erl", "hs", "ml", "mli", "lua", "dart", "r", "jl", "sh", "bash", "zsh",
  "fish", "ps1", "sql", "html", "htm", "css", "scss", "sass", "less", "vue",
  "svelte", "astro", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml",
  "md", "mdx", "rst", "txt", "lock", "gradle", "proto", "graphql", "gql",
  "env", "tf", "dockerfile", "makefile", "cmake", "vim", "el",
]);

function extensionOf(filePart: string): string {
  const dot = filePart.lastIndexOf(".");
  if (dot < 0) return "";
  return filePart.slice(dot + 1).toLowerCase();
}

export function detectLinks(line: string): LinkMatch[] {
  const matches: LinkMatch[] = [];

  URL_REGEX.lastIndex = 0;
  for (const m of line.matchAll(URL_REGEX)) {
    const url = trimUrl(m[0]);
    if (!url) continue;
    matches.push({
      text: url,
      startIndex: m.index!,
      endIndex: m.index! + url.length,
      kind: "url",
      url,
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

    // Only underline a bare filename (no path separator, no :line suffix) when
    // its extension is a recognized source/config type — otherwise version
    // numbers and domains get spuriously linked.
    const hasPathSep = filePart.includes("/");
    const hasLineSuffix = lineNum !== undefined;
    if (!hasPathSep && !hasLineSuffix && !SOURCE_EXTENSIONS.has(extensionOf(filePart))) {
      continue;
    }

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
