import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface RustSourceFile {
  path: string;
  source: string;
}

const rustSourceRoot = fileURLToPath(new URL("../src-tauri/src/", import.meta.url));

function collectRustSourceFiles(directory: string): RustSourceFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectRustSourceFiles(path);
      if (!entry.isFile() || !entry.name.endsWith(".rs")) return [];
      return [{
        path: relative(rustSourceRoot, path).split(sep).join("/"),
        source: readFileSync(path, "utf8"),
      }];
    });
}

export function readRustSourceFiles(): RustSourceFile[] {
  return collectRustSourceFiles(rustSourceRoot);
}

export function readRustSourceTree(): string {
  return readRustSourceFiles()
    .map((file) => `// --- ${file.path} ---\n${file.source}`)
    .join("\n");
}
