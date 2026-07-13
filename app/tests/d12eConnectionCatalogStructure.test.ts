import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const hookSource = readFileSync(
  new URL("../src/dashboard/hooks/useConnectionCatalog.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const connectionsSource = readFileSync(
  new URL("../src/dashboard/Settings/ConnectionsSettings.tsx", import.meta.url),
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

function expressionPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expressionPath(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : null;
  }
  return null;
}

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

function directFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(matches.length, 1, `expected one direct function ${name}`);
  assert.ok(matches[0].body);
  return matches[0];
}

function directCalls(body: ts.Block, path: string): ts.CallExpression[] {
  return body.statements.flatMap((statement) => {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      return expressionPath(statement.expression.expression) === path
        ? [statement.expression]
        : [];
    }
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        expressionPath(declaration.initializer.expression) === path
        ? [declaration.initializer]
        : []
    );
  });
}

function callsWithLeaf(root: ts.Node, leaf: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (expressionPath(node.expression)?.split(".").at(-1) === leaf) calls.push(node);
  });
  return calls;
}

function callsWithPath(root: ts.Node, path: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) {
      calls.push(node);
    }
  });
  return calls;
}

function directVariableCall(body: ts.Block, name: string): ts.CallExpression {
  const matches: ts.CallExpression[] = [];
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer)
      ) {
        matches.push(declaration.initializer);
      }
    }
  }
  assert.equal(matches.length, 1, `expected one variable call ${name}`);
  return matches[0];
}

function directArrowVariable(body: ts.Block, name: string): ts.ArrowFunction {
  const matches = body.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        ts.isArrowFunction(declaration.initializer)
        ? [declaration.initializer]
        : []
    );
  });
  assert.equal(matches.length, 1, `expected one direct arrow ${name}`);
  assert.ok(ts.isBlock(matches[0].body));
  return matches[0];
}

function variableCallWithin(root: ts.Node, name: string): ts.CallExpression {
  const matches: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      matches.push(node.initializer);
    }
  });
  assert.equal(matches.length, 1, `expected one nested variable call ${name}`);
  return matches[0];
}

function dependencies(call: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  assert.equal(call.arguments.length, 2);
  const value = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(value));
  return value.elements.map((element) => compact(element, sourceFile));
}

function exportedNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    assert.equal(ts.isExportDeclaration(statement), false, "canonical hook cannot re-export");
    if (!ts.canHaveModifiers(statement)) continue;
    const exported = (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    assert.ok(ts.isFunctionDeclaration(statement) && statement.name);
    names.push(statement.name.text);
  }
  return names.sort();
}

test("connection catalog has exact exports imports and phase effect ownership", () => {
  const sourceFile = parse("useConnectionCatalog.ts", hookSource);
  assert.deepEqual(exportedNames(sourceFile), [
    "useConnectionCatalog",
    "useConnectionCatalogOwnerPhase",
    "useConnectionCatalogSyncPhase",
  ]);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  assert.deepEqual(imports.map((statement) => {
    assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
    return statement.moduleSpecifier.text;
  }).sort(), [
    "../../platform",
    "../ownerEpochLease",
    "./useVisibilityAwarePolling",
    "react",
  ].sort());
  const platformImport = imports.find(
    (statement) =>
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../../platform",
  );
  assert.ok(platformImport?.importClause);
  assert.equal(platformImport.importClause.isTypeOnly, true);
  const reactImport = imports.find(
    (statement) =>
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react",
  );
  assert.ok(reactImport?.importClause?.namedBindings);
  assert.equal(reactImport.importClause.name, undefined);
  assert.ok(ts.isNamedImports(reactImport.importClause.namedBindings));
  assert.deepEqual(
    reactImport.importClause.namedBindings.elements.map((element) => {
      assert.equal(element.propertyName, undefined, "React hook aliases are forbidden");
      return `${element.isTypeOnly ? "type:" : "value:"}${element.name.text}`;
    }),
    [
      "value:useCallback",
      "value:useEffect",
      "value:useLayoutEffect",
      "value:useMemo",
      "value:useState",
      "type:Dispatch",
      "type:SetStateAction",
    ],
  );
  assert.doesNotMatch(hookSource, /\buseDashboardBackend\b/);

  const state = directFunction(sourceFile, "useConnectionCatalog");
  const owner = directFunction(sourceFile, "useConnectionCatalogOwnerPhase");
  const sync = directFunction(sourceFile, "useConnectionCatalogSyncPhase");
  assert.ok(state.body && owner.body && sync.body);
  assert.equal(callsWithLeaf(state.body, "useEffect").length, 0);
  assert.equal(callsWithLeaf(state.body, "useLayoutEffect").length, 0);
  assert.equal(callsWithLeaf(state.body, "useVisibilityAwarePolling").length, 0);
  assert.equal(directCalls(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithLeaf(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithLeaf(owner.body, "useEffect").length, 0);
  assert.equal(directCalls(sync.body, "useEffect").length, 2);
  assert.equal(callsWithLeaf(sync.body, "useEffect").length, 2);
  assert.equal(directCalls(sync.body, "useVisibilityAwarePolling").length, 2);
  assert.equal(callsWithLeaf(sync.body, "useVisibilityAwarePolling").length, 2);
  const phaseOrder: string[] = [];
  for (const statement of sync.body.statements) {
    visit(statement, (node) => {
      if (!ts.isCallExpression(node)) return;
      const path = expressionPath(node.expression);
      if (
        (path === "useEffect" || path === "useVisibilityAwarePolling") &&
        node.parent === statement
      ) {
        phaseOrder.push(path);
      }
    });
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const path = expressionPath(statement.expression.expression);
      if (path === "useEffect" || path === "useVisibilityAwarePolling") {
        if (phaseOrder.at(-1) !== path) phaseOrder.push(path);
      }
    }
  }
  assert.deepEqual(phaseOrder, [
    "useEffect",
    "useVisibilityAwarePolling",
    "useEffect",
    "useVisibilityAwarePolling",
  ]);
});

test("App registers connection ownership before Relay and remounts connection settings", () => {
  const sourceFile = parse("App.tsx", appSource);
  const app = directFunction(sourceFile, "App");
  assert.ok(app.body);
  const statementIndex = (path: string): number[] => app.body!.statements.flatMap(
    (statement, index) => {
      const calls = directCalls({
        ...app.body!,
        statements: ts.factory.createNodeArray([statement]),
      } as ts.Block, path);
      return calls.length ? [index] : [];
    },
  );
  const catalogIndex = statementIndex("useConnectionCatalog");
  const ownerIndex = statementIndex("useConnectionCatalogOwnerPhase");
  const syncIndex = statementIndex("useConnectionCatalogSyncPhase");
  const relayIndex = statementIndex("useMobileRelayController");
  assert.deepEqual(catalogIndex.length, 1);
  assert.deepEqual(ownerIndex.length, 1);
  assert.deepEqual(syncIndex.length, 1);
  assert.deepEqual(relayIndex.length, 1);
  assert.equal(ownerIndex[0], catalogIndex[0] + 1);
  assert.equal(syncIndex[0], ownerIndex[0] + 1);
  assert.ok(syncIndex[0] < relayIndex[0]);
  for (const hook of [
    "useConnectionCatalog",
    "useConnectionCatalogOwnerPhase",
    "useConnectionCatalogSyncPhase",
  ]) {
    assert.equal(callsWithPath(app.body, hook).length, 1, `${hook} must be unique`);
  }
  const catalogCall = directVariableCall(app.body, "connectionCatalog");
  assert.equal(expressionPath(catalogCall.expression), "useConnectionCatalog");
  assert.deepEqual(
    catalogCall.arguments.map((argument) => compact(argument, sourceFile)),
    ["dashboardBackend"],
  );
  const ownerCalls = directCalls(app.body, "useConnectionCatalogOwnerPhase");
  const syncCalls = directCalls(app.body, "useConnectionCatalogSyncPhase");
  assert.equal(ownerCalls.length, 1);
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(
    ownerCalls[0].arguments.map((argument) => compact(argument, sourceFile)),
    ["connectionCatalog.ownerPhase", "dashboardBackend"],
  );
  assert.deepEqual(
    syncCalls[0].arguments.map((argument) => compact(argument, sourceFile)),
    ["connectionCatalog", "dashboardBackend"],
  );
  for (const [component, prefix] of [
    ["AgentsSettings", "agents"],
    ["ConnectionsSettings", "connections"],
  ] as const) {
    const elements: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
    visit(app.body, (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(sourceFile) === component
      ) {
        elements.push(node);
      }
    });
    assert.equal(elements.length, 1, `${component} must have one real JSX owner`);
    const keys = elements[0].attributes.properties.filter(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "key",
    );
    assert.equal(keys.length, 1, `${component} must have one key`);
    assert.equal(
      compact(keys[0].initializer!, sourceFile),
      `{\`${prefix}:\${connectionCatalogOwnerEpochKey}\`}`,
    );
  }
});

test("render-bound mutations use exact leases while stale mutations only trigger reload", () => {
  const sourceFile = parse("useConnectionCatalog.ts", hookSource);
  const state = directFunction(sourceFile, "useConnectionCatalog");
  assert.ok(state.body);
  for (const name of ["loadProjectPresets", "installRemoteTw"]) {
    const call = directVariableCall(state.body, name);
    assert.equal(expressionPath(call.expression), "useCallback");
    assert.equal(callsWithLeaf(call.arguments[0], "capture").length, 0);
    assert.deepEqual(dependencies(call, sourceFile), [
      "dashboardBackend",
      "registration",
      "renderLease",
    ]);
  }
  const staleMutation = directVariableCall(state.body, "onHostsMutationSettled");
  assert.deepEqual(dependencies(staleMutation, sourceFile), [
    "dashboardBackend",
    "registration",
    "renderLease",
  ]);
  assert.equal(callsWithLeaf(staleMutation.arguments[0], "capture").length, 0);
  const fingerprint = directFunction(sourceFile, "hostFingerprint");
  assert.ok(fingerprint.body);
  for (const field of [
    "host.id",
    "host.label",
    "host.host",
    "host.user",
    "host.port",
    "host.identityFile",
    "host.worktreeBase",
    "host.tmuxPath",
    "host.twPath",
  ]) {
    assert.match(compact(fingerprint.body, sourceFile), new RegExp(field.replace(".", "\\.")));
  }
  const mutation = directFunction(sourceFile, "reloadHostsAfterStaleMutation");
  assert.ok(mutation.body);
  const mutationText = compact(mutation.body, sourceFile);
  assert.match(mutationText, /registration\.fence\.capture\(dashboardBackend\)/);
  assert.match(mutationText, /loadHostsForOwner\(registration,dashboardBackend,currentLease\)/);
  assert.match(mutationText, /registration\.catalogReloadRequired=true/);
  assert.doesNotMatch(mutationText, /nextHosts|publishHostsForOwner/);
  const sync = directFunction(sourceFile, "useConnectionCatalogSyncPhase");
  assert.ok(sync.body);
  assert.match(
    compact(sync.body, sourceFile),
    /enabled:connectionCatalog\.hostsHydrationGeneration===0\|\|connectionCatalog\.catalogReloadRequired/,
  );
  assert.doesNotMatch(
    compact(sync.body, sourceFile),
    /refreshKey:connectionCatalog\.ownerEpochKey/,
  );
  assert.match(
    compact(sync.body, sourceFile),
    /restartKey:dashboardBackend/,
  );
  assert.match(connectionsSource, /invalidateAll\(\)/);
  const connectionsFile = parse("ConnectionsSettings.tsx", connectionsSource);
  const connections = directFunction(connectionsFile, "ConnectionsSettings");
  assert.ok(connections.body);
  assert.equal(
    callsWithPath(connections.body, "onHostsMutationSettled").length,
    2,
  );
  for (const name of ["saveHost", "deleteHost"]) {
    const operation = directArrowVariable(connections.body, name);
    assert.ok(ts.isBlock(operation.body));
    const settlement = variableCallWithin(operation.body, "payloadAccepted");
    assert.equal(expressionPath(settlement.expression), "onHostsMutationSettled");
    assert.deepEqual(
      settlement.arguments.map((argument) => compact(argument, connectionsFile)),
      [
        "updatedHosts",
        "asyncCoordinatorRef.current.isCurrent(catalogRequest)",
      ],
    );
  }
});
