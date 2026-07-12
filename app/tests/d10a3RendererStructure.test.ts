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
  coordinator: readFileSync(
    new URL("../src/dashboard/layoutSaveCoordinator.ts", import.meta.url),
    "utf8",
  ),
  windowCapture: readFileSync(
    new URL("../src/dashboard/windowCaptureCoordinator.ts", import.meta.url),
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

const coordinatorExports = [
  "LayoutSaveAuthorization",
  "LayoutSaveCoordinator",
  "LayoutSaveCoordinatorOptions",
  "LayoutSaveFailureClassification",
  "LayoutSaveScheduler",
  "createLayoutSaveCoordinator",
] as const;

const windowCaptureExports = [
  "WindowCaptureCoordinator",
  "WindowCaptureCoordinatorOptions",
  "WindowCaptureResult",
  "createWindowCaptureCoordinator",
  "windowLayoutFromCapture",
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

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function jsxAttribute(
  element: ts.JsxOpeningLikeElement,
  name: string,
): ts.JsxAttribute {
  const matches = element.attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
  assert.equal(matches.length, 1, `expected one JSX ${name} attribute`);
  return matches[0];
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

test("layout save coordinator has one reachable pure owner and an exact API", () => {
  const coordinatorFile = parse("layoutSaveCoordinator.ts", sources.coordinator);
  const exported = exportedNames(coordinatorFile);
  assert.equal(new Set(exported.map(({ name }) => name)).size, exported.length);
  assert.deepEqual(
    exported.map(({ name }) => name).sort(),
    [...coordinatorExports].sort(),
  );
  assert.deepEqual(
    exported.filter(({ runtime }) => runtime).map(({ name }) => name),
    ["createLayoutSaveCoordinator"],
  );
  assert.deepEqual(importManifest(coordinatorFile), [
    "./layout/types|DashboardLayoutPreferences|DashboardLayoutPreferences|type",
  ]);
  assertNoIndirectModuleEdges(coordinatorFile);
  assert.equal(
    coordinatorFile.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
    ),
    false,
  );
  assert.doesNotMatch(
    sources.coordinator,
    /\b(?:React|useEffect|useState|localStorage|fetch|backend|flushNow)\b/,
  );
  assert.doesNotMatch(sources.coordinator, /\b(?:window|document)\s*[.[]/);

  const reachable = readRendererImplementationFiles();
  assert.equal(
    reachable.some(({ path }) => path === "dashboard/layoutSaveCoordinator.ts"),
    true,
  );
  const owners = reachable.flatMap(({ path, source }) =>
    exportedNames(parse(path, source)).some(
        ({ name, runtime }) => runtime && name === "createLayoutSaveCoordinator",
      )
      ? [path]
      : []
  );
  assert.deepEqual(owners, ["dashboard/layoutSaveCoordinator.ts"]);

  const debounceDeclarations: ts.VariableDeclaration[] = [];
  visit(coordinatorFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "scheduleDebounce"
    ) {
      debounceDeclarations.push(node);
    }
  });
  assert.equal(debounceDeclarations.length, 1);
  const scheduleDebounce = debounceDeclarations[0].initializer;
  assert.ok(scheduleDebounce && ts.isArrowFunction(scheduleDebounce));
  assert.equal(scheduleDebounce.parameters.length, 1);
  assert.equal(scheduleDebounce.parameters[0].name.getText(coordinatorFile), "attempt");
  assert.equal(scheduleDebounce.parameters[0].type?.kind, ts.SyntaxKind.NumberKeyword);
  const retainedPayloadIdentifiers: string[] = [];
  visit(scheduleDebounce.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      (node.text === "entry" || node.text === "snapshot")
    ) {
      retainedPayloadIdentifiers.push(node.text);
    }
  });
  assert.deepEqual(retainedPayloadIdentifiers, []);

  const coordinatorFactory = directFunction(
    coordinatorFile,
    "createLayoutSaveCoordinator",
  );
  assert.ok(coordinatorFactory.body);
  const coordinatorAliases = coordinatorFile.statements.filter(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "LayoutSaveCoordinator",
  );
  assert.equal(coordinatorAliases.length, 1);
  assert.ok(ts.isTypeLiteralNode(coordinatorAliases[0].type));
  assert.deepEqual(
    coordinatorAliases[0].type.members.map((member) => compact(member, coordinatorFile)),
    [
      "beginAttempt(attempt:number):void;",
      "authorize(authorization:LayoutSaveAuthorization):void;",
      "enqueue(attempt:number,snapshot:DashboardLayoutPreferences):void;",
      'flush(attempt:number,finalSnapshot:DashboardLayoutPreferences,signal:AbortSignal,):Promise<"flushed"|"blocked"|"stale"|"cancelled">;',
      "block(attempt:number):void;",
      "stop():void;",
    ],
  );
  assert.deepEqual(
    ["pending", "exactRetry", "inFlight"].map((name) => {
      const declaration = directVariable(coordinatorFactory.body!, name);
      return {
        initializer: declaration.initializer?.getText(coordinatorFile),
        name,
        type: declaration.type?.getText(coordinatorFile),
      };
    }),
    [
      { initializer: "null", name: "pending", type: "PendingSave | null" },
      { initializer: "null", name: "exactRetry", type: "ExactRetrySave | null" },
      { initializer: "null", name: "inFlight", type: "InFlightSave | null" },
    ],
  );
  const finalization = directVariable(coordinatorFactory.body, "finalization");
  assert.equal(finalization.initializer?.getText(coordinatorFile), "null");
  assert.equal(finalization.type?.getText(coordinatorFile), "LayoutSaveFinalization | null");

  const settleSuccessDeclaration = directVariable(
    coordinatorFactory.body,
    "settleSuccess",
  );
  assert.ok(
    settleSuccessDeclaration.initializer &&
      ts.isArrowFunction(settleSuccessDeclaration.initializer) &&
      ts.isBlock(settleSuccessDeclaration.initializer.body),
  );
  const settleSuccessStatements = settleSuccessDeclaration.initializer.body.statements;
  const directPumpIndex = settleSuccessStatements.findIndex(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      expressionPath(statement.expression.expression) === "pump",
  );
  const recoveredNotificationIndex = settleSuccessStatements.findIndex(
    (statement) =>
      ts.isIfStatement(statement) &&
      callsWithPath(statement.thenStatement, "notify").some(
        (call) => call.arguments[0]?.getText(coordinatorFile) === "options.onRecovered",
      ),
  );
  assert.ok(directPumpIndex >= 0);
  assert.ok(recoveredNotificationIndex > directPumpIndex);

  const factoryReturn = coordinatorFactory.body.statements.find(ts.isReturnStatement);
  assert.ok(factoryReturn?.expression && ts.isObjectLiteralExpression(factoryReturn.expression));
  const methods = new Map(
    factoryReturn.expression.properties.map((property) => {
      assert.ok(ts.isMethodDeclaration(property));
      assert.ok(ts.isIdentifier(property.name));
      return [property.name.text, property];
    }),
  );
  assert.deepEqual([...methods.keys()], [
    "beginAttempt",
    "authorize",
    "enqueue",
    "flush",
    "block",
    "stop",
  ]);
  const flushMethod = methods.get("flush")!;
  assert.equal(
    (ts.getModifiers(flushMethod) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ),
    false,
    "flush must preserve Promise identity for repeated calls",
  );
  assert.deepEqual(
    flushMethod.parameters.map((parameter) => compact(parameter, coordinatorFile)),
    [
      "attempt",
      "finalSnapshot",
      "signal",
    ],
  );
  assert.ok(flushMethod.body);
  assert.equal(callsWithPath(flushMethod.body, "cloneLayoutSnapshot").length, 1);
  assert.equal(callsWithPath(flushMethod.body, "pump").length, 1);
  assert.equal(callsWithPath(flushMethod.body, "startWrite").length, 0);
  const startWrite = directVariable(coordinatorFactory.body, "startWrite");
  assert.ok(startWrite.initializer && ts.isArrowFunction(startWrite.initializer));
  const writeCalls: ts.CallExpression[] = [];
  visit(coordinatorFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "write"
    ) {
      writeCalls.push(node);
    }
  });
  assert.equal(writeCalls.length, 1);
  assert.ok(startWrite.initializer.body.pos <= writeCalls[0].pos);
  assert.ok(writeCalls[0].end <= startWrite.initializer.body.end);
});

test("window capture coordinator has one reachable pure owner and a fenced API", () => {
  const captureFile = parse(
    "windowCaptureCoordinator.ts",
    sources.windowCapture,
  );
  const exported = exportedNames(captureFile);
  assert.equal(new Set(exported.map(({ name }) => name)).size, exported.length);
  assert.deepEqual(
    exported.map(({ name }) => name).sort(),
    [...windowCaptureExports].sort(),
  );
  assert.deepEqual(
    exported.filter(({ runtime }) => runtime).map(({ name }) => name).sort(),
    ["createWindowCaptureCoordinator", "windowLayoutFromCapture"],
  );
  assert.deepEqual(importManifest(captureFile), [
    "../platform|DashboardWindow|DashboardWindow|type",
    "./layout/types|WindowLayout|WindowLayout|type",
  ]);
  assertNoIndirectModuleEdges(captureFile);
  assert.equal(
    captureFile.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
    ),
    false,
  );
  assert.doesNotMatch(
    sources.windowCapture,
    /\b(?:React|useEffect|useState|localStorage|fetch|document|onCloseRequested|destroy|flush)\b/,
  );
  assert.doesNotMatch(sources.windowCapture, /\bwindow\s*[.[]/);

  const reachable = readRendererImplementationFiles();
  assert.ok(
    reachable.some(({ path }) => path === "dashboard/windowCaptureCoordinator.ts"),
  );
  for (const owner of [
    "createWindowCaptureCoordinator",
    "windowLayoutFromCapture",
  ]) {
    const owners = reachable.flatMap(({ path, source }) =>
      exportedNames(parse(path, source)).some(
          ({ name, runtime }) => runtime && name === owner,
        )
        ? [path]
        : []
    );
    assert.deepEqual(owners, ["dashboard/windowCaptureCoordinator.ts"]);
  }

  const factory = directFunction(captureFile, "createWindowCaptureCoordinator");
  assert.ok(factory.body);
  assert.deepEqual(
    ["active", "started", "generation", "cancelDebounce"].map((name) => {
      const declaration = directVariable(factory.body!, name);
      return [name, compact(declaration.initializer!, captureFile)];
    }),
    [
      ["active", "false"],
      ["started", "false"],
      ["generation", "0"],
      ["cancelDebounce", "null"],
    ],
  );
  const scheduleCapture = directVariable(factory.body, "scheduleCapture");
  assert.ok(scheduleCapture.initializer && ts.isArrowFunction(scheduleCapture.initializer));
  assert.ok(ts.isBlock(scheduleCapture.initializer.body));
  assert.deepEqual(
    scheduleCapture.initializer.body.statements.slice(0, 3).map(
      (statement) => compact(statement, captureFile),
    ),
    ["if(!active)return;", "consttoken=++generation;", "clearDebounce();"],
  );
  const trailingCapture = directVariable(factory.body, "requestTrailingCapture");
  assert.ok(trailingCapture.initializer && ts.isArrowFunction(trailingCapture.initializer));
  assert.equal(
    compact(trailingCapture.initializer.body, captureFile),
    "{if(!active||cancelDebounce!==null)return;scheduleCapture();}",
  );
  const registerListener = directVariable(factory.body, "registerListener");
  assert.ok(registerListener.initializer && ts.isArrowFunction(registerListener.initializer));
  assert.equal(
    callsWithPath(registerListener.initializer.body, "requestTrailingCapture").length,
    3,
  );
  assert.equal(
    callsWithPath(registerListener.initializer.body, "requestBaseline").length,
    0,
  );
  assert.equal(callsWithPath(factory.body, "options.target.onResized").length, 1);
  assert.equal(callsWithPath(factory.body, "options.target.onMoved").length, 1);
  assert.equal(callsWithPath(factory.body, "options.publish").length, 1);
  assert.equal(callsWithPath(captureFile, "Number.isFinite").length, 2);
  assert.equal(callsWithPath(factory.body, "Promise.all").length, 2);

  const factoryReturn = factory.body.statements.find(ts.isReturnStatement);
  assert.ok(factoryReturn?.expression && ts.isObjectLiteralExpression(factoryReturn.expression));
  const methods = new Map(
    factoryReturn.expression.properties.map((property) => {
      assert.ok(ts.isMethodDeclaration(property));
      assert.ok(ts.isIdentifier(property.name));
      return [property.name.text, property];
    }),
  );
  assert.deepEqual([...methods.keys()], ["start", "stop"]);
  const stop = methods.get("stop")!;
  assert.ok(stop.body);
  assert.deepEqual(
    stop.body.statements.slice(0, 4).map((statement) => compact(statement, captureFile)),
    [
      "if(!active)return;",
      "active=false;",
      "generation+=1;",
      "clearDebounce();",
    ],
  );
});

test("dashboard layout state has one canonical owner and the frozen state/ref API", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  assertExactCanonicalExport(layoutFile);
  assertNoIndirectModuleEdges(layoutFile);
  assertNoHookImportAliases(layoutFile);
  assert.deepEqual(importManifest(layoutFile), [
    "../../platform|DashboardBackend|DashboardBackend|type",
    "../layout/panelGeometry|DEFAULT_INSPECTOR_WIDTH|DEFAULT_INSPECTOR_WIDTH|value",
    "../layout/panelGeometry|DEFAULT_SIDEBAR_WIDTH|DEFAULT_SIDEBAR_WIDTH|value",
    "../layout/panelGeometry|normalizeDashboardPanelWidths|normalizeDashboardPanelWidths|value",
    "../layout/panelGeometry|viewportTierForWidth|viewportTierForWidth|value",
    "../layout/schema|DEFAULT_COLUMN_ORDER|DEFAULT_COLUMN_ORDER|value",
    "../layout/schema|DashboardLayoutExtensions|DashboardLayoutExtensions|type",
    "../layout/schema|DashboardLayoutInvalidReason|DashboardLayoutInvalidReason|type",
    "../layout/scratchGeometry|DEFAULT_SCRATCH_PANEL_WIDTH|DEFAULT_SCRATCH_PANEL_WIDTH|value",
    "../layout/scratchGeometry|clampScratchPanelWidth|clampScratchPanelWidth|value",
    "../layout/types|DiffFile|DiffFile|type",
    "../layout/types|EditingFile|EditingFile|type",
    "../layout/types|SidebarView|SidebarView|type",
    "../layout/types|ViewportTier|ViewportTier|type",
    "../layout/types|WindowLayout|WindowLayout|type",
    "../layoutPersistence|classifyDashboardLayoutPersistenceFailure|classifyDashboardLayoutPersistenceFailure|value",
    "../layoutSaveCoordinator|LayoutSaveCoordinator|LayoutSaveCoordinator|type",
    "../layoutSaveCoordinator|createLayoutSaveCoordinator|createLayoutSaveCoordinator|value",
    "../model/selection|PendingCatalogSelection|PendingCatalogSelection|type",
    "../model/selection|PinnedItem|PinnedItem|type",
    "../model/selection|Selection|Selection|type",
    "../model/selection|pendingRestoredCatalogSelection|pendingRestoredCatalogSelection|value",
    "../windowCaptureCoordinator|createWindowCaptureCoordinator|createWindowCaptureCoordinator|value",
    "../windowCaptureCoordinator|windowLayoutFromCapture|windowLayoutFromCapture|value",
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
    ["layoutPersistenceState", '{phase:"hydrating"}'],
    ["layoutSaveError", "null"],
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
    ["layoutPersistenceState", "setLayoutPersistenceState"],
    ["layoutSaveError", "setLayoutSaveError"],
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
    [
      "layoutPersistenceGateRef",
      "{attempt:0,writable:false,extensions:EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,}",
    ],
    ["layoutSaveCoordinatorRef", "null"],
  ]);
  assert.equal(callsWithPath(state.body, "useRef").length, refInitializers.size);
  for (const [name, expected] of refInitializers) {
    const declaration = directVariable(state.body, name);
    assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
    assert.equal(expressionPath(declaration.initializer.expression), "useRef");
    assert.equal(declaration.initializer.arguments.length, 1);
    assert.equal(compact(declaration.initializer.arguments[0], layoutFile), expected);
  }

  const coordinatorCreation = callsWithPath(state.body, "createLayoutSaveCoordinator");
  assert.equal(coordinatorCreation.length, 1);
  assert.equal(coordinatorCreation[0].arguments.length, 1);
  assert.ok(ts.isObjectLiteralExpression(coordinatorCreation[0].arguments[0]));
  const coordinatorOptions = directObjectProperties(coordinatorCreation[0].arguments[0]);
  assert.deepEqual(coordinatorOptions.names, [
    "debounceMs",
    "schedule",
    "retryDelayMs",
    "onError",
    "onRecovered",
    "onBlocked",
  ]);
  assert.equal(
    compact(propertyInitializer(coordinatorOptions.byName.get("debounceMs")), layoutFile),
    "500",
  );
  assert.equal(
    compact(propertyInitializer(coordinatorOptions.byName.get("schedule")), layoutFile),
    "(callback,delayMs)=>{consttimer=window.setTimeout(callback,delayMs);return()=>window.clearTimeout(timer);}",
  );
  assert.equal(
    compact(propertyInitializer(coordinatorOptions.byName.get("retryDelayMs")), layoutFile),
    '()=>document.visibilityState==="hidden"?15_000:3_000',
  );
  assert.equal(
    compact(propertyInitializer(coordinatorOptions.byName.get("onError")), layoutFile),
    '(error)=>{setLayoutSaveError(`Dashboardlayoutchangescouldnotbesaved.Retryingautomatically:${boundedLayoutSaveErrorDetail(error)}`,);}',
  );
  assert.equal(
    compact(propertyInitializer(coordinatorOptions.byName.get("onRecovered")), layoutFile),
    "()=>setLayoutSaveError(null)",
  );
  assert.equal(
    compact(propertyInitializer(coordinatorOptions.byName.get("onBlocked")), layoutFile),
    '(error)=>{constgate=layoutPersistenceGateRef.current;layoutPersistenceGateRef.current={...gate,writable:false,};setLayoutPersistenceState({phase:"blocked",reason:"write_failed"});setLayoutSaveError(`Dashboardlayoutchangescouldnotbesaved:${boundedLayoutSaveErrorDetail(error)}`,);}',
  );
  const coordinatorIfs = state.body.statements.filter(
    (statement): statement is ts.IfStatement =>
      ts.isIfStatement(statement) &&
      compact(statement.expression, layoutFile) ===
        "layoutSaveCoordinatorRef.current===null",
  );
  assert.equal(coordinatorIfs.length, 1);
  assert.equal(callsWithPath(coordinatorIfs[0], "createLayoutSaveCoordinator").length, 1);
  const coordinatorBinding = directVariable(state.body, "layoutSaveCoordinator");
  assert.equal(
    compact(coordinatorBinding.initializer!, layoutFile),
    "layoutSaveCoordinatorRef.current",
  );

  const boundedError = directFunction(layoutFile, "boundedLayoutSaveErrorDetail");
  assert.ok(boundedError.body);
  assert.equal(callsWithPath(boundedError.body, "JSON.stringify").length, 0);
  assert.equal(callsWithPath(boundedError.body, "String").length, 0);
  assert.match(compact(boundedError.body, layoutFile), /\.slice\(0,MAX_LAYOUT_SAVE_ERROR_DETAIL_LENGTH\+1\)/);
  const maxErrorConstants = layoutFile.statements.filter(
    (statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) &&
      bindingNames(statement.declarationList.declarations[0].name).includes(
        "MAX_LAYOUT_SAVE_ERROR_DETAIL_LENGTH",
      ),
  );
  assert.equal(maxErrorConstants.length, 1);
  assert.equal(
    compact(maxErrorConstants[0].declarationList.declarations[0].initializer!, layoutFile),
    "200",
  );

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
    "layoutPersistenceState",
    "setLayoutPersistenceState",
    "layoutSaveError",
    "setLayoutSaveError",
    "panelWidthsRef",
    "sidebarOpenPreferenceRef",
    "inspectorOpenPreferenceRef",
    "dashboardWorkspaceRef",
    "layoutPersistenceGateRef",
    "layoutSaveCoordinator",
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
      "layoutPersistenceState",
      "layoutSaveError",
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
    "layoutSaveError",
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

test("Advanced settings prioritize blocked hydration and reuse one alert for save retries", () => {
  const appFile = parse("App.tsx", sources.app);
  const app = directFunction(appFile, "App");
  assert.ok(app.body);
  const settings: ts.JsxSelfClosingElement[] = [];
  visit(app.body, (node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(appFile) === "SettingsDialog"
    ) {
      settings.push(node);
    }
  });
  assert.equal(settings.length, 1);
  const content = jsxAttribute(settings[0], "content");
  assert.ok(content.initializer && ts.isJsxExpression(content.initializer));
  assert.ok(content.initializer.expression);
  const contentExpression = unwrapParentheses(content.initializer.expression);
  assert.ok(ts.isObjectLiteralExpression(contentExpression));
  const contentProperties = directObjectProperties(contentExpression);
  const advanced = unwrapParentheses(
    propertyInitializer(contentProperties.byName.get("advanced")),
  );

  const alerts: ts.JsxElement[] = [];
  const buttons: ts.JsxElement[] = [];
  visit(advanced, (node) => {
    if (!ts.isJsxElement(node)) return;
    if (node.openingElement.tagName.getText(appFile) === "button") buttons.push(node);
    const role = node.openingElement.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "role",
    );
    if (role?.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === "alert") {
      alerts.push(node);
    }
  });
  assert.equal(alerts.length, 1);
  const allAppAlerts: ts.JsxElement[] = [];
  visit(app.body, (node) => {
    if (!ts.isJsxElement(node)) return;
    const role = node.openingElement.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "role",
    );
    if (role?.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === "alert") {
      allAppAlerts.push(node);
    }
  });
  assert.equal(allAppAlerts.length, 1, "the blocked-state alert must have one App owner");

  let blockedCondition: ts.BinaryExpression | undefined;
  for (let node: ts.Node | undefined = alerts[0]; node && node !== advanced; node = node.parent) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      blockedCondition = node;
      break;
    }
  }
  assert.ok(blockedCondition);
  assert.equal(
    compact(blockedCondition.left, appFile),
    '(layoutPersistenceState.phase==="blocked"||layoutSaveError)',
  );
  assert.equal(unwrapParentheses(blockedCondition.right), alerts[0]);
  const alertExpressions = alerts[0].children.filter(
    (child): child is ts.JsxExpression =>
      ts.isJsxExpression(child) && child.expression !== undefined,
  );
  assert.equal(alertExpressions.length, 1);
  assert.equal(
    compact(alertExpressions[0].expression!, appFile),
    'layoutPersistenceState.phase==="blocked"?layoutPersistenceState.reason==="read_failed"?"Dashboardlayoutcouldnotberead.Thesavedlayoutwillnotbeoverwritten,andlayoutchangeswillnotbesavedthistime.":layoutPersistenceState.reason==="future_schema"?`Dashboardlayoutschema${layoutPersistenceState.version}wascreatedbyanewerversion.Itwillbepreservedunchanged,andlayoutchangeswillnotbesaved.`:layoutPersistenceState.reason==="invalid_layout"?"Thesaveddashboardlayoutisinvalid.Itwillbepreservedunchanged,andlayoutchangeswillnotbesaved.":layoutSaveError??"Dashboardlayoutchangescouldnotbesaved.Layoutsavingisblockeduntilthenexthydration.":layoutSaveError',
  );
  assert.match(
    sources.layout,
    /Dashboard layout changes could not be saved\. Retrying automatically:/,
  );

  assert.equal(buttons.length, 1);
  assert.equal(
    buttons[0].children.filter(ts.isJsxText).map((child) => child.text.trim()).join(""),
    "Reset layout",
  );
  const disabled = jsxAttribute(buttons[0].openingElement, "disabled");
  assert.ok(disabled.initializer && ts.isJsxExpression(disabled.initializer));
  assert.ok(disabled.initializer.expression);
  assert.equal(
    compact(disabled.initializer.expression, appFile),
    'layoutPersistenceState.phase!=="writable"',
  );
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

test("window capture phase delegates one backend-fenced effect to the coordinator", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const analysis = effectAnalysis(layoutFile, "useDashboardWindowCapturePhase");
  assert.deepEqual(effectDependencies(analysis.call, layoutFile), [
    "windowRestoreReady",
    "dashboardBackend",
  ]);
  assert.equal(analysis.body.statements.length, 4);
  assert.equal(
    compact(analysis.body.statements[0], layoutFile),
    "if(!windowRestoreReady)return;",
  );
  const coordinator = directVariable(analysis.body, "coordinator");
  assert.ok(coordinator.initializer && ts.isCallExpression(coordinator.initializer));
  assert.equal(
    expressionPath(coordinator.initializer.expression),
    "createWindowCaptureCoordinator",
  );
  assert.equal(coordinator.initializer.arguments.length, 1);
  assert.equal(
    compact(coordinator.initializer.arguments[0], layoutFile),
    "{debounceMs:150,publish:(result)=>{setWindowLayout((previous)=>windowLayoutFromCapture(previous,result));},schedule:(callback,delayMs)=>{consttimer=window.setTimeout(callback,delayMs);return()=>window.clearTimeout(timer);},target:dashboardBackend.window.current(),}",
  );
  assert.equal(
    compact(analysis.body.statements[2], layoutFile),
    "coordinator.start();",
  );
  assert.equal(
    compact(analysis.body.statements[3], layoutFile),
    "return()=>coordinator.stop();",
  );
  assert.equal(callsWithPath(analysis.body, "setWindowLayout").length, 1);
  assert.equal(callsWithPath(analysis.body, "windowLayoutFromCapture").length, 1);
  assert.equal(callsWithPath(analysis.body, "dashboardBackend.window.current").length, 1);
  assert.equal(callsWithPath(analysis.body, "coordinator.start").length, 1);
  assert.equal(callsWithPath(analysis.body, "coordinator.stop").length, 1);
  assert.equal(callsWithPath(analysis.body, "useEffect").length, 0);
});

test("layout hydration fences attempts and authorizes only compatible outcomes", () => {
  const layoutFile = parse("useDashboardLayout.ts", sources.layout);
  const analysis = effectAnalysis(layoutFile, "useDashboardLayoutHydrationPhase");
  assert.deepEqual(effectDependencies(analysis.call, layoutFile), [
    "dashboardBackend",
    "getLatestSuccessfulRefreshGeneration",
    "layoutSaveCoordinator",
    "loadLayoutPreferences",
    "saveLayoutPreferences",
  ]);
  assert.equal(analysis.body.statements.length, 8);
  assert.equal(
    compact(analysis.body.statements[0], layoutFile),
    "constattempt=layoutPersistenceGateRef.current.attempt+1;",
  );
  assert.equal(
    compact(analysis.body.statements[1], layoutFile),
    "layoutSaveCoordinator.beginAttempt(attempt);",
  );
  assert.equal(
    compact(analysis.body.statements[2], layoutFile),
    "setLayoutSaveError(null);",
  );
  assert.equal(
    compact(analysis.body.statements[3], layoutFile),
    "layoutPersistenceGateRef.current={attempt,writable:false,extensions:EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,};",
  );
  assert.equal(
    compact(analysis.body.statements[4], layoutFile),
    'setLayoutPersistenceState({phase:"hydrating"});',
  );
  assert.equal(compact(analysis.body.statements[5], layoutFile), "letdisposed=false;");
  assert.ok(ts.isExpressionStatement(analysis.body.statements[6]));
  const loadExpression = analysis.body.statements[6].expression;
  assert.equal(loadExpression.kind, ts.SyntaxKind.VoidExpression);
  const catchCall = (loadExpression as ts.VoidExpression).expression;
  assert.ok(ts.isCallExpression(catchCall));
  const thenCall = chainedCall(catchCall, "catch");
  assert.ok(ts.isPropertyAccessExpression(thenCall.expression));
  assert.equal(thenCall.expression.name.text, "then");
  assert.ok(ts.isCallExpression(thenCall.expression.expression));
  assert.equal(expressionPath(thenCall.expression.expression.expression), "loadLayoutPreferences");
  assert.equal(thenCall.expression.expression.arguments.length, 0);
  const thenBody = arrowBlockArgument(thenCall);
  const catchBody = arrowBlockArgument(catchCall);
  assert.equal(thenBody.statements.length, 31);
  assert.equal(
    compact(thenBody.statements[0], layoutFile),
    "if(disposed||layoutPersistenceGateRef.current.attempt!==attempt)return;",
  );
  assert.equal(
    compact(thenBody.statements[1], layoutFile),
    'if(outcome.kind==="future"){layoutSaveCoordinator.block(attempt);setWindowRestoreReady(true);setLayoutPersistenceState({phase:"blocked",reason:"future_schema",version:outcome.version,});return;}',
  );
  assert.equal(
    compact(thenBody.statements[2], layoutFile),
    'if(outcome.kind==="invalid"){layoutSaveCoordinator.block(attempt);setWindowRestoreReady(true);setLayoutPersistenceState({phase:"blocked",reason:"invalid_layout",invalidReason:outcome.reason,});return;}',
  );
  assert.equal(compact(thenBody.statements[3], layoutFile), "constlay=outcome.layout;");
  for (const index of [1, 2]) {
    assert.ok(ts.isIfStatement(thenBody.statements[index]));
    assert.deepEqual(
      callsWithHookLeaf(thenBody.statements[index], "useEffect"),
      [],
    );
    const calls: string[] = [];
    visit(thenBody.statements[index], (node) => {
      if (!ts.isCallExpression(node)) return;
      const path = expressionPath(node.expression);
      if (path) calls.push(path);
    });
    assert.deepEqual(calls, [
      "layoutSaveCoordinator.block",
      "setWindowRestoreReady",
      "setLayoutPersistenceState",
    ]);
  }

  const compatibleStatements = thenBody.statements.slice(4, 27);
  const labels = compatibleStatements.map((statement) => {
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
    compact(compatibleStatements[0], layoutFile),
    "constrestoredPanelWidths=normalizeDashboardPanelWidths(window.innerWidth,lay.sidebarWidth??lay.left??DEFAULT_SIDEBAR_WIDTH,lay.inspectorWidth??DEFAULT_INSPECTOR_WIDTH,);",
  );
  assert.equal(
    compact(compatibleStatements[4], layoutFile),
    'if(lay.sessionOrder){setSessionOrder(lay.sessionOrder.filter((name)=>!name.startsWith("tw-term-")));}',
  );
  assert.equal(
    compact(compatibleStatements[5], layoutFile),
    "if(lay.collapsedProjects){setCollapsedProjects(lay.collapsedProjects);}",
  );
  assert.equal(
    compact(compatibleStatements[6], layoutFile),
    "if(lay.pinnedItems){setPinnedItems(lay.pinnedItems);}",
  );
  assert.equal(
    compact(compatibleStatements[7], layoutFile),
    "if(lay.automationSectionCollapsed!==undefined){setAutomationSectionCollapsed(lay.automationSectionCollapsed);}",
  );
  assert.equal(
    compact(compatibleStatements[8], layoutFile),
    "constrestoredScratchOpen=lay.scratchCollapsed===false;",
  );
  assert.equal(
    compact(compatibleStatements[9], layoutFile),
    "if(lay.scratchCollapsed!==undefined)setScratchCollapsed(lay.scratchCollapsed);",
  );
  assert.equal(
    compact(compatibleStatements[10], layoutFile),
    "if(lay.scratchWidth!==undefined){setScratchWidth(clampScratchPanelWidth(lay.scratchWidth,window.innerWidth));}",
  );
  assert.equal(
    compact(compatibleStatements[11], layoutFile),
    'constrestoredSidebarView:SidebarView=lay.sidebarView??(lay.fileBrowserOpen===true||(lay.inspectorOpen===true&&lay.inspectorTab==="files")||lay.editingFile?"files":"workspaces");',
  );
  assert.equal(
    compact(compatibleStatements[14], layoutFile),
    "constrestoredSidebarOpen=lay.sidebarOpen??true;",
  );
  assert.equal(
    compact(compatibleStatements[13], layoutFile),
    "constcurrentViewportTier=viewportTierForWidth(window.innerWidth);",
  );
  assert.equal(
    compact(compatibleStatements[15], layoutFile),
    'constrestoredInspectorOpen=!restoredScratchOpen&&(lay.sidebarView!==undefined?lay.inspectorOpen??false:(lay.inspectorTab==="git"||lay.inspectorTab==="diff")&&(lay.inspectorOpen??false));',
  );
  assert.equal(
    compact(compatibleStatements[16], layoutFile),
    "sidebarOpenPreferenceRef.current=restoredSidebarOpen;",
  );
  assert.equal(
    compact(compatibleStatements[17], layoutFile),
    "inspectorOpenPreferenceRef.current=restoredInspectorOpen;",
  );
  assert.equal(
    compact(compatibleStatements[18], layoutFile),
    'if(currentViewportTier==="compact"){setSidebarOpen(false);setInspectorOpen(false);}elseif(currentViewportTier==="drawer"){setSidebarOpen(true);setInspectorOpen(false);}else{setSidebarOpen(true);setInspectorOpen(restoredInspectorOpen);}',
  );
  assert.equal(
    compact(compatibleStatements[19], layoutFile),
    "if(lay.diffFile){setDiffFile(lay.diffFile);setEditingFile(null);}elseif(lay.editingFile){setEditingFile(lay.editingFile);setDiffFile(null);}",
  );
  assert.equal(
    compact(compatibleStatements[20], layoutFile),
    "if(lay.selection!==undefined){setPendingCatalogSelection(pendingRestoredCatalogSelection(lay.selection,getLatestSuccessfulRefreshGeneration(),),);setSelection(lay.selection);}",
  );
  assert.equal(
    compact(compatibleStatements[21], layoutFile),
    "if(lay.window)setWindowLayout(lay.window);",
  );
  assert.equal(
    compact(compatibleStatements[22], layoutFile),
    "setWindowRestoreReady(true);",
  );
  assert.equal(
    compact(thenBody.statements[27], layoutFile),
    "layoutPersistenceGateRef.current={attempt,writable:true,extensions:outcome.extensions,};",
  );
  assert.equal(
    compact(thenBody.statements[28], layoutFile),
    "letexpectedRevision=outcome.revision;",
  );
  assert.ok(ts.isExpressionStatement(thenBody.statements[29]));
  const authorizations = callsWithPath(
    thenBody.statements[29],
    "layoutSaveCoordinator.authorize",
  );
  assert.equal(authorizations.length, 1);
  assert.equal(authorizations[0].arguments.length, 1);
  assert.ok(ts.isObjectLiteralExpression(authorizations[0].arguments[0]));
  const authorization = directObjectProperties(authorizations[0].arguments[0]);
  assert.deepEqual(authorization.names, ["attempt", "write", "classifyFailure"]);
  assert.equal(compact(propertyInitializer(authorization.byName.get("attempt")), layoutFile), "attempt");
  const write = propertyInitializer(authorization.byName.get("write"));
  assert.ok(ts.isArrowFunction(write));
  assert.ok(write.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
  assert.ok(ts.isBlock(write.body));
  assert.deepEqual(
    write.body.statements.map((statement) => compact(statement, layoutFile)),
    [
      "constcurrentGate=layoutPersistenceGateRef.current;",
      "if(!currentGate.writable||currentGate.attempt!==attempt)return;",
      "constresult=awaitsaveLayoutPreferences(snapshot,expectedRevision,outcome.extensions,);",
      "expectedRevision=result.revision;",
    ],
  );
  assert.equal(
    compact(propertyInitializer(authorization.byName.get("classifyFailure")), layoutFile),
    "classifyDashboardLayoutPersistenceFailure",
  );
  assert.equal(
    compact(thenBody.statements[30], layoutFile),
    'setLayoutPersistenceState({phase:"writable",source:outcome.source,});',
  );
  assert.equal(
    compact(catchBody, layoutFile),
    '{if(disposed||layoutPersistenceGateRef.current.attempt!==attempt)return;layoutSaveCoordinator.block(attempt);setWindowRestoreReady(true);setLayoutPersistenceState({phase:"blocked",reason:"read_failed",});}',
  );
  assert.equal(
    compact(analysis.body.statements[7], layoutFile),
    "return()=>{disposed=true;layoutSaveCoordinator.block(attempt);if(layoutPersistenceGateRef.current.attempt===attempt){layoutPersistenceGateRef.current={attempt:attempt+1,writable:false,extensions:EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,};}};",
  );
  assert.doesNotMatch(compact(analysis.fn, layoutFile), /\.finally\(/);
});

test("layout persistence enqueues one exact snapshot behind the A gate", () => {
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
    "layoutSaveCoordinator",
    "layoutPersistenceState.phase",
  ]);
  assert.equal(analysis.body.statements.length, 5);
  assert.equal(
    compact(analysis.body.statements[0], layoutFile),
    'if(layoutPersistenceState.phase!=="writable")return;',
  );
  assert.equal(
    compact(analysis.body.statements[1], layoutFile),
    "constgate=layoutPersistenceGateRef.current;",
  );
  assert.equal(
    compact(analysis.body.statements[2], layoutFile),
    "if(!gate.writable)return;",
  );
  assert.equal(
    compact(analysis.body.statements[3], layoutFile),
    "constauthorizedAttempt=gate.attempt;",
  );
  assert.ok(ts.isExpressionStatement(analysis.body.statements[4]));
  const enqueues = callsWithPath(
    analysis.body.statements[4],
    "layoutSaveCoordinator.enqueue",
  );
  assert.equal(enqueues.length, 1);
  assert.equal(enqueues[0].arguments.length, 2);
  assert.equal(compact(enqueues[0].arguments[0], layoutFile), "authorizedAttempt");
  assert.ok(ts.isObjectLiteralExpression(enqueues[0].arguments[1]));
  const payload = enqueues[0].arguments[1];
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
  assert.equal(callsWithPath(analysis.fn, "saveLayoutPreferences").length, 0);
  assert.equal(callsWithPath(analysis.fn, "setTimeout").length, 0);
  assert.equal(callsWithPath(analysis.fn, "clearTimeout").length, 0);
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
