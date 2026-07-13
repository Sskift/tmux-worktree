import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";
import * as ts from "typescript";
import { useConnectionCatalog } from "../src/dashboard/hooks/useConnectionCatalog.ts";
import { useDashboardCatalog } from "../src/dashboard/hooks/useDashboardCatalog.ts";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  connection: readFileSync(
    new URL("../src/dashboard/hooks/useConnectionCatalog.ts", import.meta.url),
    "utf8",
  ),
  facade: readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  ),
  workspace: readFileSync(
    new URL("../src/dashboard/hooks/useWorkspaceCatalog.ts", import.meta.url),
    "utf8",
  ),
  refresh: readFileSync(
    new URL("../src/dashboard/hooks/workspaceCatalogRefresh.ts", import.meta.url),
    "utf8",
  ),
  owner: readFileSync(
    new URL("../src/dashboard/ownerEpochLease.ts", import.meta.url),
    "utf8",
  ),
  terminalDeck: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
    "utf8",
  ),
};

const canonicalModules = {
  "dashboard/hooks/useConnectionCatalog.ts": sources.connection,
  "dashboard/hooks/useWorkspaceCatalog.ts": sources.workspace,
  "dashboard/hooks/workspaceCatalogRefresh.ts": sources.refresh,
  "dashboard/ownerEpochLease.ts": sources.owner,
} as const;

type CanonicalModulePath = keyof typeof canonicalModules;

const canonicalExportManifests: Record<CanonicalModulePath, readonly string[]> = {
  "dashboard/hooks/useConnectionCatalog.ts": [
    "useConnectionCatalog",
    "useConnectionCatalogOwnerPhase",
    "useConnectionCatalogSyncPhase",
  ],
  "dashboard/hooks/useWorkspaceCatalog.ts": [
    "FullCatalogPublished",
    "useWorkspaceCatalog",
    "useWorkspaceCatalogOwnerPhase",
  ],
  "dashboard/hooks/workspaceCatalogRefresh.ts": [
    "WorkspaceCatalogFullPublication",
    "WorkspaceCatalogGenerationFence",
    "WorkspaceCatalogPublication",
    "WorkspaceCatalogRefreshOptions",
    "workspaceCatalogRefresh",
  ],
  "dashboard/ownerEpochLease.ts": [
    "OwnerEpochActivation",
    "OwnerEpochCommit",
    "OwnerEpochLease",
    "OwnerEpochLeaseController",
    "createOwnerEpochLeaseController",
  ],
};

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

function importSpecifiers(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .map((declaration) => {
      assert.ok(ts.isStringLiteral(declaration.moduleSpecifier));
      return declaration.moduleSpecifier.text;
    })
    .sort();
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
  const declarationName = (
    declaration: ts.FunctionDeclaration | ts.ClassDeclaration,
  ): string => {
    if (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword)) return "default";
    assert.ok(declaration.name, "non-default exported declaration must be named");
    return declaration.name.text;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        exports.push({ name: "*", runtime: !statement.isTypeOnly });
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        exports.push({ name: statement.exportClause.name.text, runtime: !statement.isTypeOnly });
        continue;
      }
      for (const element of statement.exportClause.elements) {
        exports.push({
          name: element.name.text,
          runtime: !(statement.isTypeOnly || element.isTypeOnly),
        });
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exports.push({ name: statement.isExportEquals ? "export=" : "default", runtime: true });
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      exports.push({ name: declarationName(statement), runtime: true });
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
  assert.equal(new Set(actual).size, actual.length, "duplicate exported names are forbidden");
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function assertCanonicalStaticEdges(sourceFile: ts.SourceFile): void {
  visit(sourceFile, (node) => {
    assert.ok(!ts.isExportDeclaration(node), "canonical modules cannot re-export");
    assert.ok(!ts.isImportEqualsDeclaration(node), "canonical modules cannot use import equals");
    assert.ok(!ts.isImportTypeNode(node), "canonical modules cannot use import type nodes");
    assert.ok(
      !(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword),
      "canonical modules cannot use dynamic import",
    );
  });
}

function canonicalImportTarget(
  from: CanonicalModulePath,
  specifier: string,
): CanonicalModulePath | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [unresolved, `${unresolved}.ts`, posix.join(unresolved, "index.ts")];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(canonicalModules, candidate)) {
      return candidate as CanonicalModulePath;
    }
  }
  return null;
}

function canonicalDependencyGraph(): Map<CanonicalModulePath, CanonicalModulePath[]> {
  const graph = new Map<CanonicalModulePath, CanonicalModulePath[]>();
  for (const [path, source] of Object.entries(canonicalModules) as Array<[
    CanonicalModulePath,
    string,
  ]>) {
    const targets = importSpecifiers(parse(path, source))
      .map((specifier) => canonicalImportTarget(path, specifier))
      .filter((target): target is CanonicalModulePath => target !== null);
    graph.set(path, targets);
  }
  return graph;
}

function assertAcyclic(graph: ReadonlyMap<string, readonly string[]>): void {
  const active = new Set<string>();
  const complete = new Set<string>();
  const walk = (node: string) => {
    if (active.has(node)) assert.fail(`dependency cycle reaches ${node}`);
    if (complete.has(node)) return;
    active.add(node);
    for (const dependency of graph.get(node) ?? []) walk(dependency);
    active.delete(node);
    complete.add(node);
  };
  for (const node of graph.keys()) walk(node);
}

function directFunctionDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(matches.length, 1, `expected one direct function ${name}`);
  return matches[0];
}

function directVariableDeclaration(
  body: ts.Block,
  name: string,
): { statement: ts.VariableStatement; declaration: ts.VariableDeclaration } {
  const matches: Array<{
    statement: ts.VariableStatement;
    declaration: ts.VariableDeclaration;
  }> = [];
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push({ statement, declaration });
      }
    }
  }
  assert.equal(matches.length, 1, `expected one direct variable ${name}`);
  return matches[0];
}

function expressionPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : null;
  }
  return null;
}

function directObjectProperties(object: ts.ObjectLiteralExpression): {
  properties: ts.PropertyAssignment[];
  byName: Map<string, ts.PropertyAssignment>;
} {
  const properties: ts.PropertyAssignment[] = [];
  const byName = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    assert.ok(!ts.isSpreadAssignment(property), "object spreads are forbidden");
    assert.ok(ts.isPropertyAssignment(property), "every option must be a direct property assignment");
    assert.ok(ts.isIdentifier(property.name), "option names must be direct identifiers");
    assert.ok(!byName.has(property.name.text), `duplicate option ${property.name.text}`);
    properties.push(property);
    byName.set(property.name.text, property);
  }
  return { properties, byName };
}

function callExpressionsWithPath(root: ts.Node, path: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) matches.push(node);
  });
  return matches;
}

type WorkspaceRefreshAst = {
  sourceFile: ts.SourceFile;
  refreshUseCallback: ts.CallExpression;
  refreshCallback: ts.ArrowFunction;
  options: ts.ObjectLiteralExpression;
  publishFull: ts.PropertyAssignment;
};

function locateWorkspaceRefresh(source: string): WorkspaceRefreshAst {
  const sourceFile = parse("useWorkspaceCatalog.ts", source);
  const hook = directFunctionDeclaration(sourceFile, "useWorkspaceCatalog");
  assert.ok(hook.body, "useWorkspaceCatalog must have a body");
  const { declaration } = directVariableDeclaration(hook.body, "refresh");
  assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
  const refreshUseCallback = declaration.initializer;
  assert.equal(expressionPath(refreshUseCallback.expression), "useCallback");
  assert.equal(refreshUseCallback.arguments.length, 2);

  const refreshCallback = refreshUseCallback.arguments[0];
  assert.ok(ts.isArrowFunction(refreshCallback), "refresh useCallback must receive an arrow");
  assert.equal(refreshCallback.parameters.length, 0);
  assert.ok(ts.isBlock(refreshCallback.body), "refresh must own an explicit lease guard body");
  const returns = refreshCallback.body.statements.filter(ts.isReturnStatement);
  const coordinatorReturn = returns.find((statement) =>
    statement.expression && ts.isCallExpression(statement.expression) &&
    expressionPath(statement.expression.expression) === "workspaceCatalogRefresh"
  );
  assert.ok(coordinatorReturn?.expression && ts.isCallExpression(coordinatorReturn.expression));
  const coordinatorCall = coordinatorReturn.expression;
  assert.equal(
    callExpressionsWithPath(refreshCallback, "workspaceCatalogRefresh").length,
    1,
    "refresh arrow must call workspaceCatalogRefresh exactly once",
  );
  assert.equal(coordinatorCall.arguments.length, 1);
  const options = coordinatorCall.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options), "refresh options must be an object literal");
  const { byName } = directObjectProperties(options);
  const publishFull = byName.get("publishFull");
  assert.ok(publishFull, "refresh options must directly own publishFull");
  assert.equal(
    options.properties.filter((property) =>
      ts.isPropertyAssignment(property)
      && ts.isIdentifier(property.name)
      && property.name.text === "publishFull"
    ).length,
    1,
  );
  return { sourceFile, refreshUseCallback, refreshCallback, options, publishFull };
}

function directCallStatement(
  statement: ts.Statement,
  expectedPath: string,
): ts.CallExpression {
  assert.ok(ts.isExpressionStatement(statement), `${expectedPath} must be a direct statement`);
  assert.ok(ts.isCallExpression(statement.expression), `${expectedPath} must be a direct call`);
  assert.equal(expressionPath(statement.expression.expression), expectedPath);
  return statement.expression;
}

function assertFullPublicationStatements(analysis: WorkspaceRefreshAst): void {
  const { sourceFile, publishFull, refreshCallback } = analysis;
  assert.ok(ts.isArrowFunction(publishFull.initializer));
  assert.ok(ts.isBlock(publishFull.initializer.body));
  const statements = publishFull.initializer.body.statements;
  assert.equal(statements.length, 12, "publishFull must keep the exact fenced publication sequence");
  assert.match(statements[0].getText(sourceFile), /if \(!registration\.fence\.isCurrent\(lease\)\) return/);
  const assignment = (statement: ts.Statement, left: string): ts.Expression => {
    assert.ok(ts.isExpressionStatement(statement));
    assert.ok(ts.isBinaryExpression(statement.expression));
    assert.equal(statement.expression.operatorToken.kind, ts.SyntaxKind.EqualsToken);
    assert.equal(expressionPath(statement.expression.left), left);
    return statement.expression.right;
  };
  for (const [index, left, right] of [
    [1, "registration.previousActivity", "publication.nextActivity"],
    [2, "registration.failedSessionHostIds", "publication.failedSessionHostIds"],
    [3, "registration.failedTerminalHostIds", "publication.failedTerminalHostIds"],
    [7, "registration.error", "publication.partialError"],
    [8, "registration.ownerPublishedGeneration", "publication.generation"],
  ] as const) {
    assert.equal(expressionPath(assignment(statements[index], left)), right);
  }
  for (const [index, left, comparator, published] of [
    [4, "registration.sessionActivity", "sameSessionActivity", "publication.sessionActivity"],
    [5, "registration.sessions", "sameSessions", "publication.sessions"],
    [6, "registration.discoveredTerminals", "samePlainTerminals", "publication.discoveredTerminals"],
  ] as const) {
    const right = assignment(statements[index], left);
    assert.ok(ts.isConditionalExpression(right));
    assert.ok(ts.isCallExpression(right.condition));
    assert.equal(expressionPath(right.condition.expression), comparator);
    assert.deepEqual(
      right.condition.arguments.map((argument) => expressionPath(argument)),
      [left, published],
    );
    assert.equal(expressionPath(right.whenTrue), left);
    assert.equal(expressionPath(right.whenFalse), published);
  }
  const publishState = directCallStatement(statements[9], "publishState");
  assert.equal(expressionPath(publishState.arguments[0]), "lease");
  assert.match(statements[10].getText(sourceFile), /if \(!registration\.fence\.isCurrent\(lease\)\) return/);
  const callback = directCallStatement(statements[11], "registration.onFullCatalogPublished");
  const callbackPayload = callback.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(callbackPayload));
  const callbackProperties = directObjectProperties(callbackPayload);
  assert.deepEqual(
    callbackProperties.properties.map((property) => (property.name as ts.Identifier).text),
    ["generation", "sessionNames"],
  );
  assert.equal(
    expressionPath(callbackProperties.byName.get("generation")?.initializer as ts.Expression),
    "publication.generation",
  );
  assert.equal(
    expressionPath(callbackProperties.byName.get("sessionNames")?.initializer as ts.Expression),
    "publication.authoritativeSessionNames",
  );
  assert.equal(
    callExpressionsWithPath(refreshCallback, "registration.onFullCatalogPublished").length,
    1,
    "the accepted-full callback must occur only in publishFull",
  );
  assert.strictEqual(callback, callExpressionsWithPath(
    refreshCallback,
    "registration.onFullCatalogPublished",
  )[0]);
  assert.strictEqual(statements[statements.length - 1], callback.parent);
  assert.ok(sourceFile === publishFull.getSourceFile());
}

type AppPollingAst = {
  sourceFile: ts.SourceFile;
  previewIndex: number;
  pollingIndex: number;
  automationIndex: number;
};

function locateAppPolling(source: string): AppPollingAst {
  const sourceFile = parse("App.tsx", source);
  const app = directFunctionDeclaration(sourceFile, "App");
  assert.ok(app.body, "App must have a body");
  const statements = [...app.body.statements];

  const polling = statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    return expressionPath(statement.expression.expression) === "useVisibilityAwarePolling"
      ? [{ call: statement.expression, index }]
      : [];
  });
  assert.equal(polling.length, 1, "App must directly register workspace polling exactly once");
  const [{ call: pollingCall, index: pollingIndex }] = polling;
  assert.equal(pollingCall.arguments.length, 2);
  assert.equal(expressionPath(pollingCall.arguments[0]), "refresh");
  const pollingOptions = pollingCall.arguments[1];
  assert.ok(ts.isObjectLiteralExpression(pollingOptions));
  const pollingProperties = directObjectProperties(pollingOptions);
  assert.deepEqual(
    pollingProperties.properties.map((property) => (property.name as ts.Identifier).text),
    ["visibleIntervalMs", "hiddenIntervalMs"],
  );
  assert.equal(
    expressionPath(pollingProperties.byName.get("visibleIntervalMs")?.initializer as ts.Expression),
    "REFRESH_MS",
  );
  assert.equal(
    expressionPath(pollingProperties.byName.get("hiddenIntervalMs")?.initializer as ts.Expression),
    "HIDDEN_REFRESH_MS",
  );

  const previewPhases = statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    return expressionPath(statement.expression.expression) === "useTerminalDeckPreviewPhase"
      ? [{ call: statement.expression, index }]
      : [];
  });
  assert.equal(previewPhases.length, 1, "App must directly register the preview phase");
  assert.equal(previewPhases[0].call.arguments.length, 3);
  const previewIndex = previewPhases[0].index;

  const automationPhases = statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    return expressionPath(statement.expression.expression) === "useAutomationWorkspaceSchedulerPhase"
      ? [{ index }]
      : [];
  });
  assert.equal(
    automationPhases.length,
    1,
    "automation scheduler must be a direct App phase",
  );
  const automationIndex = automationPhases[0].index;
  assert.ok(previewIndex < pollingIndex && pollingIndex < automationIndex);
  return { sourceFile, previewIndex, pollingIndex, automationIndex };
}

function variableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let result: ts.VariableDeclaration | null = null;
  visit(sourceFile, (node) => {
    if (
      !result
      && ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
    ) {
      result = node;
    }
  });
  assert.ok(result, `expected variable ${name}`);
  return result;
}

test("the historical catalog hook is an exact explicit compatibility alias", () => {
  const sourceFile = parse("useDashboardCatalog.ts", sources.facade);
  assert.equal(sourceFile.statements.length, 1);
  const [statement] = sourceFile.statements;
  assert.ok(ts.isExportDeclaration(statement));
  assert.equal(statement.isTypeOnly, false);
  assert.ok(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier));
  assert.equal(statement.moduleSpecifier.text, "./useConnectionCatalog");
  assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause));
  assert.equal(statement.exportClause.elements.length, 1);
  const [element] = statement.exportClause.elements;
  assert.equal(element.isTypeOnly, false);
  assert.equal(element.propertyName?.text, "useConnectionCatalog");
  assert.equal(element.name.text, "useDashboardCatalog");
  assert.strictEqual(useDashboardCatalog, useConnectionCatalog);
  assert.doesNotMatch(sources.facade, /export\s*\*/);
});

test("connection, workspace, and refresh implementations have unique reachable owners", () => {
  const reachable = readRendererImplementationFiles();
  const reachablePaths = new Set(reachable.map(({ path }) => path));
  const expectedOwners = new Map<string, CanonicalModulePath>([
    ["useConnectionCatalog", "dashboard/hooks/useConnectionCatalog.ts"],
    ["useConnectionCatalogOwnerPhase", "dashboard/hooks/useConnectionCatalog.ts"],
    ["useConnectionCatalogSyncPhase", "dashboard/hooks/useConnectionCatalog.ts"],
    ["useWorkspaceCatalog", "dashboard/hooks/useWorkspaceCatalog.ts"],
    ["useWorkspaceCatalogOwnerPhase", "dashboard/hooks/useWorkspaceCatalog.ts"],
    ["workspaceCatalogRefresh", "dashboard/hooks/workspaceCatalogRefresh.ts"],
    ["createOwnerEpochLeaseController", "dashboard/ownerEpochLease.ts"],
  ]);
  for (const [path, source] of Object.entries(canonicalModules) as Array<[
    CanonicalModulePath,
    string,
  ]>) {
    assert.ok(reachablePaths.has(path), `${path} must be production reachable from main.tsx`);
    assertExactExportManifest(parse(path, source), canonicalExportManifests[path]);
  }

  const owners = new Map<string, string[]>();
  for (const { path, source } of reachable) {
    const sourceFile = parse(path, source);
    for (const exported of exportedNames(sourceFile)) {
      if (exported.runtime && expectedOwners.has(exported.name)) {
        const paths = owners.get(exported.name) ?? [];
        paths.push(path);
        owners.set(exported.name, paths);
      }
    }
  }
  for (const [name, path] of expectedOwners) {
    assert.deepEqual(owners.get(name), [path]);
  }

  const appFile = parse("App.tsx", sources.app);
  const connectionImports = appFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./dashboard/hooks/useConnectionCatalog",
  );
  assert.equal(connectionImports.length, 1);
  const connectionBindings = connectionImports[0].importClause?.namedBindings;
  assert.ok(connectionBindings && ts.isNamedImports(connectionBindings));
  assert.deepEqual(
    connectionBindings.elements.map((element) => ({
      imported: element.propertyName?.text ?? element.name.text,
      local: element.name.text,
      typeOnly: element.isTypeOnly,
    })),
    [
      { imported: "useConnectionCatalog", local: "useConnectionCatalog", typeOnly: false },
      {
        imported: "useConnectionCatalogOwnerPhase",
        local: "useConnectionCatalogOwnerPhase",
        typeOnly: false,
      },
      {
        imported: "useConnectionCatalogSyncPhase",
        local: "useConnectionCatalogSyncPhase",
        typeOnly: false,
      },
    ],
  );
  assert.match(sources.app, /const connectionCatalog = useConnectionCatalog\(dashboardBackend\);/);
  assert.match(sources.app, /useConnectionCatalogOwnerPhase\(connectionCatalog\.ownerPhase, dashboardBackend\);/);
  assert.match(sources.app, /useConnectionCatalogSyncPhase\(connectionCatalog, dashboardBackend\);/);
  assert.match(sources.app, /\} = useWorkspaceCatalog\(dashboardBackend\);/);
  assert.match(sources.app, /useWorkspaceCatalogOwnerPhase\(workspaceCatalogOwnerPhase, \{/);
  assert.doesNotMatch(sources.app, /useDashboardCatalog/);
});

test("the D10a-1 hook dependency graph remains one-way", () => {
  const expectedImports: Record<CanonicalModulePath, readonly string[]> = {
    "dashboard/hooks/useConnectionCatalog.ts": [
      "../../platform",
      "../ownerEpochLease",
      "./useVisibilityAwarePolling",
      "react",
    ],
    "dashboard/hooks/useWorkspaceCatalog.ts": [
      "../../platform",
      "../model/catalogEquality",
      "../model/sessionActivity",
      "../ownerEpochLease",
      "./workspaceCatalogRefresh",
      "react",
    ],
    "dashboard/hooks/workspaceCatalogRefresh.ts": [
      "../../platform",
      "../model/catalogSnapshot",
      "../model/sessionActivity",
      "../ownerEpochLease",
    ],
    "dashboard/ownerEpochLease.ts": [],
  };
  for (const [path, source] of Object.entries(canonicalModules) as Array<[
    CanonicalModulePath,
    string,
  ]>) {
    const sourceFile = parse(path, source);
    assertCanonicalStaticEdges(sourceFile);
    assert.deepEqual(importSpecifiers(sourceFile), [...expectedImports[path]].sort());
  }

  const graph = canonicalDependencyGraph();
  assert.deepEqual(
    Object.fromEntries([...graph].map(([path, dependencies]) => [path, dependencies])),
    {
      "dashboard/hooks/useConnectionCatalog.ts": ["dashboard/ownerEpochLease.ts"],
      "dashboard/hooks/useWorkspaceCatalog.ts": [
        "dashboard/ownerEpochLease.ts",
        "dashboard/hooks/workspaceCatalogRefresh.ts",
      ],
      "dashboard/hooks/workspaceCatalogRefresh.ts": ["dashboard/ownerEpochLease.ts"],
      "dashboard/ownerEpochLease.ts": [],
    },
  );
  assertAcyclic(graph);

  assert.doesNotMatch(sources.refresh, /\bReact\b|\bApp\b|TerminalDeck|localStorage|\bwindow\b|\bdocument\b/);
  assert.doesNotMatch(sources.workspace, /TerminalDeck|useConnectionCatalog|useDashboardCatalog|dashboard\/layout|terminal\/|useVisibilityAwarePolling/);
  assert.doesNotMatch(sources.connection, /useWorkspaceCatalog|workspaceCatalogRefresh/);
});

test("canonical export and edge guards reject declaration and hidden-edge decoys", () => {
  const coverage = parse("coverage.ts", `
    export function functionOwner() {}
    export class ClassOwner {}
    export interface InterfaceOwner {}
    export type TypeOwner = string;
    export enum EnumOwner { Value }
    export const scalarOwner = 1, { leftOwner, nested: { rightOwner } } = value;
    export { source as aliasOwner, type TypeSource as typeAliasOwner, source as default } from "./named";
    export * as namespaceOwner from "./namespace";
    export * from "./star";
  `);
  const coverageExports = exportedNames(coverage);
  assert.deepEqual(
    coverageExports.map(({ name }) => name).sort(),
    [
      "*",
      "ClassOwner",
      "EnumOwner",
      "InterfaceOwner",
      "TypeOwner",
      "aliasOwner",
      "default",
      "functionOwner",
      "leftOwner",
      "namespaceOwner",
      "rightOwner",
      "scalarOwner",
      "typeAliasOwner",
    ].sort(),
  );
  assert.equal(coverageExports.find(({ name }) => name === "InterfaceOwner")?.runtime, false);
  assert.equal(coverageExports.find(({ name }) => name === "TypeOwner")?.runtime, false);
  assert.equal(coverageExports.find(({ name }) => name === "typeAliasOwner")?.runtime, false);
  assert.equal(coverageExports.find(({ name }) => name === "scalarOwner")?.runtime, true);

  assert.throws(() => assertExactExportManifest(parse("duplicate.ts", `
    export const useConnectionCatalog = () => {}, useConnectionCatalog = () => {};
  `), ["useConnectionCatalog"]), /duplicate exported names/);
  assert.throws(() => assertExactExportManifest(parse("extra.ts", `
    export function useConnectionCatalog() {}
    export const extra = true;
  `), ["useConnectionCatalog"]));

  const dynamicImport = parse("dynamic.ts", `
    export function useConnectionCatalog() { return import("./hidden"); }
  `);
  assertExactExportManifest(dynamicImport, ["useConnectionCatalog"]);
  assert.throws(() => assertCanonicalStaticEdges(dynamicImport), /dynamic import/);

  const reExport = parse("re-export.ts", `
    export { implementation as useConnectionCatalog } from "./hidden";
  `);
  assertExactExportManifest(reExport, ["useConnectionCatalog"]);
  assert.throws(() => assertCanonicalStaticEdges(reExport), /cannot re-export/);

  const importType = parse("import-type.ts", `
    type Hidden = import("./hidden").Hidden;
    export function useConnectionCatalog(): Hidden { throw new Error(); }
  `);
  assertExactExportManifest(importType, ["useConnectionCatalog"]);
  assert.throws(() => assertCanonicalStaticEdges(importType), /import type nodes/);

  const importEquals = parse("import-equals.ts", `
    import Hidden = require("./hidden");
    export function useConnectionCatalog() { return Hidden; }
  `);
  assertExactExportManifest(importEquals, ["useConnectionCatalog"]);
  assert.throws(() => assertCanonicalStaticEdges(importEquals), /import equals/);
});

test("workspace catalog keeps state render-pure and commits ownership only in layout phases", () => {
  const sourceFile = parse("useWorkspaceCatalog.ts", sources.workspace);
  const reactImport = sourceFile.statements.find((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === "react",
  );
  assert.ok(reactImport?.importClause?.namedBindings);
  assert.ok(ts.isNamedImports(reactImport.importClause.namedBindings));
  assert.deepEqual(
    reactImport.importClause.namedBindings.elements.map(({ name }) => name.text).sort(),
    ["useCallback", "useLayoutEffect", "useState"],
  );
  assert.doesNotMatch(sources.workspace, /\buseEffect\b|useVisibilityAwarePolling|\.current\s*=/);
  assert.equal(callExpressionsWithPath(sourceFile, "useLayoutEffect").length, 2);

  const refresh = locateWorkspaceRefresh(sources.workspace);
  const dependencies = refresh.refreshUseCallback.arguments[1];
  assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
  assert.deepEqual(
    dependencies.elements.map((element) => element.getText(sourceFile)),
    ["dashboardBackend", "publishState", "registration"],
  );
  assert.doesNotMatch(dependencies.getText(sourceFile), /onFullCatalogPublished/);
  assert.match(
    sources.workspace,
    /registration\.backend = dashboardBackend;[\s\S]*?registration\.sessionOrder = sessionOrder;[\s\S]*?registration\.onFullCatalogPublished = onFullCatalogPublished;[\s\S]*?registration\.fence\.commit\(dashboardBackend\)/,
  );
  assert.match(
    sources.workspace,
    /const activation = registration\.fence\.activate\(\);[\s\S]*?registration\.fence\.deactivate\(activation\)/,
  );
});

test("a successful full publication invokes the latest callback exactly once as its last action", () => {
  assertFullPublicationStatements(locateWorkspaceRefresh(sources.workspace));
});

test("App registers workspace polling after the terminal deck preview phase", () => {
  const analysis = locateAppPolling(sources.app);
  assert.ok(analysis.previewIndex < analysis.pollingIndex);
  assert.ok(analysis.pollingIndex < analysis.automationIndex);
});

test("workspace refresh AST guard rejects string, nested, duplicate-key, and spread decoys", () => {
  assert.throws(() => locateWorkspaceRefresh(`
    function useWorkspaceCatalog() {
      const refresh = useCallback(() => notTheCoordinator(
        "workspaceCatalogRefresh({ publishFull: callback })"
      ), []);
    }
  `));
  assert.throws(() => locateWorkspaceRefresh(`
    function useWorkspaceCatalog() {
      function nested() {
        const refresh = useCallback(() => {
          return workspaceCatalogRefresh({ publishFull: () => {} });
        }, []);
      }
    }
  `));
  assert.throws(() => locateWorkspaceRefresh(`
    function useWorkspaceCatalog() {
      const refresh = useCallback(() => {
        return workspaceCatalogRefresh({
          publishFull: () => {},
          publishFull: () => {},
        });
      }, []);
    }
  `), /duplicate option publishFull/);
  assert.throws(() => locateWorkspaceRefresh(`
    function useWorkspaceCatalog() {
      const refresh = useCallback(() => {
        return workspaceCatalogRefresh({
          ...options,
          publishFull: () => {},
        });
      }, []);
    }
  `), /object spreads are forbidden/);
});

test("App polling AST guard rejects string, nested, duplicate-key, and spread decoys", () => {
  const realPreview = `
    useTerminalDeckPreviewPhase(terminalDeck, dashboardBackend, {
      sessions,
      allTerminals,
    });
  `;
  const automation = "useAutomationWorkspaceSchedulerPhase(tickScheduledAutomations);";
  assert.throws(() => locateAppPolling(`
    function App() {
      const decoy = "useTerminalDeckPreviewPhase(terminalDeck, dashboardBackend, inputs)";
      useVisibilityAwarePolling(refresh, {
        visibleIntervalMs: REFRESH_MS,
        hiddenIntervalMs: HIDDEN_REFRESH_MS,
      });
      ${automation}
    }
  `), /preview phase/);
  assert.throws(() => locateAppPolling(`
    function App() {
      ${realPreview}
      function nested() {
        useVisibilityAwarePolling(refresh, {
          visibleIntervalMs: REFRESH_MS,
          hiddenIntervalMs: HIDDEN_REFRESH_MS,
        });
      }
      ${automation}
    }
  `), /directly register workspace polling/);
  assert.throws(() => locateAppPolling(`
    function App() {
      ${realPreview}
      useVisibilityAwarePolling(refresh, {
        visibleIntervalMs: REFRESH_MS,
        visibleIntervalMs: REFRESH_MS,
        hiddenIntervalMs: HIDDEN_REFRESH_MS,
      });
      ${automation}
    }
  `), /duplicate option visibleIntervalMs/);
  assert.throws(() => locateAppPolling(`
    function App() {
      ${realPreview}
      useVisibilityAwarePolling(refresh, {
        ...cadence,
        visibleIntervalMs: REFRESH_MS,
        hiddenIntervalMs: HIDDEN_REFRESH_MS,
      });
      ${automation}
    }
  `), /object spreads are forbidden/);
});

test("App supplies an exact owner-bound functional full-catalog prune callback", () => {
  const sourceFile = parse("useTerminalDeckState.ts", sources.terminalDeck);
  const callback = variableDeclaration(sourceFile, "handleFullCatalogPublished");
  assert.ok(callback.initializer && ts.isCallExpression(callback.initializer));
  assert.equal(callback.initializer.expression.getText(sourceFile), "useCallback");
  const dependencies = callback.initializer.arguments[1];
  assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
  assert.deepEqual(
    dependencies.elements.map((element) => element.getText(sourceFile)),
    ["lease", "registration"],
  );
  const callbackSource = callback.initializer.arguments[0]?.getText(sourceFile) ?? "";
  assert.match(callbackSource, /setOpenedSessions\(\(previous\) => \{/);
  assert.match(callbackSource, /setCwdsBySession\(\(previous\) => \{/);
  assert.match(callbackSource, /sameStringArray\(previous, next\) \? previous : next/);
  assert.match(callbackSource, /sameStringRecord\(previous, next\) \? previous : next/);
  assert.match(
    sources.app,
    /useWorkspaceCatalogOwnerPhase\(workspaceCatalogOwnerPhase, \{\s*dashboardBackend,\s*sessionOrder,\s*onFullCatalogPublished: handleFullCatalogPublished,\s*\}\)/s,
  );
  assert.doesNotMatch(
    `${sources.app}\n${sources.terminalDeck}`,
    /authoritativeCatalogGeneration|authoritativeSessionNames/,
  );
});
