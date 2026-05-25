const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

export type FileCategory = "code" | "markdown" | "image";

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
