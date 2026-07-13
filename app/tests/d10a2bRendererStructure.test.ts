import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  selection: readFileSync(
    new URL(
      "../src/dashboard/hooks/useCatalogSelectionHydration.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  connection: readFileSync(
    new URL("../src/dashboard/hooks/useConnectionCatalog.ts", import.meta.url),
    "utf8",
  ),
  relay: readFileSync(
    new URL(
      "../src/dashboard/hooks/useMobileRelayController.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  metadata: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalMetadata.ts", import.meta.url),
    "utf8",
  ),
  polling: readFileSync(
    new URL(
      "../src/dashboard/hooks/useVisibilityAwarePolling.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  terminalDeck: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
    "utf8",
  ),
  layout: readFileSync(
    new URL("../src/dashboard/hooks/useDashboardLayout.ts", import.meta.url),
    "utf8",
  ),
  automation: readFileSync(
    new URL("../src/dashboard/hooks/useAutomationWorkspace.ts", import.meta.url),
    "utf8",
  ),
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

function expressionPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : null;
  }
  return null;
}

function directFunction(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.equal(matches.length, 1, `expected one direct function ${name}`);
  assert.ok(matches[0].body, `${name} must have a body`);
  return matches[0];
}

function directVariable(
  body: ts.Block,
  name: string,
): ts.VariableDeclaration {
  const matches: ts.VariableDeclaration[] = [];
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push(declaration);
      }
    }
  }
  assert.equal(matches.length, 1, `expected one direct variable ${name}`);
  return matches[0];
}

function directStateVariable(
  body: ts.Block,
  name: string,
): ts.VariableDeclaration {
  const matches: ts.VariableDeclaration[] = [];
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (bindingNames(declaration.name).includes(name)) matches.push(declaration);
    }
  }
  assert.equal(matches.length, 1, `expected one direct state binding ${name}`);
  return matches[0];
}

function callsWithPath(root: ts.Node, path: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) {
      matches.push(node);
    }
  });
  return matches;
}

function directCalls(
  body: ts.Block,
  path: string,
): Array<{ call: ts.CallExpression; index: number }> {
  return body.statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return [];
    }
    return expressionPath(statement.expression.expression) === path
      ? [{ call: statement.expression, index }]
      : [];
  });
}

function directTopLevelCalls(
  body: ts.Block,
  path: string,
): Array<{ call: ts.CallExpression; index: number }> {
  const matches = directCalls(body, path);
  for (const [index, statement] of body.statements.entries()) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        expressionPath(declaration.initializer.expression) === path
      ) {
        matches.push({ call: declaration.initializer, index });
      }
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function directVariableIndex(body: ts.Block, name: string): number {
  const matches: number[] = [];
  for (const [index, statement] of body.statements.entries()) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push(index);
      }
    }
  }
  assert.equal(matches.length, 1, `expected one direct variable statement ${name}`);
  return matches[0];
}

function callDependencies(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string[] {
  assert.equal(call.arguments.length, 2);
  const dependencies = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  return dependencies.elements.map((element) => element.getText(sourceFile));
}

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

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

type ExportedName = { name: string; runtime: boolean };

function exportedNames(sourceFile: ts.SourceFile): ExportedName[] {
  const exports: ExportedName[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        exports.push({ name: "*", runtime: !statement.isTypeOnly });
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        exports.push({
          name: statement.exportClause.name.text,
          runtime: !statement.isTypeOnly,
        });
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
      exports.push({
        name: statement.isExportEquals ? "export=" : "default",
        runtime: true,
      });
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
    if (ts.isModuleDeclaration(statement)) {
      exports.push({ name: statement.name.text, runtime: true });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          exports.push({ name, runtime: true });
        }
      }
      continue;
    }
    assert.fail(
      `unsupported exported declaration: ${ts.SyntaxKind[statement.kind]}`,
    );
  }
  return exports;
}

function importManifest(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      imports.push(`${module}|<side-effect>|<side-effect>|value`);
      continue;
    }
    if (clause.name) {
      imports.push(
        `${module}|default|${clause.name.text}|${clause.isTypeOnly ? "type" : "value"}`,
      );
    }
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      imports.push(
        `${module}|*|${clause.namedBindings.name.text}|${clause.isTypeOnly ? "type" : "value"}`,
      );
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      imports.push(
        `${module}|${element.propertyName?.text ?? element.name.text}|${element.name.text}|${
          clause.isTypeOnly || element.isTypeOnly ? "type" : "value"
        }`,
      );
    }
  }
  return imports.sort();
}

function assertExactCanonicalExport(
  sourceFile: ts.SourceFile,
  expected: readonly string[],
): void {
  const actual = exportedNames(sourceFile).map(({ name }) => name);
  assert.equal(new Set(actual).size, actual.length, "duplicate exports are forbidden");
  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.equal(
    sourceFile.statements.filter(
      (statement) =>
        ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
    ).length,
    0,
    "the canonical owner cannot be a facade",
  );
}

function directObjectProperties(object: ts.ObjectLiteralExpression): {
  names: string[];
  byName: Map<string, ts.ObjectLiteralElementLike>;
} {
  const names: string[] = [];
  const byName = new Map<string, ts.ObjectLiteralElementLike>();
  for (const property of object.properties) {
    assert.ok(!ts.isSpreadAssignment(property), "object spreads are forbidden");
    assert.ok(
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
      "object members must be direct properties",
    );
    assert.ok(ts.isIdentifier(property.name), "property names must be identifiers");
    assert.ok(!byName.has(property.name.text), `duplicate property ${property.name.text}`);
    names.push(property.name.text);
    byName.set(property.name.text, property);
  }
  return { names, byName };
}

function propertyInitializer(
  property: ts.ObjectLiteralElementLike | undefined,
): ts.Expression {
  assert.ok(property, "expected property");
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  assert.ok(ts.isPropertyAssignment(property));
  return property.initializer;
}

function directCallStatement(
  statement: ts.Statement,
  path: string,
): ts.CallExpression {
  assert.ok(ts.isExpressionStatement(statement), `${path} must be a direct statement`);
  assert.ok(ts.isCallExpression(statement.expression), `${path} must be a direct call`);
  assert.equal(expressionPath(statement.expression.expression), path);
  return statement.expression;
}

function effectCallbackBlock(effect: ts.CallExpression): ts.Block {
  assert.equal(expressionPath(effect.expression), "useEffect");
  const callback = effect.arguments[0];
  assert.ok(
    callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)),
  );
  assert.ok(ts.isBlock(callback.body));
  return callback.body;
}

function locateAppSelectionCall(sourceFile: ts.SourceFile): {
  app: ts.FunctionDeclaration;
  call: ts.CallExpression;
  index: number;
} {
  const app = directFunction(sourceFile, "App");
  assert.ok(app.body);
  const matches: Array<{ call: ts.CallExpression; index: number }> = [];
  for (const [index, statement] of app.body.statements.entries()) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        expressionPath(declaration.initializer.expression) ===
          "useCatalogSelectionHydration"
      ) {
        assert.ok(ts.isObjectBindingPattern(declaration.name));
        assert.equal(
          statement.declarationList.declarations.length,
          1,
          "the selection hook must own its direct App statement",
        );
        assert.deepEqual(
          declaration.name.elements.map((element) => {
            assert.ok(ts.isIdentifier(element.name));
            assert.equal(element.propertyName, undefined);
            assert.equal(element.dotDotDotToken, undefined);
            return element.name.text;
          }),
          [
            "allTerminals",
            "selectedSession",
            "selectedTerminal",
            "selectionMetadataPending",
          ],
        );
        matches.push({ call: declaration.initializer, index });
      }
    }
  }
  assert.equal(matches.length, 1, "App must directly call the selection hook once");
  assert.equal(
    callsWithPath(app.body, "useCatalogSelectionHydration").length,
    1,
    "App cannot hide a duplicate selection hook call",
  );
  return { app, ...matches[0] };
}

test("catalog selection hydration has one canonical reachable owner and exact API", () => {
  const sourceFile = parse("useCatalogSelectionHydration.ts", sources.selection);
  assertExactCanonicalExport(sourceFile, ["useCatalogSelectionHydration"]);

  const reachable = readRendererImplementationFiles();
  assert.ok(
    reachable.some(
      ({ path }) =>
        path === "dashboard/hooks/useCatalogSelectionHydration.ts",
    ),
  );
  const owners = reachable.flatMap(({ path, source }) =>
    exportedNames(parse(path, source))
      .filter(
        ({ name, runtime }) =>
          runtime && name === "useCatalogSelectionHydration",
      )
      .map(() => path)
  );
  assert.deepEqual(owners, ["dashboard/hooks/useCatalogSelectionHydration.ts"]);

  assert.deepEqual(importManifest(sourceFile), [
    "../../platform|HostConfig|HostConfig|type",
    "../../platform|PlainTerminal|PlainTerminal|type",
    "../../platform|Session|Session|type",
    "../model/selection|PendingCatalogSelection|PendingCatalogSelection|type",
    "../model/selection|Selection|Selection|type",
    "../model/selection|reconcileCatalogSelection|reconcileCatalogSelection|value",
    "../model/selection|sameCatalogSelection|sameCatalogSelection|value",
    "../model/terminalIdentity|isLocalDiscoveredInternalTerminal|isLocalDiscoveredInternalTerminal|value",
    "../model/terminalIdentity|normalizePlainTerminal|normalizePlainTerminal|value",
    "../model/terminalIdentity|terminalSessionKey|terminalSessionKey|value",
    "react|Dispatch|Dispatch|type",
    "react|SetStateAction|SetStateAction|type",
    "react|useEffect|useEffect|value",
    "react|useMemo|useMemo|value",
  ].sort());
  assert.deepEqual(sourceFile.referencedFiles, []);
  assert.deepEqual(sourceFile.typeReferenceDirectives, []);
  assert.deepEqual(sourceFile.libReferenceDirectives, []);
  visit(sourceFile, (node) => {
    assert.ok(!ts.isImportEqualsDeclaration(node));
    assert.ok(!ts.isImportTypeNode(node));
    assert.ok(
      !(ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword),
    );
    assert.ok(
      !(ts.isCallExpression(node) && expressionPath(node.expression) === "require"),
    );
  });

  const decoy = parse("decoy.ts", `
    export const useCatalogSelectionHydration = () => {};
    const hidden = () => {};
    export { hidden as useCatalogSelectionHydration };
    export { other as useCatalogSelectionHydration } from "./other";
  `);
  assert.equal(
    exportedNames(decoy).filter(
      ({ name, runtime }) => runtime && name === "useCatalogSelectionHydration",
    ).length,
    3,
  );
  assert.throws(
    () => assertExactCanonicalExport(decoy, ["useCatalogSelectionHydration"]),
    /duplicate exports/,
  );
  const namespaceDecoy = parse("namespace.ts", `
    export function useCatalogSelectionHydration() {}
    export namespace Hidden {}
  `);
  assert.deepEqual(exportedNames(namespaceDecoy), [
    { name: "useCatalogSelectionHydration", runtime: true },
    { name: "Hidden", runtime: true },
  ]);
  assert.throws(
    () => assertExactCanonicalExport(namespaceDecoy, [
      "useCatalogSelectionHydration",
    ]),
    "the extra namespace export must violate the canonical manifest",
  );
});

test("selection hook keeps the exact raw inputs, memo graph, and terminal merge", () => {
  const sourceFile = parse("useCatalogSelectionHydration.ts", sources.selection);
  const hook = directFunction(sourceFile, "useCatalogSelectionHydration");
  assert.ok(hook.body);
  assert.equal(hook.parameters.length, 1);
  const parameter = hook.parameters[0];
  assert.ok(ts.isObjectBindingPattern(parameter.name));
  assert.deepEqual(
    parameter.name.elements.map((element) => {
      assert.equal(element.dotDotDotToken, undefined);
      assert.equal(element.propertyName, undefined);
      assert.ok(ts.isIdentifier(element.name));
      return element.name.text;
    }),
    [
      "terminals",
      "discoveredTerminals",
      "sessions",
      "hosts",
      "selection",
      "pendingCatalogSelection",
      "catalogRefreshGeneration",
      "terminalPersistenceHydrationGeneration",
      "hostsHydrationGeneration",
      "failedSessionHostIds",
      "failedTerminalHostIds",
      "setSelection",
      "setPendingCatalogSelection",
    ],
  );

  assert.equal(callsWithPath(hook.body, "useMemo").length, 2);
  assert.equal(callsWithPath(hook.body, "useEffect").length, 1);
  assert.equal(callsWithPath(hook.body, "useState").length, 0);

  const allTerminals = directVariable(hook.body, "allTerminals");
  assert.ok(allTerminals.initializer && ts.isCallExpression(allTerminals.initializer));
  assert.equal(expressionPath(allTerminals.initializer.expression), "useMemo");
  assert.deepEqual(callDependencies(allTerminals.initializer, sourceFile), [
    "terminals",
    "discoveredTerminals",
  ]);
  const merge = allTerminals.initializer.arguments[0];
  assert.ok(ts.isArrowFunction(merge) && ts.isBlock(merge.body));
  assert.equal(merge.body.statements.length, 2);
  const persistedKeys = merge.body.statements[0];
  assert.ok(ts.isVariableStatement(persistedKeys));
  assert.equal(
    compact(persistedKeys.declarationList.declarations[0].initializer!, sourceFile),
    "newSet(terminals.map(terminalSessionKey))",
  );
  const mergeReturn = merge.body.statements[1];
  assert.ok(ts.isReturnStatement(mergeReturn));
  assert.ok(mergeReturn.expression && ts.isArrayLiteralExpression(mergeReturn.expression));
  assert.equal(mergeReturn.expression.elements.length, 2);
  const [persistedSpread, discoveredSpread] = mergeReturn.expression.elements;
  assert.ok(ts.isSpreadElement(persistedSpread));
  assert.equal(compact(persistedSpread.expression, sourceFile), "terminals");
  assert.ok(ts.isSpreadElement(discoveredSpread));
  assert.equal(
    compact(discoveredSpread.expression, sourceFile),
    "discoveredTerminals.filter((terminal)=>!isLocalDiscoveredInternalTerminal(terminal)).filter((terminal)=>!persistedKeys.has(terminalSessionKey(terminal))).map(normalizePlainTerminal)",
  );

  const resolution = directVariable(hook.body, "catalogSelectionResolution");
  assert.ok(resolution.initializer && ts.isCallExpression(resolution.initializer));
  assert.equal(expressionPath(resolution.initializer.expression), "useMemo");
  assert.deepEqual(callDependencies(resolution.initializer, sourceFile), [
    "allTerminals",
    "catalogRefreshGeneration",
    "hosts",
    "hostsHydrationGeneration",
    "failedSessionHostIds",
    "failedTerminalHostIds",
    "pendingCatalogSelection",
    "selection",
    "sessions",
    "terminalPersistenceHydrationGeneration",
  ]);
  const resolve = resolution.initializer.arguments[0];
  assert.ok(ts.isArrowFunction(resolve) && ts.isCallExpression(resolve.body));
  assert.equal(expressionPath(resolve.body.expression), "reconcileCatalogSelection");
  assert.equal(resolve.body.arguments.length, 1);
  const options = resolve.body.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options));
  const resolutionOptions = directObjectProperties(options);
  assert.deepEqual(resolutionOptions.names, [
    "selection",
    "pendingSelection",
    "hydration",
    "sessions",
    "terminals",
    "hostIds",
    "failedSessionHostIds",
    "failedTerminalHostIds",
  ]);
  const exactResolutionInitializers = new Map<string, string>([
    ["selection", "selection"],
    ["pendingSelection", "pendingCatalogSelection"],
    ["sessions", "sessions"],
    ["terminals", "allTerminals"],
    ["hostIds", "newSet(hosts.map((host)=>host.id))"],
    ["failedSessionHostIds", "newSet(failedSessionHostIds)"],
    ["failedTerminalHostIds", "newSet(failedTerminalHostIds)"],
  ]);
  assert.deepEqual(
    [...exactResolutionInitializers.keys(), "hydration"].sort(),
    [...resolutionOptions.names].sort(),
  );
  for (const [name, expected] of exactResolutionInitializers) {
    assert.equal(
      compact(propertyInitializer(resolutionOptions.byName.get(name)), sourceFile),
      expected,
    );
  }
  const hydration = propertyInitializer(resolutionOptions.byName.get("hydration"));
  assert.ok(ts.isObjectLiteralExpression(hydration));
  const hydrationProperties = directObjectProperties(hydration);
  assert.deepEqual(hydrationProperties.names, [
    "refreshGeneration",
    "terminalPersistenceGeneration",
    "hostGeneration",
  ]);
  const exactHydrationInitializers = new Map<string, string>([
    ["refreshGeneration", "catalogRefreshGeneration"],
    [
      "terminalPersistenceGeneration",
      "terminalPersistenceHydrationGeneration",
    ],
    ["hostGeneration", "hostsHydrationGeneration"],
  ]);
  assert.deepEqual(
    [...exactHydrationInitializers.keys()].sort(),
    [...hydrationProperties.names].sort(),
  );
  for (const [name, expected] of exactHydrationInitializers) {
    assert.equal(
      compact(propertyInitializer(hydrationProperties.byName.get(name)), sourceFile),
      expected,
    );
  }
});

test("reconciliation updates pending before committed selection and returns exact derivations", () => {
  const sourceFile = parse("useCatalogSelectionHydration.ts", sources.selection);
  const hook = directFunction(sourceFile, "useCatalogSelectionHydration");
  assert.ok(hook.body);
  const effects = directCalls(hook.body, "useEffect");
  assert.equal(effects.length, 1);
  assert.deepEqual(callDependencies(effects[0].call, sourceFile), [
    "catalogSelectionResolution",
    "pendingCatalogSelection",
    "selection",
  ]);
  const callback = effects[0].call.arguments[0];
  assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  assert.equal(callback.body.statements.length, 2);
  const [pendingUpdate, selectionUpdate] = callback.body.statements;
  assert.ok(ts.isIfStatement(pendingUpdate) && ts.isBlock(pendingUpdate.thenStatement));
  assert.equal(
    compact(pendingUpdate.expression, sourceFile),
    "pendingCatalogSelection!==catalogSelectionResolution.pendingSelection",
  );
  assert.equal(pendingUpdate.thenStatement.statements.length, 1);
  const pendingCalls = [directCallStatement(
    pendingUpdate.thenStatement.statements[0],
    "setPendingCatalogSelection",
  )];
  assert.equal(
    compact(pendingCalls[0].arguments[0], sourceFile),
    "catalogSelectionResolution.pendingSelection",
  );

  assert.ok(ts.isIfStatement(selectionUpdate) && ts.isBlock(selectionUpdate.thenStatement));
  assert.equal(
    compact(selectionUpdate.expression, sourceFile),
    "!sameCatalogSelection(selection,catalogSelectionResolution.selection)",
  );
  assert.equal(selectionUpdate.thenStatement.statements.length, 1);
  const selectionCalls = [directCallStatement(
    selectionUpdate.thenStatement.statements[0],
    "setSelection",
  )];
  assert.equal(
    compact(selectionCalls[0].arguments[0], sourceFile),
    "catalogSelectionResolution.selection",
  );

  assert.equal(
    compact(directVariable(hook.body, "selectedSession").initializer!, sourceFile),
    'selection?.kind==="session"?sessions.find((session)=>session.name===selection.name)??null:null',
  );
  assert.equal(
    compact(directVariable(hook.body, "selectedTerminal").initializer!, sourceFile),
    'selection?.kind==="terminal"?allTerminals.find((terminal)=>terminal.id===selection.id)??null:null',
  );
  assert.equal(
    compact(
      directVariable(hook.body, "selectionMetadataPending").initializer!,
      sourceFile,
    ),
    "catalogSelectionResolution.metadataPending",
  );
  assert.doesNotMatch(
    compact(directVariable(hook.body, "selectedSession").initializer!, sourceFile),
    /catalogSelectionResolution/,
  );
  assert.doesNotMatch(
    compact(directVariable(hook.body, "selectedTerminal").initializer!, sourceFile),
    /catalogSelectionResolution/,
  );

  const returns = hook.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1);
  assert.ok(returns[0].expression && ts.isObjectLiteralExpression(returns[0].expression));
  const returnProperties = directObjectProperties(returns[0].expression);
  assert.deepEqual(returnProperties.names, [
    "allTerminals",
    "selectedSession",
    "selectedTerminal",
    "selectionMetadataPending",
  ]);
  for (const name of returnProperties.names) {
    assert.equal(
      compact(propertyInitializer(returnProperties.byName.get(name)), sourceFile),
      name,
    );
  }

  const returnIndices = hook.body.statements.flatMap((statement, index) =>
    ts.isReturnStatement(statement) ? [index] : []
  );
  assert.equal(returnIndices.length, 1);
  const topLevelOrder: Array<[string, number]> = [
    ["allTerminals memo", directVariableIndex(hook.body, "allTerminals")],
    [
      "catalogSelectionResolution memo",
      directVariableIndex(hook.body, "catalogSelectionResolution"),
    ],
    ["reconcile effect", effects[0].index],
    ["selectedSession", directVariableIndex(hook.body, "selectedSession")],
    ["selectedTerminal", directVariableIndex(hook.body, "selectedTerminal")],
    [
      "selectionMetadataPending",
      directVariableIndex(hook.body, "selectionMetadataPending"),
    ],
    ["return", returnIndices[0]],
  ];
  for (let index = 1; index < topLevelOrder.length; index += 1) {
    const [previousLabel, previousIndex] = topLevelOrder[index - 1];
    const [label, statementIndex] = topLevelOrder[index];
    assert.ok(
      previousIndex < statementIndex,
      `${previousLabel} must remain before ${label}`,
    );
  }
});

test("App leaves selection state local and preserves reconciliation as global effect 19", () => {
  const appFile = parse("App.tsx", sources.app);
  const { app, call, index: selectionIndex } = locateAppSelectionCall(appFile);
  assert.ok(app.body);
  assert.equal(call.arguments.length, 1);
  const callOptions = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(callOptions));
  const appOptions = directObjectProperties(callOptions);
  assert.deepEqual(appOptions.names, [
    "terminals",
    "discoveredTerminals",
    "sessions",
    "hosts",
    "selection",
    "pendingCatalogSelection",
    "catalogRefreshGeneration",
    "terminalPersistenceHydrationGeneration",
    "hostsHydrationGeneration",
    "failedSessionHostIds",
    "failedTerminalHostIds",
    "setSelection",
    "setPendingCatalogSelection",
  ]);
  for (const name of appOptions.names) {
    assert.equal(
      compact(propertyInitializer(appOptions.byName.get(name)), appFile),
      name,
    );
  }

  const canonicalImports = appFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text ===
        "./dashboard/hooks/useCatalogSelectionHydration",
  );
  assert.equal(canonicalImports.length, 1);
  assert.ok(canonicalImports[0].importClause?.namedBindings);
  assert.ok(ts.isNamedImports(canonicalImports[0].importClause.namedBindings));
  assert.deepEqual(
    canonicalImports[0].importClause.namedBindings.elements.map((element) => ({
      imported: element.propertyName?.text ?? element.name.text,
      local: element.name.text,
      typeOnly: canonicalImports[0].importClause!.isTypeOnly || element.isTypeOnly,
    })),
    [{
      imported: "useCatalogSelectionHydration",
      local: "useCatalogSelectionHydration",
      typeOnly: false,
    }],
  );

  for (const [stateName, setterName] of [
    ["selection", "setSelection"],
    ["pendingCatalogSelection", "setPendingCatalogSelection"],
  ] as const) {
    const state = directStateVariable(app.body, stateName);
    assert.ok(ts.isArrayBindingPattern(state.name));
    assert.deepEqual(bindingNames(state.name), [stateName, setterName]);
    assert.ok(state.initializer && ts.isCallExpression(state.initializer));
    assert.equal(expressionPath(state.initializer.expression), "useState");
  }
  assert.equal(callsWithPath(app.body, "reconcileCatalogSelection").length, 0);
  assert.equal(callsWithPath(app.body, "sameCatalogSelection").length, 0);
  assert.equal(callsWithPath(app.body, "normalizePlainTerminal").length, 0);
  assert.equal(callsWithPath(app.body, "isLocalDiscoveredInternalTerminal").length, 0);

  const appEffects = directCalls(app.body, "useEffect");
  const layoutHydrationPhases = directTopLevelCalls(
    app.body,
    "useDashboardLayoutHydrationPhase",
  );
  const relayEffects = appEffects.filter(({ call: effect }) =>
    directCalls(effectCallbackBlock(effect), "mobileRelay.setPopoverOpen").length === 1
  );
  const previewPhases = directTopLevelCalls(app.body, "useTerminalDeckPreviewPhase");
  const polling = directCalls(app.body, "useVisibilityAwarePolling");
  assert.equal(layoutHydrationPhases.length, 1);
  assert.equal(relayEffects.length, 1);
  assert.equal(previewPhases.length, 1);
  assert.equal(polling.length, 1);
  const previewFunction = directFunction(
    parse("useTerminalDeckState.ts", sources.terminalDeck),
    "useTerminalDeckPreviewPhase",
  );
  assert.ok(previewFunction.body);
  const previewEffects = directCalls(previewFunction.body, "useEffect");
  assert.equal(previewEffects.length, 1);
  assert.deepEqual(callDependencies(previewEffects[0].call, previewFunction.getSourceFile()), [
    "sessions",
    "allTerminals",
  ]);
  assert.ok(layoutHydrationPhases[0].index < selectionIndex);
  assert.ok(relayEffects[0].index < selectionIndex);
  assert.ok(selectionIndex < previewPhases[0].index);
  assert.ok(previewPhases[0].index < polling[0].index);

  for (const hookName of [
    "useConnectionCatalog",
    "useMobileRelayController",
    "useTerminalDeckState",
    "useDashboardLayoutState",
    "useDashboardViewportResizePhase",
    "useDashboardWindowCapturePhase",
    "useDashboardLayoutHydrationPhase",
    "useDashboardLayoutPersistencePhase",
    "useTerminalMetadataHydrationPhase",
    "useTerminalMetadataPersistencePhase",
    "useAutomationWorkspace",
    "useAutomationWorkspaceOwnerPhase",
    "useAutomationWorkspaceHydrationPhase",
  ]) {
    const directRegistrations = directTopLevelCalls(app.body, hookName);
    assert.equal(
      directRegistrations.length,
      1,
      `${hookName} must have exactly one direct App call`,
    );
    assert.equal(
      callsWithPath(app.body, hookName).length,
      1,
      `${hookName} cannot have hidden duplicate calls`,
    );
    assert.ok(
      directRegistrations[0].index < selectionIndex,
      `${hookName} must register before catalog selection hydration`,
    );
  }

  const pollingFile = parse("useVisibilityAwarePolling.ts", sources.polling);
  const pollingHook = directFunction(pollingFile, "useVisibilityAwarePolling");
  assert.ok(pollingHook.body);
  const pollingEffectCount = directCalls(pollingHook.body, "useEffect").length;
  assert.equal(pollingEffectCount, 1);
  const effectContribution = (source: string, name: string) => {
    const sourceFile = parse(`${name}.ts`, source);
    const fn = directFunction(sourceFile, name);
    assert.ok(fn.body);
    return directCalls(fn.body, "useEffect").length +
      directCalls(fn.body, "useVisibilityAwarePolling").length *
        pollingEffectCount;
  };
  const directAppEffectsBefore = appEffects.filter(
    ({ index }) => index < selectionIndex,
  ).length;
  const effectsBeforeSelection = directAppEffectsBefore +
    effectContribution(sources.connection, "useConnectionCatalog") +
    effectContribution(sources.relay, "useMobileRelayController") +
    effectContribution(sources.terminalDeck, "useTerminalDeckState") +
    effectContribution(sources.layout, "useDashboardViewportResizePhase") +
    effectContribution(sources.layout, "useDashboardWindowCapturePhase") +
    effectContribution(sources.layout, "useDashboardLayoutHydrationPhase") +
    effectContribution(sources.layout, "useDashboardLayoutPersistencePhase") +
    effectContribution(sources.metadata, "useTerminalMetadataHydrationPhase") +
    effectContribution(sources.metadata, "useTerminalMetadataPersistencePhase") +
    effectContribution(sources.automation, "useAutomationWorkspace") +
    effectContribution(sources.automation, "useAutomationWorkspaceOwnerPhase") +
    effectContribution(sources.automation, "useAutomationWorkspaceHydrationPhase");
  assert.equal(directAppEffectsBefore, 3);
  assert.equal(effectsBeforeSelection, 18);
  const selectionEffectNumber = effectsBeforeSelection + callsWithPath(
      directFunction(
        parse("useCatalogSelectionHydration.ts", sources.selection),
        "useCatalogSelectionHydration",
      ).body!,
      "useEffect",
    ).length;
  assert.equal(selectionEffectNumber, 19);
  assert.equal(
    selectionEffectNumber + previewEffects.length,
    20,
    "the preview phase must contribute global effect 20",
  );

  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const layoutHydration = directFunction(
    layoutFile,
    "useDashboardLayoutHydrationPhase",
  );
  assert.ok(layoutHydration.body);
  const layoutHydrationEffects = directCalls(layoutHydration.body, "useEffect");
  assert.equal(layoutHydrationEffects.length, 1);
  const restoredSelectionBranches: ts.IfStatement[] = [];
  visit(effectCallbackBlock(layoutHydrationEffects[0].call), (node) => {
    if (
      ts.isIfStatement(node) &&
      compact(node.expression, layoutFile) === "lay.selection!==undefined"
    ) {
      restoredSelectionBranches.push(node);
    }
  });
  assert.equal(restoredSelectionBranches.length, 1);
  const restoredBranch = restoredSelectionBranches[0].thenStatement;
  assert.ok(ts.isBlock(restoredBranch));
  assert.equal(restoredBranch.statements.length, 2);
  const restorePending = directCallStatement(
    restoredBranch.statements[0],
    "setPendingCatalogSelection",
  );
  assert.equal(restorePending.arguments.length, 1);
  const restoredPendingValue = restorePending.arguments[0];
  assert.ok(ts.isCallExpression(restoredPendingValue));
  assert.equal(
    expressionPath(restoredPendingValue.expression),
    "pendingRestoredCatalogSelection",
  );
  assert.equal(restoredPendingValue.arguments.length, 2);
  assert.equal(expressionPath(restoredPendingValue.arguments[0]), "lay.selection");
  assert.ok(ts.isCallExpression(restoredPendingValue.arguments[1]));
  assert.equal(
    expressionPath(restoredPendingValue.arguments[1].expression),
    "getLatestSuccessfulRefreshGeneration",
  );
  assert.equal(restoredPendingValue.arguments[1].arguments.length, 0);
  const restoreSelection = directCallStatement(
    restoredBranch.statements[1],
    "setSelection",
  );
  assert.equal(compact(restoreSelection.arguments[0], layoutFile), "lay.selection");
});

test("App call guard rejects nested, duplicate-key, and spread decoys", () => {
  assert.throws(() => locateAppSelectionCall(parse("nested.tsx", `
    function App() {
      function nested() {
        const value = useCatalogSelectionHydration({ selection });
      }
    }
  `)), /directly call/);

  for (const options of [
    "{ selection, selection }",
    "{ ...options, selection }",
  ]) {
    const sourceFile = parse("options.tsx", `
      function App() {
        const {
          allTerminals,
          selectedSession,
          selectedTerminal,
          selectionMetadataPending,
        } = useCatalogSelectionHydration(${options});
      }
    `);
    const located = locateAppSelectionCall(sourceFile);
    assert.throws(
      () => directObjectProperties(located.call.arguments[0] as ts.ObjectLiteralExpression),
      /duplicate property|object spreads/,
    );
  }
});
