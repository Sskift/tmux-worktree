import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface RustSourceFile {
  path: string;
  source: string;
}

const defaultRustSourceRoot = fileURLToPath(new URL("../src-tauri/src/", import.meta.url));

function maskRustCommentsAndLiterals(source: string): string {
  const chars = source.split("");
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  };

  for (let index = 0; index < source.length;) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      blank(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) throw new Error("unterminated Rust block comment");
      blank(index, cursor);
      index = cursor;
      continue;
    }

    const raw = source.slice(index).match(/^(?:b|c)?r(#{0,32})"/);
    if (raw) {
      const marker = `"${raw[1]}`;
      const end = source.indexOf(marker, index + raw[0].length);
      if (end < 0) throw new Error("unterminated Rust raw string");
      const cursor = end + marker.length;
      blank(index, cursor);
      index = cursor;
      continue;
    }

    if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === '"') {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      if (cursor > source.length || source[cursor - 1] !== '"') {
        throw new Error("unterminated Rust string");
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }

    if (source[index] === "'") {
      let cursor = index + 1;
      if (source[cursor] === "\\") {
        cursor += 2;
        while (cursor < source.length && source[cursor] !== "\n") {
          if (source[cursor] === "\\") cursor += 2;
          else if (source[cursor] === "'") {
            cursor += 1;
            break;
          } else cursor += 1;
        }
      } else {
        const codePoint = source.codePointAt(cursor);
        cursor += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        if (source[cursor] === "'") cursor += 1;
        else cursor = index + 1;
      }
      if (cursor > index + 1 && source[cursor - 1] === "'") {
        blank(index, cursor);
        index = cursor;
        continue;
      }
    }

    index += 1;
  }
  return chars.join("");
}

function blankRange(source: string, start: number, end: number): string {
  return source.slice(0, start)
    + source.slice(start, end).replace(/[^\r\n]/g, " ")
    + source.slice(end);
}

function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`unterminated Rust ${open}${close} region`);
}

function rustModuleDisposition(source: string, displayPath: string): "production" | "test-only" {
  const masked = maskRustCommentsAndLiterals(source);
  let cursor = masked.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (/\s/.test(masked[cursor] ?? "")) cursor += 1;

  while (masked.startsWith("#!", cursor)) {
    const bracketStart = masked.indexOf("[", cursor + 2);
    if (bracketStart < 0 || masked.slice(cursor + 2, bracketStart).trim() !== "") {
      throw new Error(`${displayPath}: malformed Rust inner attribute`);
    }
    const bracketEnd = matchingDelimiter(masked, bracketStart, "[", "]");
    const attribute = masked.slice(cursor, bracketEnd + 1).replace(/\s/g, "");
    if (attribute === "#![cfg(test)]") return "test-only";
    if (attribute.startsWith("#![cfg(")) {
      throw new Error(`${displayPath}: conditional production module files are unsupported`);
    }
    cursor = bracketEnd + 1;
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1;
  }
  return "production";
}

function previousOuterAttributeStart(source: string, before: number): number | null {
  let cursor = before - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (source[cursor] !== "]") return null;

  let depth = 0;
  let bracketStart = -1;
  for (; cursor >= 0; cursor -= 1) {
    if (source[cursor] === "]") depth += 1;
    else if (source[cursor] === "[") {
      depth -= 1;
      if (depth === 0) {
        bracketStart = cursor;
        break;
      }
    }
  }
  if (bracketStart < 0) throw new Error("unbalanced Rust outer attribute");
  cursor = bracketStart - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (source[cursor] !== "#" || source[cursor - 1] === "!") return null;
  return cursor;
}

function outerAttributeGroupStart(source: string, attributeStart: number): number {
  let start = attributeStart;
  while (true) {
    const previous = previousOuterAttributeStart(source, start);
    if (previous === null) return start;
    start = previous;
  }
}

function skipOuterAttributes(source: string, from: number): number {
  let cursor = from;
  while (true) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "#" || source[cursor + 1] === "!") return cursor;
    let bracketStart = cursor + 1;
    while (/\s/.test(source[bracketStart] ?? "")) bracketStart += 1;
    if (source[bracketStart] !== "[") return cursor;
    cursor = matchingDelimiter(source, bracketStart, "[", "]") + 1;
  }
}

function readRustWord(source: string, from: number): { word: string; end: number } | null {
  const match = source.slice(from).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return match ? { word: match[1], end: from + match[0].length } : null;
}

function findSemicolonItemEnd(source: string, from: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") {
      if (braceDepth === 0) throw new Error("cannot determine #[cfg(test)] semicolon item boundary");
      braceDepth -= 1;
    } else if (char === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return index + 1;
    }
    if (parenDepth < 0 || bracketDepth < 0) {
      throw new Error("unbalanced Rust test item signature");
    }
  }
  throw new Error("cannot determine #[cfg(test)] semicolon item boundary");
}

function findBodyOrSemicolonItemEnd(source: string, from: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (parenDepth === 0 && bracketDepth === 0 && char === ";") return index + 1;
    else if (parenDepth === 0 && bracketDepth === 0 && char === "{") {
      let end = matchingDelimiter(source, index, "{", "}") + 1;
      while (/\s/.test(source[end] ?? "")) end += 1;
      if (source[end] === ";") return end + 1;
      if (/[>,.):?]/.test(source[end] ?? "") || /^else\b/.test(source.slice(end))) {
        throw new Error("ambiguous #[cfg(test)] body item boundary");
      }
      return end;
    }
    if (parenDepth < 0 || bracketDepth < 0) {
      throw new Error("unbalanced Rust test item signature");
    }
  }
  throw new Error("cannot determine #[cfg(test)] body item boundary");
}

function attributedRustItemEnd(source: string, afterAttribute: number): number {
  let cursor = skipOuterAttributes(source, afterAttribute);
  let token = readRustWord(source, cursor);
  if (!token) throw new Error("unsupported #[cfg(test)] attributed form");

  if (token.word === "pub") {
    cursor = token.end;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "(") cursor = matchingDelimiter(source, cursor, "(", ")") + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    token = readRustWord(source, cursor);
    if (!token) throw new Error("unsupported #[cfg(test)] public item");
  }

  while (["async", "unsafe", "default"].includes(token.word)) {
    cursor = token.end;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    token = readRustWord(source, cursor);
    if (!token) throw new Error("unsupported #[cfg(test)] modified item");
  }

  if (["use", "type", "static", "let"].includes(token.word)) {
    return findSemicolonItemEnd(source, token.end);
  }
  if (token.word === "const") {
    let next = token.end;
    while (/\s/.test(source[next] ?? "")) next += 1;
    const following = readRustWord(source, next);
    return following?.word === "fn"
      ? findBodyOrSemicolonItemEnd(source, following.end)
      : findSemicolonItemEnd(source, token.end);
  }
  if (["fn", "mod", "struct", "enum", "union", "trait", "impl", "extern", "macro", "macro_rules"].includes(token.word)) {
    return findBodyOrSemicolonItemEnd(source, token.end);
  }
  throw new Error(`unsupported #[cfg(test)] item kind: ${token.word}`);
}

/** Remove every test-only item, including associated items nested in impl/trait blocks. */
export function stripRustTestItems(source: string): string {
  let production = source;
  while (true) {
    const masked = maskRustCommentsAndLiterals(production);
    let curlyDepth = 0;
    let testAttributeStart = -1;
    let testAttributeEnd = -1;

    for (let index = 0; index < masked.length; index += 1) {
      if (masked[index] === "{") curlyDepth += 1;
      else if (masked[index] === "}") curlyDepth -= 1;
      if (curlyDepth < 0) throw new Error("unbalanced Rust braces");
      if (masked[index] !== "#") continue;
      const match = masked.slice(index).match(/^#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/);
      if (match) {
        testAttributeStart = index;
        testAttributeEnd = index + match[0].length;
        break;
      }
    }
    if (testAttributeStart < 0) return production;

    const itemEnd = attributedRustItemEnd(masked, testAttributeEnd);
    production = blankRange(production, outerAttributeGroupStart(masked, testAttributeStart), itemEnd);
  }
}

interface ExternalModule {
  name: string;
}

function topLevelExternalModules(source: string, displayPath: string): ExternalModule[] {
  const masked = maskRustCommentsAndLiterals(source);
  if (/\binclude\s*!/.test(masked)) {
    throw new Error(`${displayPath}: include! is unsupported by the static Rust source graph`);
  }
  if (/#\s*\[[^\]]*\bpath\s*=/.test(masked)) {
    throw new Error(`${displayPath}: #[path] is unsupported by the static Rust source graph`);
  }

  const modules: ExternalModule[] = [];
  let curlyDepth = 0;
  let itemBoundary = 0;
  const modulePattern = /\bmod\b/g;
  let match: RegExpExecArray | null;
  while ((match = modulePattern.exec(masked)) !== null) {
    for (let index = itemBoundary; index < match.index; index += 1) {
      if (masked[index] === "{") curlyDepth += 1;
      else if (masked[index] === "}") curlyDepth -= 1;
    }
    itemBoundary = match.index;
    if (curlyDepth !== 0) continue;

    const declaration = masked.slice(match.index).match(/^mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*([;{])/);
    if (!declaration) {
      throw new Error(`${displayPath}: unsupported dynamic or malformed module declaration`);
    }
    const prefixStart = Math.max(
      masked.lastIndexOf(";", match.index - 1),
      masked.lastIndexOf("}", match.index - 1),
    ) + 1;
    const prefix = masked.slice(prefixStart, match.index).trim();
    if (/^#\s*\[\s*cfg\s*\(/.test(prefix) || /#\s*\[\s*cfg\s*\(/.test(prefix)) {
      throw new Error(`${displayPath}: conditional production modules are unsupported`);
    }
    if (prefix !== "" && prefix !== "pub") {
      throw new Error(`${displayPath}: only top-level mod name; and pub mod name; are supported`);
    }
    if (declaration[2] === "{") {
      throw new Error(`${displayPath}: inline modules are unsupported by the static Rust source graph`);
    }
    modules.push({ name: declaration[1] });
    modulePattern.lastIndex = match.index + declaration[0].length;
  }
  return modules;
}

function childModuleDirectory(path: string): string {
  const file = basename(path);
  if (file === "lib.rs" || file === "main.rs" || file === "mod.rs") return dirname(path);
  return resolve(dirname(path), file.slice(0, -3));
}

export function readRustSourceFiles(sourceRoot = defaultRustSourceRoot): RustSourceFile[] {
  const root = resolve(sourceRoot);
  const roots = [resolve(root, "lib.rs"), resolve(root, "main.rs")];
  for (const path of roots) {
    if (!existsSync(path)) throw new Error(`missing authoritative Rust crate root: ${path}`);
  }

  const files = new Map<string, RustSourceFile>();
  const visit = (path: string) => {
    if (files.has(path)) return;
    const displayPath = relative(root, path).split(sep).join("/");
    const rawSource = readFileSync(path, "utf8");
    if (rustModuleDisposition(rawSource, displayPath) === "test-only") return;
    const source = stripRustTestItems(rawSource);
    if (/#\s*!?\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(maskRustCommentsAndLiterals(source))) {
      throw new Error(`${displayPath}: unhandled #[cfg(test)] attribute remains after sanitization`);
    }
    files.set(path, { path: displayPath, source });

    for (const module of topLevelExternalModules(source, displayPath)) {
      const directory = childModuleDirectory(path);
      const candidates = [
        resolve(directory, `${module.name}.rs`),
        resolve(directory, module.name, "mod.rs"),
      ].filter(existsSync);
      if (candidates.length !== 1) {
        throw new Error(
          `${displayPath}: module ${module.name} resolved to ${candidates.length} files (expected exactly one)`,
        );
      }
      visit(candidates[0]);
    }
  };

  roots.forEach(visit);
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function readRustSourceTree(sourceRoot = defaultRustSourceRoot): string {
  return readRustSourceFiles(sourceRoot)
    .map((file) => `// --- ${file.path} ---\n${file.source}`)
    .join("\n");
}

export function readRustProductionSource(path: string): string {
  const file = readRustSourceFiles().find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Rust source is not production-reachable: ${path}`);
  return file.source;
}
