import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export type RendererImplementationFile = {
  path: string;
  source: string;
};

const rendererSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const rendererEntryPoint = resolve(rendererSourceRoot, "main.tsx");

function relativeModuleSpecifiers(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.add(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.add(statement.moduleReference.expression.text);
    }
  }

  function visitDynamicImports(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isMetaProperty(node.expression.expression)
      && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      && node.expression.expression.name.text === "meta"
      && (node.expression.name.text === "glob" || node.expression.name.text === "globEager")
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      throw new Error(
        `renderer import.meta.${node.expression.name.text} is not supported by the static reachability graph at ${path}:${location.line + 1}:${location.character + 1}`,
      );
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [moduleExpression] = node.arguments;
      if (
        node.arguments.length !== 1
        || !moduleExpression
        || !(ts.isStringLiteral(moduleExpression) || ts.isNoSubstitutionTemplateLiteral(moduleExpression))
      ) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(
          `renderer dynamic import is not statically analyzable at ${path}:${location.line + 1}:${location.character + 1}`,
        );
      }
      specifiers.add(moduleExpression.text);
    }
    ts.forEachChild(node, visitDynamicImports);
  }
  visitDynamicImports(sourceFile);

  return [...specifiers].filter((specifier) => specifier.startsWith("."));
}

function pathIsInside(root: string, candidate: string): boolean {
  const candidateRelativePath = relative(root, candidate);
  return candidateRelativePath !== ".."
    && !candidateRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(candidateRelativePath);
}

function resolveStaticTypeScriptImport(
  sourceRoot: string,
  importer: string,
  specifier: string,
): string | null {
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
  // The characterization graph deliberately follows production TS/TSX only.
  // Explicit CSS, images, and other asset imports are leaves rather than missing code.
  if (candidates.length === 0) return null;
  if (!pathIsInside(sourceRoot, unresolved)) {
    throw new Error(`renderer import escapes src/: ${specifier} from ${relative(sourceRoot, importer)}`);
  }
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `renderer TS/TSX import cannot be resolved: ${specifier} from ${relative(sourceRoot, importer)}`,
    );
  }
  return resolved;
}

export function readRendererImplementationFilesFromEntry(
  sourceRoot: string,
  entryPoint: string,
): RendererImplementationFile[] {
  const normalizedRoot = resolve(sourceRoot);
  const normalizedEntryPoint = resolve(entryPoint);
  if (!pathIsInside(normalizedRoot, normalizedEntryPoint)) {
    throw new Error(`renderer entry point escapes src/: ${normalizedEntryPoint}`);
  }
  const pending = [normalizedEntryPoint];
  const reachable = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || reachable.has(path)) continue;
    const source = readFileSync(path, "utf8");
    reachable.set(path, source);
    for (const specifier of relativeModuleSpecifiers(path, source)) {
      const importedPath = resolveStaticTypeScriptImport(normalizedRoot, path, specifier);
      if (importedPath && !reachable.has(importedPath)) pending.push(importedPath);
    }
  }
  return [...reachable.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => ({
      path: relative(normalizedRoot, path),
      source,
    }));
}

export function readRendererImplementationFiles(): RendererImplementationFile[] {
  return readRendererImplementationFilesFromEntry(rendererSourceRoot, rendererEntryPoint);
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
