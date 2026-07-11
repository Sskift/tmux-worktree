const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

export type FileCategory = "code" | "markdown" | "image";

export type EditorIndentation =
  | { kind: "tabs"; size: number }
  | { kind: "spaces"; size: number };

export function getFileExtension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function getFileCategory(path: string): FileCategory {
  const ext = getFileExtension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  return "code";
}

export function getLanguageLabel(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = getFileExtension(path);
  if (name === "dockerfile") return "Dockerfile";
  if (name === "makefile") return "Makefile";
  switch (ext) {
    case "ts": case "tsx": case "mts": case "cts": return "TypeScript";
    case "js": case "jsx": case "mjs": case "cjs": return "JavaScript";
    case "json": case "jsonc": return "JSON";
    case "css": return "CSS";
    case "scss": return "SCSS";
    case "less": return "Less";
    case "html": case "htm": return "HTML";
    case "xml": return "XML";
    case "svg": return "SVG";
    case "md": case "markdown": case "mdx": return "Markdown";
    case "py": return "Python";
    case "rs": return "Rust";
    case "sh": case "bash": case "zsh": return "Shell";
    case "yml": case "yaml": return "YAML";
    case "toml": return "TOML";
    case "go": return "Go";
    case "java": return "Java";
    case "kt": case "kts": return "Kotlin";
    case "swift": return "Swift";
    case "c": case "h": return "C";
    case "cc": case "cpp": case "cxx": case "hpp": return "C++";
    case "sql": return "SQL";
    default: return "Plain Text";
  }
}

export function getFileTypeBadge(path: string): string {
  const ext = getFileExtension(path);
  if (!ext) return "TXT";
  if (ext === "markdown") return "MD";
  return ext.slice(0, 4).toUpperCase();
}

export function getLineEndingLabel(content: string): "CRLF" | "LF" {
  return /\r\n/.test(content) ? "CRLF" : "LF";
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left;
}

/** Infer the indentation used by meaningful lines without mistaking alignment
 * whitespace for a one-space indent. Two spaces is the safe editor default. */
export function detectEditorIndentation(content: string): EditorIndentation {
  let tabLines = 0;
  const spaceWidths: number[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const leading = line.match(/^[\t ]+/)?.[0];
    if (!leading) continue;
    if (leading[0] === "\t") {
      tabLines += 1;
      continue;
    }
    if (!leading.includes("\t")) spaceWidths.push(leading.length);
  }

  if (tabLines > spaceWidths.length) return { kind: "tabs", size: 4 };
  if (spaceWidths.length === 0) return { kind: "spaces", size: 2 };

  const divisor = spaceWidths.reduce(greatestCommonDivisor);
  const size = divisor >= 2 && divisor <= 8 ? divisor : 2;
  return { kind: "spaces", size };
}

export async function getLanguageExtension(path: string) {
  const ext = getFileExtension(path);
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "ts": case "tsx": case "mts": case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "json": case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "css": case "scss": case "less":
      return (await import("@codemirror/lang-css")).css();
    case "html": case "htm": case "xml": case "svg":
      return (await import("@codemirror/lang-html")).html();
    case "md": case "markdown": case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    default:
      return null;
  }
}
