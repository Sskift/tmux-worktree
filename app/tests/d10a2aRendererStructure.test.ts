import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const metadataSource = readFileSync(
  new URL("../src/dashboard/hooks/useTerminalMetadata.ts", import.meta.url),
  "utf8",
);
const layoutSource = readFileSync(
  new URL("../src/dashboard/hooks/useDashboardLayout.ts", import.meta.url),
  "utf8",
);
const persistenceSource = readFileSync(
  new URL("../src/terminalPersistence.ts", import.meta.url),
  "utf8",
);

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

type ExportedName = {
  name: string;
  runtime: boolean;
};

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function exportedNames(sourceFile: ts.SourceFile): ExportedName[] {
  const exports: ExportedName[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        exports.push({ name: "*", runtime: !statement.isTypeOnly });
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        exports.push({ name: statement.exportClause.name.text, runtime: !statement.isTypeOnly });
      } else {
        for (const element of statement.exportClause.elements) {
          exports.push({
            name: element.name.text,
            runtime: !(statement.isTypeOnly || element.isTypeOnly),
          });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exports.push({ name: statement.isExportEquals ? "export=" : "default", runtime: true });
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        ? "default"
        : statement.name?.text;
      assert.ok(name, "non-default export must be named");
      exports.push({ name, runtime: true });
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      exports.push({ name: statement.name.text, runtime: false });
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      exports.push({ name: statement.name.text, runtime: true });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          exports.push({ name, runtime: true });
        }
      }
    }
  }
  return exports;
}

function assertExactExportManifest(
  sourceFile: ts.SourceFile,
  expected: readonly string[],
): void {
  const actual = exportedNames(sourceFile).map(({ name }) => name);
  assert.equal(new Set(actual).size, actual.length, "duplicate exports are forbidden");
  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.equal(
    sourceFile.statements.filter(ts.isExportDeclaration).length,
    0,
    "canonical owners cannot be re-export facades",
  );
}

function expressionPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : null;
  }
  return null;
}

function directFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(matches.length, 1, `expected one direct function ${name}`);
  assert.ok(matches[0].body, `${name} must have a body`);
  return matches[0];
}

function directCalls(body: ts.Block, path: string): Array<{
  call: ts.CallExpression;
  index: number;
}> {
  return body.statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return [];
    }
    return expressionPath(statement.expression.expression) === path
      ? [{ call: statement.expression, index }]
      : [];
  });
}

function callsWithPath(root: ts.Node, path: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) matches.push(node);
  });
  return matches;
}

function effectDependencies(call: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  assert.equal(call.arguments.length, 2);
  const dependencies = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  return dependencies.elements.map((element) => element.getText(sourceFile));
}

function directEffects(
  sourceFile: ts.SourceFile,
  functionName: string,
): ts.CallExpression[] {
  const fn = directFunction(sourceFile, functionName);
  assert.ok(fn.body);
  return directCalls(fn.body, "useEffect").map(({ call }) => call);
}

test("terminal metadata state and phases own exactly the frozen effects and dependencies", () => {
  const sourceFile = parse("useTerminalMetadata.ts", metadataSource);
  const state = directFunction(sourceFile, "useTerminalMetadata");
  assert.ok(state.body);
  assert.equal(directCalls(state.body, "useEffect").length, 0);
  assert.equal(callsWithPath(state.body, "useState").length, 5);
  assert.equal(callsWithPath(state.body, "useRef").length, 1);

  const hydrationEffects = directEffects(
    sourceFile,
    "useTerminalMetadataHydrationPhase",
  );
  assert.equal(hydrationEffects.length, 1);
  assert.deepEqual(effectDependencies(hydrationEffects[0], sourceFile), ["backend"]);
  assert.equal(callsWithPath(hydrationEffects[0], "backend.terminals.load").length, 1);
  assert.equal(callsWithPath(
    hydrationEffects[0],
    "restorePersistedTerminalMetadata",
  ).length, 1);
  assert.equal(callsWithPath(
    hydrationEffects[0],
    "mergeRestoredTerminalMetadata",
  ).length, 1);

  const persistenceEffects = directEffects(
    sourceFile,
    "useTerminalMetadataPersistencePhase",
  );
  assert.equal(persistenceEffects.length, 2);
  assert.deepEqual(effectDependencies(persistenceEffects[0], sourceFile), [
    "backend",
    "terminalPersistenceWritable",
    "terminalsRestoreReady",
  ]);
  assert.deepEqual(effectDependencies(persistenceEffects[1], sourceFile), [
    "terminalPersistenceWritable",
    "terminals",
    "terminalsRestoreReady",
  ]);
  assert.equal(callsWithPath(
    persistenceEffects[0],
    "createTerminalSaveCoordinator",
  ).length, 1);
  assert.equal(callsWithPath(persistenceEffects[0], "backend.terminals.save").length, 1);
  assert.equal(callsWithPath(persistenceEffects[1], "coordinator.enqueue").length, 1);
  const timers = callsWithPath(persistenceEffects[1], "window.setTimeout");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].arguments[1]?.getText(sourceFile), "0");
});

test("App preserves hydration, layout load, persistence, and layout save registration order", () => {
  const sourceFile = parse("App.tsx", appSource);
  const app = directFunction(sourceFile, "App");
  assert.ok(app.body);
  const hydration = directCalls(app.body, "useTerminalMetadataHydrationPhase");
  const persistence = directCalls(app.body, "useTerminalMetadataPersistencePhase");
  const viewportResize = directCalls(app.body, "useDashboardViewportResizePhase");
  const windowCapture = directCalls(app.body, "useDashboardWindowCapturePhase");
  const layoutHydration = directCalls(app.body, "useDashboardLayoutHydrationPhase");
  const layoutPersistence = directCalls(app.body, "useDashboardLayoutPersistencePhase");
  assert.equal(hydration.length, 1);
  assert.equal(persistence.length, 1);
  assert.equal(viewportResize.length, 1);
  assert.equal(windowCapture.length, 1);
  assert.equal(layoutHydration.length, 1);
  assert.equal(layoutPersistence.length, 1);

  const appEffects = directCalls(app.body, "useEffect");
  const automationLoads = appEffects.filter(({ call }) =>
    callsWithPath(call.arguments[0], "loadAutomations").length === 1
  );
  assert.equal(automationLoads.length, 1);
  assert.ok(viewportResize[0].index < windowCapture[0].index);
  assert.ok(windowCapture[0].index < hydration[0].index);
  assert.ok(hydration[0].index < layoutHydration[0].index);
  assert.ok(layoutHydration[0].index < persistence[0].index);
  assert.ok(persistence[0].index < layoutPersistence[0].index);
  assert.ok(layoutPersistence[0].index < automationLoads[0].index);

  const layoutFile = parse("useDashboardLayout.ts", layoutSource);
  for (const name of [
    "useDashboardViewportResizePhase",
    "useDashboardWindowCapturePhase",
    "useDashboardLayoutHydrationPhase",
    "useDashboardLayoutPersistencePhase",
  ]) {
    assert.equal(directEffects(layoutFile, name).length, 1);
  }

  const forbiddenAppCalls = [
    "dashboardBackend.terminals.load",
    "dashboardBackend.terminals.save",
    "dashboardBackend.terminals.ensure",
    "dashboardBackend.sessions.exists",
    "createTerminalSaveCoordinator",
    "restorePersistedTerminalMetadata",
    "mergeRestoredTerminalMetadata",
  ];
  for (const path of forbiddenAppCalls) {
    assert.equal(callsWithPath(app.body, path).length, 0, `${path} must leave App`);
  }
});

test("terminal metadata implementation has one production owner and React-free restore helpers", () => {
  const reachable = readRendererImplementationFiles();
  assert.ok(reachable.some(({ path }) => path === "dashboard/hooks/useTerminalMetadata.ts"));
  const metadataFile = parse("useTerminalMetadata.ts", metadataSource);
  const persistenceFile = parse("terminalPersistence.ts", persistenceSource);
  assertExactExportManifest(metadataFile, [
    "useTerminalMetadata",
    "useTerminalMetadataHydrationPhase",
    "useTerminalMetadataPersistencePhase",
  ]);
  assertExactExportManifest(persistenceFile, [
    "TerminalSaveCoordinator",
    "TerminalSaveScheduler",
    "allocateTerminalId",
    "createTerminalSaveCoordinator",
    "mergeRestoredTerminalMetadata",
    "renamePersistedTerminal",
    "restorePersistedTerminalMetadata",
  ]);
  const expectedOwners = new Map([
    ["useTerminalMetadata", "dashboard/hooks/useTerminalMetadata.ts"],
    ["useTerminalMetadataHydrationPhase", "dashboard/hooks/useTerminalMetadata.ts"],
    ["useTerminalMetadataPersistencePhase", "dashboard/hooks/useTerminalMetadata.ts"],
    ["restorePersistedTerminalMetadata", "terminalPersistence.ts"],
    ["mergeRestoredTerminalMetadata", "terminalPersistence.ts"],
  ]);
  const owners = new Map<string, string[]>();
  for (const { path, source } of reachable) {
    const sourceFile = parse(path, source);
    for (const exported of exportedNames(sourceFile)) {
      if (!exported.runtime || !expectedOwners.has(exported.name)) continue;
      const paths = owners.get(exported.name) ?? [];
      paths.push(path);
      owners.set(exported.name, paths);
    }
  }
  for (const [name, path] of expectedOwners) assert.deepEqual(owners.get(name), [path]);

  assert.equal(
    persistenceFile.statements.filter((statement) =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "react"
    ).length,
    0,
  );
  assert.equal(callsWithPath(persistenceFile, "useEffect").length, 0);
});

test("terminal metadata owner guard recognizes const, alias, and re-export decoys", () => {
  const decoy = parse("owner-decoy.ts", `
    export const useTerminalMetadata = () => {};
    const hydration = () => {};
    export { hydration as useTerminalMetadataHydrationPhase };
    export { persistence as useTerminalMetadataPersistencePhase } from "./elsewhere";
  `);
  assert.deepEqual(
    exportedNames(decoy).filter(({ runtime }) => runtime).map(({ name }) => name).sort(),
    [
      "useTerminalMetadata",
      "useTerminalMetadataHydrationPhase",
      "useTerminalMetadataPersistencePhase",
    ],
  );
  assert.throws(() => assertExactExportManifest(decoy, [
    "useTerminalMetadata",
    "useTerminalMetadataHydrationPhase",
    "useTerminalMetadataPersistencePhase",
  ]), /cannot be re-export facades/);
});
