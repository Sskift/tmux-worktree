import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

function parse(relativePath: string, text = source(relativePath)): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function expressionPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : null;
  }
  return null;
}

function calls(file: ts.SourceFile, path: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(file, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) {
      matches.push(node);
    }
  });
  return matches;
}

function exportedNames(file: ts.SourceFile): string[] {
  return file.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        return ["*"];
      }
      return statement.exportClause.elements.map((element) => element.name.text);
    }
    if (!ts.canHaveModifiers(statement)) return [];
    const exported = (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) return [];
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      assert.ok(statement.name);
      return [statement.name.text];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
      );
    }
    assert.fail(`unexpected E2-B export ${ts.SyntaxKind[statement.kind]}`);
  });
}

test("snapshot and close helpers have exact pure owners and exports", () => {
  const snapshotFile = parse("dashboard/layoutSnapshot.ts");
  const closeFile = parse("dashboard/layoutClosePersistence.ts");
  assert.deepEqual(exportedNames(snapshotFile).sort(), [
    "DashboardLayoutSnapshotCut",
    "DashboardLayoutSnapshotInput",
    "buildDashboardLayoutSnapshot",
  ]);
  assert.deepEqual(exportedNames(closeFile).sort(), [
    "DashboardLayoutCloseGate",
    "DashboardLayoutClosePersistenceOptions",
    "flushDashboardLayoutOnClose",
  ]);

  const reachable = readRendererImplementationFiles();
  for (const [symbol, expectedOwner] of [
    ["buildDashboardLayoutSnapshot", "dashboard/layoutSnapshot.ts"],
    ["flushDashboardLayoutOnClose", "dashboard/layoutClosePersistence.ts"],
  ] as const) {
    const owners = reachable.flatMap(({ path, source: implementation }) =>
      exportedNames(parse(path, implementation)).includes(symbol) ? [path] : []
    );
    assert.deepEqual(owners, [expectedOwner]);
  }

  for (const implementation of [source("dashboard/layoutSnapshot.ts"), source("dashboard/layoutClosePersistence.ts")]) {
    assert.doesNotMatch(
      implementation,
      /\b(?:React|useEffect|useState|setState|localStorage|document)\b/,
    );
  }
});

test("close persistence reads geometry before the latest cut and uses one flush path", () => {
  const closeFile = parse("dashboard/layoutClosePersistence.ts");
  assert.equal(calls(closeFile, "readWindowCapture").length, 1);
  assert.equal(calls(closeFile, "options.getGate").length, 1);
  assert.equal(calls(closeFile, "options.getLatestSnapshotCut").length, 1);
  assert.equal(calls(closeFile, "options.coordinator.flush").length, 1);
  assert.equal(calls(closeFile, "saveLayoutPreferences").length, 0);
  const read = calls(closeFile, "readWindowCapture")[0];
  const getGate = calls(closeFile, "options.getGate")[0];
  const getCut = calls(closeFile, "options.getLatestSnapshotCut")[0];
  const flush = calls(closeFile, "options.coordinator.flush")[0];
  assert.ok(read.pos < getGate.pos);
  assert.ok(getGate.pos < getCut.pos);
  assert.ok(getCut.pos < flush.pos);
  assert.deepEqual(
    flush.arguments.map((argument) => argument.getText(closeFile).replace(/\s+/g, "")),
    ["gate.attempt", "finalSnapshot", "signal"],
  );
});

test("live capture delegates every native state read to the cancellable read API", () => {
  const captureFile = parse("dashboard/windowCaptureCoordinator.ts");
  assert.equal(calls(captureFile, "readWindowCapture").length, 1);
  for (const method of [
    "isFullscreen",
    "isMaximized",
    "innerSize",
    "outerPosition",
    "scaleFactor",
  ]) {
    assert.equal(
      calls(captureFile, `target.${method}`).length,
      1,
      `${method} must have one read owner`,
    );
    assert.equal(calls(captureFile, `options.target.${method}`).length, 0);
  }
});
