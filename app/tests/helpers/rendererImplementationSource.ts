import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export type RendererImplementationFile = {
  path: string;
  source: string;
};

const rendererSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const rendererEntryPoint = resolve(rendererSourceRoot, "App.tsx");

function staticRelativeModuleSpecifiers(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

function resolveStaticTypeScriptImport(importer: string, specifier: string): string | null {
  const unresolved = resolve(dirname(importer), specifier);
  const extension = extname(unresolved);
  const candidates = extension === ".ts" || extension === ".tsx"
    ? [unresolved]
    : extension === ".js" || extension === ".jsx" || extension === ".mjs"
      ? [
          unresolved.slice(0, -extension.length) + ".ts",
          unresolved.slice(0, -extension.length) + ".tsx",
        ]
      : extension
        ? []
        : [
            `${unresolved}.ts`,
            `${unresolved}.tsx`,
            resolve(unresolved, "index.ts"),
            resolve(unresolved, "index.tsx"),
          ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) return null;
  const sourceRelativePath = relative(rendererSourceRoot, resolved);
  if (sourceRelativePath.startsWith("..")) {
    throw new Error(`renderer import escapes src/: ${specifier} from ${relative(rendererSourceRoot, importer)}`);
  }
  return resolved;
}

export function readRendererImplementationFiles(): RendererImplementationFile[] {
  const pending = [rendererEntryPoint];
  const reachable = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || reachable.has(path)) continue;
    const source = readFileSync(path, "utf8");
    reachable.set(path, source);
    for (const specifier of staticRelativeModuleSpecifiers(path, source)) {
      const importedPath = resolveStaticTypeScriptImport(path, specifier);
      if (importedPath && !reachable.has(importedPath)) pending.push(importedPath);
    }
  }
  return [...reachable.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => ({
      path: relative(rendererSourceRoot, path),
      source,
    }));
}

export function readRendererImplementationTree(): string {
  return readRendererImplementationFiles()
    .map(({ path, source }) => `\n/* renderer implementation: ${path} */\n${source}`)
    .join("\n");
}

export function rendererImplementationSourceContaining(
  ...needles: readonly string[]
): RendererImplementationFile {
  const matches = readRendererImplementationFiles().filter(({ source }) =>
    needles.every((needle) => source.includes(needle)),
  );
  if (matches.length !== 1) {
    const detail = matches.length === 0
      ? "no implementation file matched"
      : `multiple implementation files matched: ${matches.map(({ path }) => path).join(", ")}`;
    throw new Error(`${detail}; expected one file containing ${needles.join(", ")}`);
  }
  return matches[0];
}
