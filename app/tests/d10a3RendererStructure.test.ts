import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  layout: readFileSync(
    new URL("../src/dashboard/hooks/useDashboardLayout.ts", import.meta.url),
    "utf8",
  ),
  connection: readFileSync(
    new URL("../src/dashboard/hooks/useConnectionCatalog.ts", import.meta.url),
    "utf8",
  ),
  relay: readFileSync(
    new URL("../src/dashboard/hooks/useMobileRelayController.ts", import.meta.url),
    "utf8",
  ),
  metadata: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalMetadata.ts", import.meta.url),
    "utf8",
  ),
  selection: readFileSync(
    new URL("../src/dashboard/hooks/useCatalogSelectionHydration.ts", import.meta.url),
    "utf8",
  ),
  polling: readFileSync(
    new URL("../src/dashboard/hooks/useVisibilityAwarePolling.ts", import.meta.url),
    "utf8",
  ),
  workspace: readFileSync(
    new URL("../src/dashboard/hooks/useWorkspaceCatalog.ts", import.meta.url),
    "utf8",
  ),
  deck: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
    "utf8",
  ),
  backendContext: readFileSync(
    new URL("../src/platform/DashboardBackendContext.tsx", import.meta.url),
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

function hookPathLeaf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
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
    if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
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
    assert.fail(`unsupported exported declaration: ${ts.SyntaxKind[statement.kind]}`);
  }
  return exports;
}

const layoutExports = [
  "useDashboardLayoutHydrationPhase",
  "useDashboardLayoutPersistencePhase",
  "useDashboardLayoutState",
  "useDashboardViewportResizePhase",
  "useDashboardWindowCapturePhase",
] as const;

function assertExactCanonicalExport(sourceFile: ts.SourceFile): void {
  const actual = exportedNames(sourceFile).map(({ name }) => name);
  assert.equal(new Set(actual).size, actual.length, "duplicate exports are forbidden");
  assert.deepEqual([...actual].sort(), [...layoutExports].sort());
  assert.equal(
    sourceFile.statements.filter(
      (statement) =>
        ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
    ).length,
    0,
    "the canonical owner cannot be a facade",
  );
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

function assertNoIndirectModuleEdges(sourceFile: ts.SourceFile): void {
  assert.deepEqual(sourceFile.referencedFiles, []);
  assert.deepEqual(sourceFile.typeReferenceDirectives, []);
  assert.deepEqual(sourceFile.libReferenceDirectives, []);
  const forbidden: string[] = [];
  visit(sourceFile, (node) => {
    if (ts.isImportEqualsDeclaration(node)) forbidden.push("import-equals");
    if (ts.isImportTypeNode(node)) forbidden.push("import-type");
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        expressionPath(node.expression) === "require")
    ) {
      forbidden.push("dynamic-module-edge");
    }
  });
  assert.deepEqual(forbidden, []);
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

function callsWithPath(root: ts.Node, path: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) {
      matches.push(node);
    }
  });
  return matches;
}

function callsWithHookLeaf(root: ts.Node, leaf: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (!ts.isCallExpression(node)) return;
    const path = expressionPath(node.expression);
    if (path && hookPathLeaf(path) === leaf) matches.push(node);
  });
  return matches;
}

function directTopLevelCalls(
  body: ts.Block,
  path: string,
): Array<{ call: ts.CallExpression; index: number; declaration?: ts.VariableDeclaration }> {
  const matches: Array<{
    call: ts.CallExpression;
    index: number;
    declaration?: ts.VariableDeclaration;
  }> = [];
  for (const [index, statement] of body.statements.entries()) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      if (expressionPath(statement.expression.expression) === path) {
        matches.push({ call: statement.expression, index });
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        expressionPath(declaration.initializer.expression) === path
      ) {
        matches.push({ call: declaration.initializer, index, declaration });
      }
    }
  }
  return matches;
}

function directCallNodes(body: ts.Block): Set<ts.CallExpression> {
  const calls = new Set<ts.CallExpression>();
  for (const statement of body.statements) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      calls.add(statement.expression);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && ts.isCallExpression(declaration.initializer)) {
        calls.add(declaration.initializer);
      }
    }
  }
  return calls;
}

function hookCalleeCall(identifier: ts.Identifier): ts.CallExpression | null {
  let expression: ts.Expression = identifier;
  while (
    ts.isPropertyAccessExpression(expression.parent) &&
    (expression.parent.expression === expression || expression.parent.name === expression)
  ) {
    expression = expression.parent;
  }
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression
    ? expression.parent
    : null;
}

function assertHooksAreDirect(body: ts.Block): void {
  const direct = directCallNodes(body);
  visit(body, (node) => {
    if (!ts.isIdentifier(node) || !/^use[A-Z]/.test(node.text)) return;
    const call = hookCalleeCall(node);
    assert.ok(call, `hook ${node.text} cannot be referenced through an alias`);
    assert.ok(direct.has(call), `hook ${node.text} must be a direct top-level call`);
  });
}

function assertNoHookImportAliases(sourceFile: ts.SourceFile): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (/^use[A-Z]/.test(imported)) assert.equal(element.name.text, imported);
    }
  }
}

function uniqueDirectCall(body: ts.Block, path: string): {
  call: ts.CallExpression;
  index: number;
  declaration?: ts.VariableDeclaration;
} {
  const matches = directTopLevelCalls(body, path);
  assert.equal(matches.length, 1, `${path} must be a direct App call`);
  assert.equal(callsWithPath(body, path).length, 1, `${path} cannot be hidden or duplicated`);
  return matches[0];
}

function directVariable(body: ts.Block, name: string): ts.VariableDeclaration {
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

function directVariableWithBinding(
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
  assert.equal(matches.length, 1, `expected one direct binding ${name}`);
  return matches[0];
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

function functionExpressionBody(expression: ts.Expression): ts.Block {
  assert.ok(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression));
  assert.ok(ts.isBlock(expression.body));
  return expression.body;
}

function effectAnalysis(
  sourceFile: ts.SourceFile,
  functionName: string,
): { fn: ts.FunctionDeclaration; call: ts.CallExpression; body: ts.Block } {
  const fn = directFunction(sourceFile, functionName);
  assert.ok(fn.body);
  assertHooksAreDirect(fn.body);
  const allEffects = callsWithHookLeaf(fn.body, "useEffect");
  assert.equal(allEffects.length, 1, `${functionName} must own exactly one effect`);
  const direct = directTopLevelCalls(fn.body, "useEffect");
  assert.equal(direct.length, 1, `${functionName} effect must be direct and unconditional`);
  assert.equal(direct[0].call, allEffects[0]);
  const body = functionExpressionBody(direct[0].call.arguments[0]);
  return { fn, call: direct[0].call, body };
}

function effectDependencies(call: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  assert.equal(call.arguments.length, 2);
  const dependencies = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  return dependencies.elements.map((element) => element.getText(sourceFile));
}

function chainedCall(call: ts.CallExpression, method: string): ts.CallExpression {
  assert.ok(ts.isPropertyAccessExpression(call.expression));
  assert.equal(call.expression.name.text, method);
  assert.ok(ts.isCallExpression(call.expression.expression));
  return call.expression.expression;
}

function arrowBlockArgument(call: ts.CallExpression): ts.Block {
  assert.equal(call.arguments.length, 1);
  return functionExpressionBody(call.arguments[0]);
}

function assertNamedImportFromApp(appFile: ts.SourceFile): void {
  assertNoHookImportAliases(appFile);
  const imports = appFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./dashboard/hooks/useDashboardLayout",
  );
  assert.equal(imports.length, 1);
  const bindings = imports[0].importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  assert.deepEqual(
    bindings.elements.map((element) => ({
      imported: element.propertyName?.text ?? element.name.text,
      local: element.name.text,
      typeOnly: imports[0].importClause!.isTypeOnly || element.isTypeOnly,
    })),
    layoutExports.map((name) => ({ imported: name, local: name, typeOnly: false })),
  );
}

test("dashboard layout state has one canonical owner and the frozen state/ref API", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  assertExactCanonicalExport(layoutFile);
  assertNoIndirectModuleEdges(layoutFile);
  assertNoHookImportAliases(layoutFile);
  assert.deepEqual(importManifest(layoutFile), [
    "../../platform|DashboardBackend|DashboardBackend|type",
    "../../platform|DashboardWindow|DashboardWindow|type",
    "../layout/panelGeometry|DEFAULT_INSPECTOR_WIDTH|DEFAULT_INSPECTOR_WIDTH|value",
    "../layout/panelGeometry|DEFAULT_SIDEBAR_WIDTH|DEFAULT_SIDEBAR_WIDTH|value",
    "../layout/panelGeometry|normalizeDashboardPanelWidths|normalizeDashboardPanelWidths|value",
    "../layout/panelGeometry|viewportTierForWidth|viewportTierForWidth|value",
    "../layout/schema|DEFAULT_COLUMN_ORDER|DEFAULT_COLUMN_ORDER|value",
    "../layout/scratchGeometry|DEFAULT_SCRATCH_PANEL_WIDTH|DEFAULT_SCRATCH_PANEL_WIDTH|value",
    "../layout/scratchGeometry|clampScratchPanelWidth|clampScratchPanelWidth|value",
    "../layout/types|DiffFile|DiffFile|type",
    "../layout/types|EditingFile|EditingFile|type",
    "../layout/types|SidebarView|SidebarView|type",
    "../layout/types|ViewportTier|ViewportTier|type",
    "../layout/types|WindowLayout|WindowLayout|type",
    "../model/selection|PendingCatalogSelection|PendingCatalogSelection|type",
    "../model/selection|PinnedItem|PinnedItem|type",
    "../model/selection|Selection|Selection|type",
    "../model/selection|pendingRestoredCatalogSelection|pendingRestoredCatalogSelection|value",
    "./useLayoutPreferences|useLayoutPreferences|useLayoutPreferences|value",
    "react|Dispatch|Dispatch|type",
    "react|SetStateAction|SetStateAction|type",
    "react|useEffect|useEffect|value",
    "react|useRef|useRef|value",
    "react|useState|useState|value",
  ].sort());

  const reachable = readRendererImplementationFiles();
  assert.ok(reachable.some(({ path }) => path === "dashboard/hooks/useDashboardLayout.ts"));
  for (const name of layoutExports) {
    const owners = reachable.flatMap(({ path, source }) =>
      exportedNames(parse(path, source)).some(
          (entry) => entry.runtime && entry.name === name,
        )
        ? [path]
        : []
    );
    assert.deepEqual(owners, ["dashboard/hooks/useDashboardLayout.ts"]);
  }

  const state = directFunction(layoutFile, "useDashboardLayoutState");
  assert.ok(state.body);
  assertHooksAreDirect(state.body);
  assert.equal(callsWithHookLeaf(state.body, "useEffect").length, 0);
  assert.equal(callsWithPath(state.body, "useLayoutPreferences").length, 1);
  const preferences = directVariableWithBinding(state.body, "loadLayoutPreferences");
  assert.deepEqual(bindingNames(preferences.name), [
    "loadLayoutPreferences",
    "saveLayoutPreferences",
  ]);
  assert.ok(preferences.initializer && ts.isCallExpression(preferences.initializer));
  assert.equal(expressionPath(preferences.initializer.expression), "useLayoutPreferences");
  assert.equal(preferences.initializer.arguments.length, 0);

  const stateInitializers = new Map([
    ["sessionOrder", "[]"],
    ["collapsedProjects", "[]"],
    ["pinnedItems", "[]"],
    ["automationSectionCollapsed", "true"],
    ["scratchCollapsed", "true"],
    ["scratchWidth", "DEFAULT_SCRATCH_PANEL_WIDTH"],
    ["sidebarWidth", "DEFAULT_SIDEBAR_WIDTH"],
    ["inspectorWidth", "DEFAULT_INSPECTOR_WIDTH"],
    ["sidebarOpen", "()=>window.innerWidth>=960"],
    ["inspectorOpen", "()=>window.innerWidth>=1440"],
    ["sidebarView", '"workspaces"'],
    ["viewportTier", "()=>viewportTierForWidth(window.innerWidth)"],
    ["windowLayout", "null"],
    ["windowRestoreReady", "false"],
  ]);
  const stateSetters = new Map([
    ["sessionOrder", "setSessionOrder"],
    ["collapsedProjects", "setCollapsedProjects"],
    ["pinnedItems", "setPinnedItems"],
    ["automationSectionCollapsed", "setAutomationSectionCollapsed"],
    ["scratchCollapsed", "setScratchCollapsed"],
    ["scratchWidth", "setScratchWidth"],
    ["sidebarWidth", "setSidebarWidth"],
    ["inspectorWidth", "setInspectorWidth"],
    ["sidebarOpen", "setSidebarOpen"],
    ["inspectorOpen", "setInspectorOpen"],
    ["sidebarView", "setSidebarView"],
    ["viewportTier", "setViewportTier"],
    ["windowLayout", "setWindowLayout"],
    ["windowRestoreReady", "setWindowRestoreReady"],
  ]);
  assert.equal(callsWithPath(state.body, "useState").length, stateInitializers.size);
  for (const [name, expected] of stateInitializers) {
    const declaration = directVariableWithBinding(state.body, name);
    assert.ok(ts.isArrayBindingPattern(declaration.name));
    assert.deepEqual(bindingNames(declaration.name), [name, stateSetters.get(name)]);
    assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
    assert.equal(expressionPath(declaration.initializer.expression), "useState");
    assert.equal(declaration.initializer.arguments.length, 1);
    assert.equal(compact(declaration.initializer.arguments[0], layoutFile), expected);
  }

  const refInitializers = new Map([
    [
      "panelWidthsRef",
      "{sidebarWidth:DEFAULT_SIDEBAR_WIDTH,inspectorWidth:DEFAULT_INSPECTOR_WIDTH,}",
    ],
    ["sidebarOpenPreferenceRef", "window.innerWidth>=960"],
    ["inspectorOpenPreferenceRef", "window.innerWidth>=1440"],
    ["dashboardWorkspaceRef", "null"],
    ["layoutLoadedRef", "false"],
  ]);
  assert.equal(callsWithPath(state.body, "useRef").length, refInitializers.size);
  for (const [name, expected] of refInitializers) {
    const declaration = directVariable(state.body, name);
    assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
    assert.equal(expressionPath(declaration.initializer.expression), "useRef");
    assert.equal(declaration.initializer.arguments.length, 1);
    assert.equal(compact(declaration.initializer.arguments[0], layoutFile), expected);
  }

  const perRenderAssignments = state.body.statements.filter(
    (statement): statement is ts.ExpressionStatement =>
      ts.isExpressionStatement(statement) &&
      compact(statement.expression, layoutFile) ===
        "panelWidthsRef.current={sidebarWidth,inspectorWidth}",
  );
  assert.equal(perRenderAssignments.length, 1);

  const returns = state.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1);
  assert.ok(returns[0].expression && ts.isObjectLiteralExpression(returns[0].expression));
  const returned = directObjectProperties(returns[0].expression);
  const expectedReturn = [
    "sessionOrder",
    "setSessionOrder",
    "collapsedProjects",
    "setCollapsedProjects",
    "pinnedItems",
    "setPinnedItems",
    "automationSectionCollapsed",
    "setAutomationSectionCollapsed",
    "scratchCollapsed",
    "setScratchCollapsed",
    "scratchWidth",
    "setScratchWidth",
    "sidebarWidth",
    "setSidebarWidth",
    "inspectorWidth",
    "setInspectorWidth",
    "sidebarOpen",
    "setSidebarOpen",
    "inspectorOpen",
    "setInspectorOpen",
    "sidebarView",
    "setSidebarView",
    "viewportTier",
    "setViewportTier",
    "windowLayout",
    "setWindowLayout",
    "windowRestoreReady",
    "setWindowRestoreReady",
    "panelWidthsRef",
    "sidebarOpenPreferenceRef",
    "inspectorOpenPreferenceRef",
    "dashboardWorkspaceRef",
    "layoutLoadedRef",
    "loadLayoutPreferences",
    "saveLayoutPreferences",
  ];
  assert.deepEqual(returned.names, expectedReturn);
  for (const name of expectedReturn) {
    assert.equal(compact(propertyInitializer(returned.byName.get(name)), layoutFile), name);
  }
});

function assertAppLayoutWiring(appFile: ts.SourceFile): {
  app: ts.FunctionDeclaration;
  indices: Record<string, number>;
} {
  const app = directFunction(appFile, "App");
  assert.ok(app.body);
  assertHooksAreDirect(app.body);
  assertNamedImportFromApp(appFile);

  const stateCalls = directTopLevelCalls(app.body, "useDashboardLayoutState");
  assert.equal(stateCalls.length, 1);
  assert.equal(callsWithPath(app.body, "useDashboardLayoutState").length, 1);
  assert.ok(stateCalls[0].declaration);
  assert.ok(ts.isIdentifier(stateCalls[0].declaration.name));
  assert.equal(stateCalls[0].declaration.name.text, "dashboardLayout");
  assert.equal(stateCalls[0].call.arguments.length, 0);

  const layoutBindings = app.body.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.filter(
      (declaration) =>
        ts.isObjectBindingPattern(declaration.name) &&
        declaration.initializer?.getText(appFile) === "dashboardLayout",
    );
  });
  assert.equal(layoutBindings.length, 1);
  assert.ok(ts.isObjectBindingPattern(layoutBindings[0].name));
  assert.deepEqual(
    layoutBindings[0].name.elements.map((element) => {
      assert.ok(!element.dotDotDotToken);
      assert.ok(ts.isIdentifier(element.name));
      assert.equal(element.propertyName, undefined);
      return element.name.text;
    }),
    [
      "sessionOrder",
      "setSessionOrder",
      "collapsedProjects",
      "setCollapsedProjects",
      "pinnedItems",
      "setPinnedItems",
      "automationSectionCollapsed",
      "setAutomationSectionCollapsed",
      "scratchCollapsed",
      "setScratchCollapsed",
      "scratchWidth",
      "setScratchWidth",
      "sidebarWidth",
      "setSidebarWidth",
      "inspectorWidth",
      "setInspectorWidth",
      "sidebarOpen",
      "setSidebarOpen",
      "inspectorOpen",
      "setInspectorOpen",
      "sidebarView",
      "setSidebarView",
      "viewportTier",
      "panelWidthsRef",
      "sidebarOpenPreferenceRef",
      "inspectorOpenPreferenceRef",
      "dashboardWorkspaceRef",
    ],
  );

  const phaseSpecs = new Map<string, string[]>([
    ["useDashboardViewportResizePhase", ["dashboardLayout"]],
    ["useDashboardWindowCapturePhase", ["dashboardLayout", "dashboardBackend"]],
    [
      "useDashboardLayoutHydrationPhase",
      ["dashboardLayout", "<options>"],
    ],
    [
      "useDashboardLayoutPersistencePhase",
      ["dashboardLayout", "<options>"],
    ],
  ]);
  const indices: Record<string, number> = {};
  for (const [name, expectedArgs] of phaseSpecs) {
    const registration = uniqueDirectCall(app.body, name);
    indices[name] = registration.index;
    assert.equal(registration.call.arguments.length, expectedArgs.length);
    assert.equal(compact(registration.call.arguments[0], appFile), "dashboardLayout");
    if (expectedArgs.length === 2 && expectedArgs[1] !== "<options>") {
      assert.equal(compact(registration.call.arguments[1], appFile), expectedArgs[1]);
    }
  }

  const hydration = directTopLevelCalls(
    app.body,
    "useDashboardLayoutHydrationPhase",
  )[0].call;
  assert.ok(ts.isObjectLiteralExpression(hydration.arguments[1]));
  const hydrationOptions = directObjectProperties(hydration.arguments[1]);
  assert.deepEqual(hydrationOptions.names, [
    "dashboardBackend",
    "getLatestSuccessfulRefreshGeneration",
    "setSelection",
    "setPendingCatalogSelection",
    "setEditingFile",
    "setDiffFile",
  ]);
  for (const name of hydrationOptions.names) {
    assert.equal(compact(propertyInitializer(hydrationOptions.byName.get(name)), appFile), name);
  }

  const persistence = directTopLevelCalls(
    app.body,
    "useDashboardLayoutPersistencePhase",
  )[0].call;
  assert.ok(ts.isObjectLiteralExpression(persistence.arguments[1]));
  const persistenceOptions = directObjectProperties(persistence.arguments[1]);
  assert.deepEqual(persistenceOptions.names, ["selection", "editingFile", "diffFile"]);
  for (const name of persistenceOptions.names) {
    assert.equal(compact(propertyInitializer(persistenceOptions.byName.get(name)), appFile), name);
  }

  return { app, indices };
}

function effectContribution(source: string, functionName: string, pollingEffects = 0): number {
  const sourceFile = parse(`${functionName}.tsx`, source);
  const fn = directFunction(sourceFile, functionName);
  assert.ok(fn.body);
  return callsWithHookLeaf(fn.body, "useEffect").length +
    callsWithPath(fn.body, "useVisibilityAwarePolling").length * pollingEffects;
}

type EffectTimelineEvent = {
  path: string;
  index: number;
};

function topLevelEffectTimeline(body: ts.Block, throughIndex: number): EffectTimelineEvent[] {
  const zeroEffectBuiltins = new Set(["useCallback", "useMemo", "useRef", "useState"]);
  const events: EffectTimelineEvent[] = [];
  for (const [index, statement] of body.statements.entries()) {
    if (index > throughIndex) break;
    const calls: ts.CallExpression[] = [];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      calls.push(statement.expression);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && ts.isCallExpression(declaration.initializer)) {
          calls.push(declaration.initializer);
        }
      }
    }
    for (const call of calls) {
      const path = expressionPath(call.expression);
      if (!path) continue;
      const leaf = hookPathLeaf(path);
      if (leaf === "useEffect" || (/^use[A-Z]/.test(leaf) && !zeroEffectBuiltins.has(leaf))) {
        events.push({ path, index });
      }
    }
  }
  return events;
}

function frozenEffectContributions(): Map<string, number> {
  const pollingFile = parse("useVisibilityAwarePolling.ts", sources.polling);
  const pollingHook = directFunction(pollingFile, "useVisibilityAwarePolling");
  assert.ok(pollingHook.body);
  const pollingEffects = callsWithHookLeaf(pollingHook.body, "useEffect").length;
  assert.equal(pollingEffects, 1);
  const contributions = new Map<string, number>([
    ["useDashboardBackend", effectContribution(sources.backendContext, "useDashboardBackend")],
    ["useDashboardLayoutState", effectContribution(sources.layout, "useDashboardLayoutState")],
    ["useTerminalMetadata", effectContribution(sources.metadata, "useTerminalMetadata")],
    [
      "useConnectionCatalog",
      effectContribution(sources.connection, "useConnectionCatalog", pollingEffects),
    ],
    [
      "useMobileRelayController",
      effectContribution(sources.relay, "useMobileRelayController", pollingEffects),
    ],
    ["useTerminalDeckState", effectContribution(sources.deck, "useTerminalDeckState")],
    ["useEffect", 1],
    [
      "useDashboardViewportResizePhase",
      effectContribution(sources.layout, "useDashboardViewportResizePhase"),
    ],
    [
      "useDashboardWindowCapturePhase",
      effectContribution(sources.layout, "useDashboardWindowCapturePhase"),
    ],
    [
      "useTerminalMetadataHydrationPhase",
      effectContribution(sources.metadata, "useTerminalMetadataHydrationPhase"),
    ],
    ["useWorkspaceCatalog", effectContribution(sources.workspace, "useWorkspaceCatalog")],
    [
      "useDashboardLayoutHydrationPhase",
      effectContribution(sources.layout, "useDashboardLayoutHydrationPhase"),
    ],
    [
      "useTerminalMetadataPersistencePhase",
      effectContribution(sources.metadata, "useTerminalMetadataPersistencePhase"),
    ],
    [
      "useDashboardLayoutPersistencePhase",
      effectContribution(sources.layout, "useDashboardLayoutPersistencePhase"),
    ],
    [
      "useCatalogSelectionHydration",
      effectContribution(sources.selection, "useCatalogSelectionHydration"),
    ],
  ]);
  assert.deepEqual([...contributions], [
    ["useDashboardBackend", 0],
    ["useDashboardLayoutState", 0],
    ["useTerminalMetadata", 0],
    ["useConnectionCatalog", 4],
    ["useMobileRelayController", 3],
    ["useTerminalDeckState", 0],
    ["useEffect", 1],
    ["useDashboardViewportResizePhase", 1],
    ["useDashboardWindowCapturePhase", 1],
    ["useTerminalMetadataHydrationPhase", 1],
    ["useWorkspaceCatalog", 0],
    ["useDashboardLayoutHydrationPhase", 1],
    ["useTerminalMetadataPersistencePhase", 2],
    ["useDashboardLayoutPersistencePhase", 1],
    ["useCatalogSelectionHydration", 1],
  ]);
  return contributions;
}

function assertAppEffectTimeline(appFile: ts.SourceFile): void {
  const app = directFunction(appFile, "App");
  assert.ok(app.body);
  assertNoHookImportAliases(appFile);
  assertHooksAreDirect(app.body);
  const selection = uniqueDirectCall(app.body, "useCatalogSelectionHydration");
  const events = topLevelEffectTimeline(app.body, selection.index);
  assert.deepEqual(events.map(({ path }) => path), [
    "useDashboardBackend",
    "useDashboardLayoutState",
    "useTerminalMetadata",
    "useConnectionCatalog",
    "useMobileRelayController",
    "useTerminalDeckState",
    "useEffect",
    "useDashboardViewportResizePhase",
    "useDashboardWindowCapturePhase",
    "useTerminalMetadataHydrationPhase",
    "useWorkspaceCatalog",
    "useDashboardLayoutHydrationPhase",
    "useTerminalMetadataPersistencePhase",
    "useDashboardLayoutPersistencePhase",
    "useEffect",
    "useEffect",
    "useEffect",
    "useCatalogSelectionHydration",
  ]);
  const contributions = frozenEffectContributions();
  const phaseOrdinals = new Map<string, number>();
  let ordinal = 0;
  for (const event of events) {
    const contribution = contributions.get(event.path);
    assert.notEqual(contribution, undefined, `unknown effect contribution: ${event.path}`);
    ordinal += contribution!;
    if (event.path.startsWith("useDashboard")) phaseOrdinals.set(event.path, ordinal);
  }
  assert.equal(contributions.get("useWorkspaceCatalog"), 0);
  assert.equal(phaseOrdinals.get("useDashboardViewportResizePhase"), 9);
  assert.equal(phaseOrdinals.get("useDashboardWindowCapturePhase"), 10);
  assert.equal(phaseOrdinals.get("useDashboardLayoutHydrationPhase"), 12);
  assert.equal(phaseOrdinals.get("useDashboardLayoutPersistencePhase"), 15);
  assert.equal(ordinal, 19);
}

test("App registers the four layout phases once at global effects 9, 10, 12, and 15", () => {
  const appFile = parse("App.tsx", sources.app);
  const { app, indices } = assertAppLayoutWiring(appFile);
  assert.ok(app.body);

  const viewport = indices.useDashboardViewportResizePhase;
  const capture = indices.useDashboardWindowCapturePhase;
  const terminalHydration = directTopLevelCalls(
    app.body,
    "useTerminalMetadataHydrationPhase",
  );
  const layoutHydration = indices.useDashboardLayoutHydrationPhase;
  const terminalPersistence = directTopLevelCalls(
    app.body,
    "useTerminalMetadataPersistencePhase",
  );
  const layoutPersistence = indices.useDashboardLayoutPersistencePhase;
  const selection = directTopLevelCalls(app.body, "useCatalogSelectionHydration");
  assert.equal(terminalHydration.length, 1);
  assert.equal(terminalPersistence.length, 1);
  assert.equal(selection.length, 1);
  assert.ok(viewport < capture);
  assert.ok(capture < terminalHydration[0].index);
  assert.ok(terminalHydration[0].index < layoutHydration);
  assert.ok(layoutHydration < terminalPersistence[0].index);
  assert.ok(terminalPersistence[0].index < layoutPersistence);
  assert.ok(layoutPersistence < selection[0].index);
  assertAppEffectTimeline(appFile);

  const layoutStateNames = new Set([
    "sessionOrder",
    "collapsedProjects",
    "pinnedItems",
    "automationSectionCollapsed",
    "scratchCollapsed",
    "scratchWidth",
    "sidebarWidth",
    "inspectorWidth",
    "sidebarOpen",
    "inspectorOpen",
    "sidebarView",
    "viewportTier",
    "windowLayout",
    "windowRestoreReady",
  ]);
  for (const statement of app.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      if (expressionPath(declaration.initializer.expression) !== "useState") continue;
      assert.equal(
        bindingNames(declaration.name).some((name) => layoutStateNames.has(name)),
        false,
        "layout state must leave App",
      );
    }
  }
  for (const path of [
    "useLayoutPreferences",
    "loadLayoutPreferences",
    "saveLayoutPreferences",
    "normalizeDashboardPanelWidths",
    "pendingRestoredCatalogSelection",
    "dashboardBackend.window.current",
    "getWindowExpandedState",
  ]) {
    assert.equal(callsWithPath(app.body, path).length, 0, `${path} must leave App`);
  }
  const resizeListeners = callsWithPath(app.body, "window.addEventListener").filter(
    (call) => call.arguments[0] && compact(call.arguments[0], appFile) === '"resize"',
  );
  assert.equal(resizeListeners.length, 0);
});

test("viewport resize phase preserves clamp, panel normalization, and tier transitions", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const analysis = effectAnalysis(
    layoutFile,
    "useDashboardViewportResizePhase",
  );
  assert.deepEqual(effectDependencies(analysis.call, layoutFile), []);
  assert.equal(analysis.body.statements.length, 3);
  const handleResize = directVariable(analysis.body, "handleResize");
  assert.ok(handleResize.initializer && ts.isArrowFunction(handleResize.initializer));
  assert.ok(ts.isBlock(handleResize.initializer.body));
  assert.equal(
    compact(handleResize.initializer.body, layoutFile),
    "{setScratchWidth((current)=>clampScratchPanelWidth(current,dashboardWorkspaceRef.current?.getBoundingClientRect().width??window.innerWidth,));constnormalizedWidths=normalizeDashboardPanelWidths(window.innerWidth,panelWidthsRef.current.sidebarWidth,panelWidthsRef.current.inspectorWidth,);panelWidthsRef.current=normalizedWidths;setSidebarWidth(normalizedWidths.sidebarWidth);setInspectorWidth(normalizedWidths.inspectorWidth);constnextTier=viewportTierForWidth(window.innerWidth);setViewportTier((currentTier)=>{if(currentTier===nextTier)returncurrentTier;if(nextTier===\"compact\"){setSidebarOpen(false);setInspectorOpen(false);}elseif(nextTier===\"drawer\"){setSidebarOpen(true);setInspectorOpen(false);}else{setSidebarOpen(true);setInspectorOpen(inspectorOpenPreferenceRef.current);}returnnextTier;});}",
  );
  assert.equal(callsWithPath(analysis.body, "handleResize").length, 0);
  assert.equal(
    compact(analysis.body.statements[1], layoutFile),
    'window.addEventListener("resize",handleResize);',
  );
  assert.equal(
    compact(analysis.body.statements[2], layoutFile),
    'return()=>window.removeEventListener("resize",handleResize);',
  );
});

test("window capture phase preserves ready gating, debounce, conversion, and late cleanup", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const expanded = directFunction(layoutFile, "getWindowExpandedState");
  assert.ok(expanded.body);
  const expandedPromise = callsWithPath(expanded.body, "Promise.all");
  assert.equal(expandedPromise.length, 1);
  assert.equal(expandedPromise[0].arguments.length, 1);
  assert.ok(ts.isArrayLiteralExpression(expandedPromise[0].arguments[0]));
  assert.deepEqual(
    expandedPromise[0].arguments[0].elements.map((element) => compact(element, layoutFile)),
    [
      "win.isFullscreen().catch(()=>false)",
      "win.isMaximized().catch(()=>false)",
    ],
  );
  const expandedReturns = expanded.body.statements.filter(ts.isReturnStatement);
  assert.equal(expandedReturns.length, 1);
  assert.equal(compact(expandedReturns[0], layoutFile), "return{fullscreen,maximized};");

  const analysis = effectAnalysis(layoutFile, "useDashboardWindowCapturePhase");
  assert.deepEqual(effectDependencies(analysis.call, layoutFile), ["windowRestoreReady"]);
  assert.equal(analysis.body.statements.length, 12);
  assert.ok(ts.isIfStatement(analysis.body.statements[0]));
  assert.equal(compact(analysis.body.statements[0], layoutFile), "if(!windowRestoreReady)return;");
  assert.equal(
    compact(analysis.body.statements[1], layoutFile),
    "constwin=dashboardBackend.window.current();",
  );
  const expectedDeclarations = [
    [2, "disposed", "false"],
    [3, "timer", "null"],
    [4, "unlistenResized", "<undefined>"],
    [5, "unlistenMoved", "<undefined>"],
  ] as const;
  for (const [index, name, initializer] of expectedDeclarations) {
    const statement = analysis.body.statements[index];
    assert.ok(ts.isVariableStatement(statement));
    assert.ok((statement.declarationList.flags & ts.NodeFlags.Let) !== 0);
    assert.equal(statement.declarationList.declarations.length, 1);
    const declaration = statement.declarationList.declarations[0];
    assert.ok(ts.isIdentifier(declaration.name));
    assert.equal(declaration.name.text, name);
    assert.equal(
      declaration.initializer ? compact(declaration.initializer, layoutFile) : "<undefined>",
      initializer,
    );
  }
  const capture = directVariable(analysis.body, "capture");
  assert.equal(analysis.body.statements.indexOf(capture.parent.parent), 6);
  assert.ok(capture.initializer && ts.isArrowFunction(capture.initializer));
  assert.ok(ts.isBlock(capture.initializer.body));
  assert.equal(callsWithPath(capture.initializer.body, "getWindowExpandedState").length, 1);
  assert.equal(callsWithPath(capture.initializer.body, "Promise.all").length, 1);
  assert.equal(callsWithPath(capture.initializer.body, "Math.round").length, 4);
  assert.equal(callsWithPath(capture.initializer.body, "setWindowLayout").length, 3);
  const captureTry = capture.initializer.body.statements[0];
  assert.ok(ts.isTryStatement(captureTry));
  assert.ok(captureTry.catchClause);
  assert.equal(captureTry.catchClause.block.statements.length, 0);
  assert.deepEqual(
    captureTry.tryBlock.statements.map((statement) => {
      if (ts.isVariableStatement(statement)) {
        return bindingNames(statement.declarationList.declarations[0].name)[0];
      }
      if (ts.isIfStatement(statement)) return `if:${compact(statement.expression, layoutFile)}`;
      if (ts.isExpressionStatement(statement)) return compact(statement.expression, layoutFile);
      return ts.SyntaxKind[statement.kind];
    }),
    [
      "fullscreen",
      "if:disposed",
      "if:fullscreen",
      "if:maximized",
      "size",
      "if:disposed",
      "setWindowLayout({width:Math.round(size.width/factor),height:Math.round(size.height/factor),x:Math.round(position.x/factor),y:Math.round(position.y/factor),maximized:false,})",
    ],
  );
  assert.equal(
    compact(captureTry.tryBlock.statements[2], layoutFile),
    "if(fullscreen){setWindowLayout((prev)=>prev??{width:WINDOW_DEFAULTS.width,height:WINDOW_DEFAULTS.height,x:0,y:0,maximized:false,},);return;}",
  );
  assert.equal(
    compact(captureTry.tryBlock.statements[3], layoutFile),
    "if(maximized){setWindowLayout((prev)=>prev?{...prev,maximized:true}:{width:WINDOW_DEFAULTS.width,height:WINDOW_DEFAULTS.height,x:0,y:0,maximized:true,},);return;}",
  );
  const windowDefaults = layoutFile.statements.filter(
    (statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) &&
      bindingNames(statement.declarationList.declarations[0].name).includes("WINDOW_DEFAULTS"),
  );
  assert.equal(windowDefaults.length, 1);
  assert.equal(
    compact(windowDefaults[0].declarationList.declarations[0].initializer!, layoutFile),
    "{width:1440,height:900}",
  );

  const schedule = directVariable(analysis.body, "scheduleCapture");
  assert.equal(analysis.body.statements.indexOf(schedule.parent.parent), 7);
  assert.ok(schedule.initializer && ts.isArrowFunction(schedule.initializer));
  assert.equal(
    compact(schedule.initializer.body, layoutFile),
    "{if(timer)clearTimeout(timer);timer=window.setTimeout(()=>{voidcapture();},150);}",
  );
  const immediateCaptures = analysis.body.statements.filter(
    (statement) => compact(statement, layoutFile) === "voidcapture();",
  );
  assert.equal(immediateCaptures.length, 1);
  assert.equal(analysis.body.statements.indexOf(immediateCaptures[0]), 8);
  for (const [listener, slot] of [
    ["win.onResized", "unlistenResized"],
    ["win.onMoved", "unlistenMoved"],
  ] as const) {
    const inner = callsWithPath(analysis.body, listener);
    assert.equal(inner.length, 1);
    assert.equal(inner[0].arguments.length, 1);
    assert.equal(compact(inner[0].arguments[0], layoutFile), "scheduleCapture");
    assert.equal(
      analysis.body.statements.indexOf(
        inner[0].parent.parent.parent.parent as ts.Statement,
      ),
      listener === "win.onResized" ? 9 : 10,
    );
    assert.ok(ts.isPropertyAccessExpression(inner[0].parent));
    assert.equal(inner[0].parent.name.text, "then");
    assert.ok(ts.isCallExpression(inner[0].parent.parent));
    const thenCall = inner[0].parent.parent;
    assert.equal(
      compact(arrowBlockArgument(thenCall), layoutFile),
      `{if(disposed)fn();else${slot}=fn;}`,
    );
  }
  const cleanup = analysis.body.statements.at(-1);
  assert.ok(cleanup && ts.isReturnStatement(cleanup) && cleanup.expression);
  assert.equal(
    compact(cleanup.expression, layoutFile),
    "()=>{disposed=true;if(timer)clearTimeout(timer);unlistenResized?.();unlistenMoved?.();}",
  );
});

test("layout hydration preserves legacy migration, setter order, and failure completion", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const analysis = effectAnalysis(layoutFile, "useDashboardLayoutHydrationPhase");
  assert.deepEqual(effectDependencies(analysis.call, layoutFile), [
    "dashboardBackend",
    "getLatestSuccessfulRefreshGeneration",
    "loadLayoutPreferences",
  ]);
  assert.equal(analysis.body.statements.length, 1);
  assert.ok(ts.isExpressionStatement(analysis.body.statements[0]));
  assert.ok(ts.isCallExpression(analysis.body.statements[0].expression));
  const finallyCall = analysis.body.statements[0].expression;
  const catchCall = chainedCall(finallyCall, "finally");
  const thenCall = chainedCall(catchCall, "catch");
  assert.ok(ts.isPropertyAccessExpression(thenCall.expression));
  assert.equal(thenCall.expression.name.text, "then");
  assert.ok(ts.isCallExpression(thenCall.expression.expression));
  assert.equal(expressionPath(thenCall.expression.expression.expression), "loadLayoutPreferences");
  assert.equal(thenCall.expression.expression.arguments.length, 0);
  const thenBody = arrowBlockArgument(thenCall);
  const catchBody = arrowBlockArgument(catchCall);
  const finallyBody = arrowBlockArgument(finallyCall);
  assert.equal(compact(catchBody, layoutFile), "{setWindowRestoreReady(true);}");
  assert.equal(compact(finallyBody, layoutFile), "{layoutLoadedRef.current=true;}");

  const labels = thenBody.statements.map((statement) => {
    if (ts.isVariableStatement(statement)) {
      return bindingNames(statement.declarationList.declarations[0].name)[0];
    }
    if (ts.isIfStatement(statement)) return `if:${compact(statement.expression, layoutFile)}`;
    if (ts.isExpressionStatement(statement)) return compact(statement.expression, layoutFile);
    return ts.SyntaxKind[statement.kind];
  });
  assert.deepEqual(labels, [
    "restoredPanelWidths",
    "panelWidthsRef.current=restoredPanelWidths",
    "setSidebarWidth(restoredPanelWidths.sidebarWidth)",
    "setInspectorWidth(restoredPanelWidths.inspectorWidth)",
    "if:lay.sessionOrder",
    "if:lay.collapsedProjects",
    "if:lay.pinnedItems",
    "if:lay.automationSectionCollapsed!==undefined",
    "restoredScratchOpen",
    "if:lay.scratchCollapsed!==undefined",
    "if:lay.scratchWidth!==undefined",
    "restoredSidebarView",
    "setSidebarView(restoredSidebarView)",
    "currentViewportTier",
    "restoredSidebarOpen",
    "restoredInspectorOpen",
    "sidebarOpenPreferenceRef.current=restoredSidebarOpen",
    "inspectorOpenPreferenceRef.current=restoredInspectorOpen",
    'if:currentViewportTier==="compact"',
    "if:lay.diffFile",
    "if:lay.selection!==undefined",
    "if:lay.window",
    "setWindowRestoreReady(true)",
  ]);
  assert.equal(
    compact(thenBody.statements[0], layoutFile),
    "constrestoredPanelWidths=normalizeDashboardPanelWidths(window.innerWidth,lay.sidebarWidth??lay.left??DEFAULT_SIDEBAR_WIDTH,lay.inspectorWidth??DEFAULT_INSPECTOR_WIDTH,);",
  );
  assert.equal(
    compact(thenBody.statements[4], layoutFile),
    'if(lay.sessionOrder){setSessionOrder(lay.sessionOrder.filter((name)=>!name.startsWith("tw-term-")));}',
  );
  assert.equal(
    compact(thenBody.statements[5], layoutFile),
    "if(lay.collapsedProjects){setCollapsedProjects(lay.collapsedProjects);}",
  );
  assert.equal(
    compact(thenBody.statements[6], layoutFile),
    "if(lay.pinnedItems){setPinnedItems(lay.pinnedItems);}",
  );
  assert.equal(
    compact(thenBody.statements[7], layoutFile),
    "if(lay.automationSectionCollapsed!==undefined){setAutomationSectionCollapsed(lay.automationSectionCollapsed);}",
  );
  assert.equal(
    compact(thenBody.statements[8], layoutFile),
    "constrestoredScratchOpen=lay.scratchCollapsed===false;",
  );
  assert.equal(
    compact(thenBody.statements[9], layoutFile),
    "if(lay.scratchCollapsed!==undefined)setScratchCollapsed(lay.scratchCollapsed);",
  );
  assert.equal(
    compact(thenBody.statements[10], layoutFile),
    "if(lay.scratchWidth!==undefined){setScratchWidth(clampScratchPanelWidth(lay.scratchWidth,window.innerWidth));}",
  );
  assert.equal(
    compact(thenBody.statements[11], layoutFile),
    'constrestoredSidebarView:SidebarView=lay.sidebarView??(lay.fileBrowserOpen===true||(lay.inspectorOpen===true&&lay.inspectorTab==="files")||lay.editingFile?"files":"workspaces");',
  );
  assert.equal(
    compact(thenBody.statements[14], layoutFile),
    "constrestoredSidebarOpen=lay.sidebarOpen??true;",
  );
  assert.equal(
    compact(thenBody.statements[13], layoutFile),
    "constcurrentViewportTier=viewportTierForWidth(window.innerWidth);",
  );
  assert.equal(
    compact(thenBody.statements[15], layoutFile),
    'constrestoredInspectorOpen=!restoredScratchOpen&&(lay.sidebarView!==undefined?lay.inspectorOpen??false:(lay.inspectorTab==="git"||lay.inspectorTab==="diff")&&(lay.inspectorOpen??false));',
  );
  assert.equal(
    compact(thenBody.statements[16], layoutFile),
    "sidebarOpenPreferenceRef.current=restoredSidebarOpen;",
  );
  assert.equal(
    compact(thenBody.statements[17], layoutFile),
    "inspectorOpenPreferenceRef.current=restoredInspectorOpen;",
  );
  assert.equal(
    compact(thenBody.statements[18], layoutFile),
    'if(currentViewportTier==="compact"){setSidebarOpen(false);setInspectorOpen(false);}elseif(currentViewportTier==="drawer"){setSidebarOpen(true);setInspectorOpen(false);}else{setSidebarOpen(true);setInspectorOpen(restoredInspectorOpen);}',
  );
  assert.equal(
    compact(thenBody.statements[19], layoutFile),
    "if(lay.diffFile){setDiffFile(lay.diffFile);setEditingFile(null);}elseif(lay.editingFile){setEditingFile(lay.editingFile);setDiffFile(null);}",
  );
  assert.equal(
    compact(thenBody.statements[20], layoutFile),
    "if(lay.selection!==undefined){setPendingCatalogSelection(pendingRestoredCatalogSelection(lay.selection,getLatestSuccessfulRefreshGeneration(),),);setSelection(lay.selection);}",
  );
  assert.equal(
    compact(thenBody.statements[21], layoutFile),
    "if(lay.window)setWindowLayout(lay.window);",
  );
  assert.equal(
    compact(thenBody.statements[22], layoutFile),
    "setWindowRestoreReady(true);",
  );
  for (const forbidden of ["disposed", "request", "AbortController", "aborted"]) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(compact(analysis.fn, layoutFile)), false);
  }
});

test("layout persistence keeps the loaded gate, exact payload, and visible-state deps", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const analysis = effectAnalysis(layoutFile, "useDashboardLayoutPersistencePhase");
  assert.deepEqual(effectDependencies(analysis.call, layoutFile), [
    "sidebarWidth",
    "inspectorWidth",
    "sidebarOpen",
    "inspectorOpen",
    "sidebarView",
    "sessionOrder",
    "collapsedProjects",
    "pinnedItems",
    "automationSectionCollapsed",
    "scratchCollapsed",
    "scratchWidth",
    "selection",
    "editingFile",
    "diffFile",
    "windowLayout",
    "saveLayoutPreferences",
  ]);
  assert.equal(analysis.body.statements.length, 3);
  assert.equal(
    compact(analysis.body.statements[0], layoutFile),
    "if(!layoutLoadedRef.current)return;",
  );
  const timer = directVariable(analysis.body, "t");
  assert.ok(timer.initializer && ts.isCallExpression(timer.initializer));
  assert.equal(expressionPath(timer.initializer.expression), "setTimeout");
  assert.equal(timer.initializer.arguments.length, 2);
  assert.equal(compact(timer.initializer.arguments[1], layoutFile), "500");
  const timerBody = functionExpressionBody(timer.initializer.arguments[0]);
  assert.equal(timerBody.statements.length, 1);
  assert.ok(ts.isExpressionStatement(timerBody.statements[0]));
  const saves = callsWithPath(timerBody, "saveLayoutPreferences");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].arguments.length, 1);
  assert.ok(ts.isObjectLiteralExpression(saves[0].arguments[0]));
  const payload = saves[0].arguments[0];
  assert.equal(payload.properties.length, 18);
  const expected = new Map([
    ["left", "sidebarWidth"],
    ["sidebarWidth", "sidebarWidth"],
    ["inspectorWidth", "inspectorWidth"],
    ["sidebarOpen", "sidebarOpenPreferenceRef.current"],
    ["inspectorOpen", "inspectorOpenPreferenceRef.current"],
    ["sidebarView", "sidebarView"],
    ["sessionOrder", "sessionOrder"],
    ["collapsedProjects", "collapsedProjects"],
    ["pinnedItems", "pinnedItems"],
    ["automationSectionCollapsed", "automationSectionCollapsed"],
    ["columnOrder", "DEFAULT_COLUMN_ORDER"],
    ["scratchCollapsed", "scratchCollapsed"],
    ["scratchWidth", "scratchWidth"],
    ["fileBrowserOpen", 'sidebarView==="files"'],
    ["selection", "selection"],
    ["editingFile", "editingFile"],
    ["diffFile", "diffFile"],
  ]);
  const directProperties = payload.properties.slice(0, -1);
  assert.equal(directProperties.length, expected.size);
  for (const [index, [name, value]] of [...expected].entries()) {
    const property = directProperties[index];
    assert.ok(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property));
    assert.ok(ts.isIdentifier(property.name));
    assert.equal(property.name.text, name);
    assert.equal(compact(propertyInitializer(property), layoutFile), value);
  }
  const conditionalWindow = payload.properties.at(-1);
  assert.ok(conditionalWindow && ts.isSpreadAssignment(conditionalWindow));
  assert.equal(
    compact(conditionalWindow.expression, layoutFile),
    "(windowLayout?{window:windowLayout}:{})",
  );
  assert.ok(ts.isPropertyAccessExpression(saves[0].parent));
  assert.equal(saves[0].parent.name.text, "catch");
  assert.ok(ts.isCallExpression(saves[0].parent.parent));
  assert.equal(timerBody.statements[0].expression, saves[0].parent.parent);
  assert.equal(
    compact(arrowBlockArgument(saves[0].parent.parent), layoutFile),
    "{}",
  );
  assert.equal(
    compact(analysis.body.statements[2], layoutFile),
    "return()=>clearTimeout(t);",
  );
});

test("layout structure guards reject namespace, indirect-edge, nested, and interval decoys", () => {
  const exportDecoy = parse("export-decoy.ts", `
    export function useDashboardLayoutState() {}
    export function useDashboardViewportResizePhase() {}
    export function useDashboardWindowCapturePhase() {}
    export function useDashboardLayoutHydrationPhase() {}
    export function useDashboardLayoutPersistencePhase() {}
    export namespace Hidden {}
  `);
  assert.ok(exportedNames(exportDecoy).some(({ name }) => name === "Hidden"));
  assert.throws(() => assertExactCanonicalExport(exportDecoy));

  const edgeDecoys = [
    `const value = import("./hidden");`,
    `type Hidden = import("./hidden").Hidden;`,
    `import hidden = require("./hidden");`,
    `const hidden = require("./hidden");`,
    `/// <reference path="./hidden.ts" />`,
  ];
  for (const [index, source] of edgeDecoys.entries()) {
    assert.throws(
      () => assertNoIndirectModuleEdges(parse(`edge-${index}.ts`, source)),
      source,
    );
  }

  const nested = parse("nested.tsx", `
    function App() {
      function hidden() { useDashboardViewportResizePhase(dashboardLayout); }
    }
  `);
  const nestedApp = directFunction(nested, "App");
  assert.ok(nestedApp.body);
  assert.throws(
    () => uniqueDirectCall(nestedApp.body!, "useDashboardViewportResizePhase"),
    /direct App call/,
  );

  for (const [needle, decoy] of [
    [
      "  useDashboardWindowCapturePhase(dashboardLayout, dashboardBackend);",
      "  React.useEffect(() => {}, []);",
    ],
    [
      "  useDashboardLayoutHydrationPhase(dashboardLayout, {",
      "  Hooks.useFoo();",
    ],
    [
      "  useDashboardWindowCapturePhase(dashboardLayout, dashboardBackend);",
      "  const phase = useDashboardViewportResizePhase;\n  phase(dashboardLayout);",
    ],
    [
      "  useDashboardWindowCapturePhase(dashboardLayout, dashboardBackend);",
      "  const fx = useEffect;\n  fx(() => {}, []);",
    ],
  ] as const) {
    const replaced = sources.app.replace(needle, `${decoy}\n\n${needle}`);
    assert.notEqual(replaced, sources.app);
    assert.throws(() => assertAppEffectTimeline(parse("timeline-decoy.tsx", replaced)));
  }
});
