import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  controller: readFileSync(
    new URL(
      "../src/dashboard/navigation/editorNavigationController.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  hook: readFileSync(
    new URL("../src/dashboard/hooks/useEditorNavigationGuard.ts", import.meta.url),
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
    const owner = expressionPath(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : null;
  }
  return null;
}

function callCount(node: ts.Node, path: string): number {
  let count = 0;
  visit(node, (candidate) => {
    if (
      ts.isCallExpression(candidate) &&
      expressionPath(candidate.expression) === path
    ) {
      count += 1;
    }
  });
  return count;
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

function directFunctionBodyFromVariable(
  body: ts.Block,
  name: string,
): ts.ConciseBody {
  const matches: ts.Expression[] = [];
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      assert.ok(declaration.initializer);
      let initializer = declaration.initializer;
      if (ts.isCallExpression(initializer)) {
        assert.equal(expressionPath(initializer.expression), "useCallback");
        assert.ok(initializer.arguments[0]);
        initializer = initializer.arguments[0];
      }
      assert.ok(
        ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer),
        `${name} must remain a function`,
      );
      matches.push(initializer);
    }
  }
  assert.equal(matches.length, 1, `expected one App handler ${name}`);
  return (matches[0] as ts.ArrowFunction | ts.FunctionExpression).body;
}

function callbackDependencies(body: ts.Block, name: string): string[] {
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
      assert.equal(expressionPath(declaration.initializer.expression), "useCallback");
      assert.equal(declaration.initializer.arguments.length, 2);
      const dependencies = declaration.initializer.arguments[1];
      assert.ok(ts.isArrayLiteralExpression(dependencies));
      return dependencies.elements.map((element) => element.getText());
    }
  }
  assert.fail(`missing callback ${name}`);
}

function exportedNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        names.push("*");
      } else if (ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
      } else {
        names.push(statement.exportClause.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.push("default");
      continue;
    }
    const exported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (!exported) continue;
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const bindings: ts.BindingName[] = [declaration.name];
        while (bindings.length > 0) {
          const binding = bindings.pop()!;
          if (ts.isIdentifier(binding)) {
            names.push(binding.text);
          } else {
            for (const element of binding.elements) {
              if (ts.isBindingElement(element)) bindings.push(element.name);
            }
          }
        }
      }
      continue;
    }
    if (ts.isModuleDeclaration(statement)) {
      names.push(statement.name.getText(sourceFile));
      continue;
    }
    assert.fail(`unsupported exported declaration: ${statement.getText(sourceFile)}`);
  }
  return names.sort();
}

function typeMemberNames(sourceFile: ts.SourceFile, name: string): string[] {
  const aliases = sourceFile.statements.filter(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  assert.equal(aliases.length, 1);
  assert.ok(ts.isTypeReferenceNode(aliases[0].type));
  assert.equal(aliases[0].type.typeName.getText(sourceFile), "Readonly");
  const wrapped = aliases[0].type.typeArguments?.[0];
  assert.ok(wrapped && ts.isTypeLiteralNode(wrapped));
  return wrapped.members.map((member) => {
    assert.ok(
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
        member.name &&
        ts.isIdentifier(member.name),
    );
    return (member.name as ts.Identifier).text;
  });
}

function directTopLevelCalls(body: ts.Block, path: string): number[] {
  const indices: number[] = [];
  for (const [index, statement] of body.statements.entries()) {
    const candidates: ts.CallExpression[] = [];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      candidates.push(statement.expression);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && ts.isCallExpression(declaration.initializer)) {
          candidates.push(declaration.initializer);
        }
      }
    }
    if (candidates.some((call) => expressionPath(call.expression) === path)) {
      indices.push(index);
    }
  }
  return indices;
}

function directTopLevelCallExpressions(
  body: ts.Block,
  path: string,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  for (const statement of body.statements) {
    const candidates: ts.CallExpression[] = [];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      candidates.push(statement.expression);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && ts.isCallExpression(declaration.initializer)) {
          candidates.push(declaration.initializer);
        }
      }
    }
    calls.push(...candidates.filter((call) => expressionPath(call.expression) === path));
  }
  return calls;
}

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

function directObjectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter((property) =>
    property.name && ts.isIdentifier(property.name) && property.name.text === name
  );
  assert.equal(matches.length, 1, `expected one direct property ${name}`);
  return matches[0];
}

function objectPropertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression {
  const property = directObjectProperty(object, name);
  assert.ok(ts.isPropertyAssignment(property));
  return property.initializer;
}

function directGuardObject(hook: ts.FunctionDeclaration): ts.ObjectLiteralExpression {
  for (const statement of hook.body!.statements) {
    if (!ts.isIfStatement(statement) || !ts.isBlock(statement.thenStatement)) continue;
    for (const nested of statement.thenStatement.statements) {
      if (!ts.isVariableStatement(nested)) continue;
      for (const declaration of nested.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "guard" &&
          declaration.initializer &&
          ts.isObjectLiteralExpression(declaration.initializer)
        ) {
          return declaration.initializer;
        }
      }
    }
  }
  assert.fail("missing direct guard object");
}

test("D11 canonical modules have exact APIs, owners, and a pure controller DAG", () => {
  const controllerFile = parse("editorNavigationController.ts", sources.controller);
  const hookFile = parse("useEditorNavigationGuard.ts", sources.hook);
  assert.deepEqual(exportedNames(controllerFile), [
    "EditorNavigationController",
    "EditorNavigationControllerContext",
    "EditorNavigationRequest",
    "createEditorNavigationController",
  ]);
  assert.deepEqual(exportedNames(hookFile), [
    "EditorNavigationGuard",
    "useEditorNavigationGuard",
    "useEditorNavigationGuardLifecyclePhase",
  ]);
  assert.deepEqual(typeMemberNames(controllerFile, "EditorNavigationControllerContext"), [
    "backendOwner",
    "editorKey",
    "automationKey",
  ]);
  assert.deepEqual(typeMemberNames(controllerFile, "EditorNavigationRequest"), [
    "confirmEditorDiscard",
    "confirmAutomationDiscard",
    "navigate",
    "ignoreAutomationDirty",
  ]);
  assert.deepEqual(typeMemberNames(controllerFile, "EditorNavigationController"), [
    "syncContext",
    "activate",
    "deactivate",
    "editorDirtyChanged",
    "automationDirtyChanged",
    "automationSubmitOwner",
    "request",
  ]);
  assert.deepEqual(typeMemberNames(hookFile, "EditorNavigationGuard"), [
    "requestEditorNavigation",
    "handleEditorDirtyChange",
    "handleAutomationDirtyChange",
    "getAutomationSubmitOwner",
  ]);

  const controllerImports = controllerFile.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => {
      assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
      return statement.moduleSpecifier.text;
    })
    .sort();
  assert.deepEqual(controllerImports, [
    "../../automationDraftSync",
    "../../editorNavigationGuard",
    "../../latestRequestGate",
  ]);
  assert.equal(callCount(controllerFile, "runGuardedWorkspaceNavigation"), 1);
  assert.equal(callCount(controllerFile, "createLatestRequestGate"), 1);
  assert.equal(callCount(controllerFile, "recordAutomationDirtySignal"), 1);
  assert.equal(callCount(controllerFile, "useEffect"), 0);
  assert.equal(callCount(controllerFile, "useState"), 0);
  assert.doesNotMatch(sources.controller, /(?:window|document|localStorage|fetch|dashboardBackend)/);

  const expectedOwners = new Map([
    ["createEditorNavigationController", "dashboard/navigation/editorNavigationController.ts"],
    ["useEditorNavigationGuard", "dashboard/hooks/useEditorNavigationGuard.ts"],
    ["useEditorNavigationGuardLifecyclePhase", "dashboard/hooks/useEditorNavigationGuard.ts"],
  ]);
  for (const [symbol, expectedPath] of expectedOwners) {
    const owners = readRendererImplementationFiles().flatMap(({ path, source }) =>
      exportedNames(parse(path, source)).includes(symbol) ? [path] : []
    );
    assert.deepEqual(owners, [expectedPath]);
  }
});

test("the main hook is render-pure while ordered layout phases publish and own lifecycle", () => {
  const hookFile = parse("useEditorNavigationGuard.ts", sources.hook);
  const hook = directFunction(hookFile, "useEditorNavigationGuard");
  const lifecycle = directFunction(
    hookFile,
    "useEditorNavigationGuardLifecyclePhase",
  );
  assert.equal(callCount(hook.body!, "useEffect"), 0);
  assert.equal(callCount(hook.body!, "useLayoutEffect"), 0);
  assert.equal(callCount(hook.body!, "useState"), 0);
  assert.equal(callCount(hook.body!, "createEditorNavigationController"), 1);
  assert.equal(callCount(hook.body!, "registration.controller.syncContext"), 0);
  assert.equal(callCount(hook.body!, "registration.controller.request"), 1);
  assert.equal(callCount(hook.body!, "registration.controller.automationSubmitOwner"), 1);
  assert.match(sources.hook, /const guardRef = useRef<EditorNavigationGuard \| null>\(null\)/);
  assert.match(sources.hook, /registrationByGuard\.set\(guard, registration\)/);
  assert.doesNotMatch(hook.getText(hookFile), /\bbackendRef\b|\beditingFileRef\b/);

  const lifecycleEffects: ts.CallExpression[] = [];
  visit(lifecycle.body!, (node) => {
    if (
      ts.isCallExpression(node) &&
      expressionPath(node.expression) === "useLayoutEffect"
    ) {
      lifecycleEffects.push(node);
    }
  });
  assert.equal(callCount(lifecycle.body!, "useEffect"), 0);
  assert.equal(lifecycleEffects.length, 2);
  assert.deepEqual(
    lifecycleEffects.map((effect) => compact(effect.arguments[1], hookFile)),
    [
      "[automationDraftKey,dashboardBackend,editorKey,fileName,guard]",
      "[guard]",
    ],
  );
  const publishBody = lifecycleEffects[0].arguments[0];
  const lifecycleBody = lifecycleEffects[1].arguments[0];
  assert.ok(ts.isArrowFunction(publishBody) && ts.isBlock(publishBody.body));
  assert.ok(ts.isArrowFunction(lifecycleBody));
  assert.equal(callCount(publishBody.body, "registration.controller.syncContext"), 1);
  assert.equal(callCount(publishBody.body, "registration.controller.activate"), 0);
  assert.equal(callCount(publishBody.body, "registration.controller.deactivate"), 0);
  assert.equal(
    publishBody.body.statements.some(ts.isReturnStatement),
    false,
    "committed context publication must not install an update cleanup",
  );
  assert.equal(callCount(lifecycleBody.body, "registration.controller.activate"), 1);
  assert.equal(callCount(lifecycleBody.body, "registration.controller.deactivate"), 1);
  assert.doesNotMatch(
    typeMemberNames(hookFile, "EditorNavigationGuard").join("|"),
    /activate|deactivate/,
  );
});

test("each navigation request snapshots its backend and file label before confirming", () => {
  const hookFile = parse("useEditorNavigationGuard.ts", sources.hook);
  const hook = directFunction(hookFile, "useEditorNavigationGuard");
  const guard = directGuardObject(hook);
  const requestProperty = directObjectProperty(guard, "requestEditorNavigation");
  assert.ok(ts.isMethodDeclaration(requestProperty) && requestProperty.body);
  const statements = requestProperty.body.statements;
  assert.equal(statements.length, 4);
  assert.equal(
    compact(statements[0], hookFile),
    "constrequestBackend=registration.committedBackend;",
  );
  assert.equal(
    compact(statements[1], hookFile),
    "constfileName=registration.committedFileName;",
  );
  assert.equal(
    compact(statements[2], hookFile),
    "if(!requestBackend)returnPromise.resolve(false);",
  );
  assert.ok(ts.isReturnStatement(statements[3]) && statements[3].expression);
  const requestCall = statements[3].expression;
  assert.ok(ts.isCallExpression(requestCall));
  assert.equal(
    expressionPath(requestCall.expression),
    "registration.controller.request",
  );
  assert.equal(requestCall.arguments.length, 1);
  const requestOptions = requestCall.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(requestOptions));

  for (const [name, expectedMessage] of [
    [
      "confirmEditorDiscard",
      "`Changes to ${fileName} have not been saved. Continue and discard them?`",
    ],
    [
      "confirmAutomationDiscard",
      '"This automation draft has not been saved. Continue and discard it?"',
    ],
  ] as const) {
    const callback = objectPropertyInitializer(requestOptions, name);
    assert.ok(ts.isArrowFunction(callback));
    assert.equal(callCount(callback.body, "requestBackend.dialog.confirm"), 1);
    assert.equal(callCount(callback.body, "backendRef.current.dialog.confirm"), 0);
    assert.doesNotMatch(
      callback.getText(hookFile),
      /\b(?:backendRef|editingFileRef|registration)\b/,
    );
    assert.match(callback.getText(hookFile), new RegExp(
      expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ));
  }
  assert.equal(callCount(requestProperty.body, "registration.controller.request"), 1);
  assert.equal(callCount(requestProperty.body, "requestBackend.dialog.confirm"), 2);
});

test("App only wires the D11 guard and retains all eleven business navigation handlers", () => {
  const appFile = parse("App.tsx", sources.app);
  const app = directFunction(appFile, "App");
  const appBody = app.body!;
  const guardCalls = directTopLevelCalls(appBody, "useEditorNavigationGuard");
  const lifecycleCalls = directTopLevelCalls(
    appBody,
    "useEditorNavigationGuardLifecyclePhase",
  );
  assert.deepEqual(guardCalls.length, 1);
  assert.deepEqual(lifecycleCalls.length, 1);
  assert.equal(callCount(appBody, "useEditorNavigationGuard"), 1);
  assert.equal(callCount(appBody, "useEditorNavigationGuardLifecyclePhase"), 1);
  const lifecycleCall = directTopLevelCallExpressions(
    appBody,
    "useEditorNavigationGuardLifecyclePhase",
  )[0];
  assert.equal(lifecycleCall.arguments.length, 2);
  assert.equal(compact(lifecycleCall.arguments[0], appFile), "editorNavigationGuard");
  assert.equal(
    compact(lifecycleCall.arguments[1], appFile),
    "{dashboardBackend,editingFile,automationDraftKey,}",
  );

  for (const handler of [
    "resetDashboardLayout",
    "handleAutomationCreate",
    "handleAutomationSave",
    "handleNewAutomation",
    "handleOpenFile",
    "closeEditingFile",
    "selectSession",
    "selectTerminal",
    "selectAutomation",
    "returnFromAutomationManager",
    "openGitDiff",
  ]) {
    const handlerBody = directFunctionBodyFromVariable(appBody, handler);
    assert.equal(
      callCount(handlerBody, "requestEditorNavigation"),
      1,
      `${handler} must retain exactly one guarded business transition`,
    );
    let readsDashboardBackend = false;
    visit(handlerBody, (node) => {
      if (ts.isIdentifier(node) && node.text === "dashboardBackend") {
        readsDashboardBackend = true;
      }
    });
    if (readsDashboardBackend) {
      assert.ok(
        callbackDependencies(appBody, handler).includes("dashboardBackend"),
        `${handler} must not borrow backend freshness from the stable guard callback`,
      );
    }
  }
  assert.equal(callCount(appBody, "requestEditorNavigation"), 11);
  assert.equal(callCount(appBody, "getAutomationSubmitOwner"), 4);
  assert.equal(callCount(appBody, "automationSubmitStillOwnsDraft"), 2);
  assert.equal(callCount(appBody, "automationSelectionIsCurrent"), 1);
  assert.deepEqual(callbackDependencies(appBody, "handleAutomationCreate"), [
    "dashboardBackend",
    "getAutomationSubmitOwner",
    "loadAutomations",
    "requestEditorNavigation",
  ]);
  assert.deepEqual(callbackDependencies(appBody, "handleAutomationSave"), [
    "dashboardBackend",
    "getAutomationSubmitOwner",
    "loadAutomations",
    "requestEditorNavigation",
  ]);
  assert.deepEqual(callbackDependencies(appBody, "loadAutomations"), [
    "dashboardBackend",
  ]);
  assert.deepEqual(callbackDependencies(appBody, "handleAutomationToggle"), [
    "dashboardBackend",
    "loadAutomations",
  ]);
  assert.deepEqual(callbackDependencies(appBody, "handleAutomationRun"), [
    "dashboardBackend",
    "loadAutomations",
    "refresh",
  ]);
  assert.ok(
    callbackDependencies(appBody, "resetDashboardLayout").includes("dashboardBackend"),
  );
  assert.ok(
    callbackDependencies(appBody, "handleNewAutomation").includes("dashboardBackend"),
  );

  for (const forbidden of [
    "editorNavigationGateRef",
    "editorDirtySnapshotRef",
    "automationDirtySnapshotRef",
    "runGuardedWorkspaceNavigation",
    "createLatestRequestGate",
    "recordAutomationDirtySignal",
    "editingFileRef",
  ]) {
    assert.doesNotMatch(sources.app, new RegExp(`\\b${forbidden}\\b`));
  }
  for (const retained of [
    "selection",
    "pendingCatalogSelection",
    "editingFile",
    "editorNavigationRevision",
    "diffFile",
  ]) {
    assert.match(sources.app, new RegExp(`\\b${retained}\\b`));
  }
  assert.match(sources.app, /onDirtyChange=\{handleEditorDirtyChange\}/);
  assert.match(sources.app, /onDirtyChange=\{handleAutomationDirtyChange\}/);
  assert.deepEqual(callbackDependencies(appBody, "handleOpenFile"), [
    "editingFile",
    "requestEditorNavigation",
  ]);
  assert.deepEqual(callbackDependencies(appBody, "selectAutomation"), [
    "diffFile",
    "editingFile",
    "requestEditorNavigation",
    "selection",
    "viewportTier",
  ]);
  assert.match(
    compact(directFunctionBodyFromVariable(appBody, "handleOpenFile"), appFile),
    /editingFileSourceKey\(editingFile\)===editingFileSourceKey\(nextFile\)/,
  );
  assert.match(
    compact(directFunctionBodyFromVariable(appBody, "selectAutomation"), appFile),
    /automationSelectionIsCurrent\([^)]*editingFile!==null,diffFile!==null,?\)/,
  );

  const existingEffectPaths = [
    "useEffect",
    "useDashboardViewportResizePhase",
    "useDashboardWindowCapturePhase",
    "useTerminalMetadataHydrationPhase",
    "useDashboardLayoutHydrationPhase",
    "useTerminalMetadataPersistencePhase",
    "useDashboardLayoutPersistencePhase",
    "useCatalogSelectionHydration",
    "useTerminalDeckPreviewPhase",
    "useVisibilityAwarePolling",
    "useTerminalDeckAttachPhase",
  ];
  const existingIndices = existingEffectPaths.flatMap((path) =>
    directTopLevelCalls(appBody, path)
  );
  assert.ok(existingIndices.length > 0);
  assert.ok(
    Math.max(...existingIndices) < lifecycleCalls[0],
    "the lifecycle fence must register after every pre-D11 effect-bearing phase",
  );
});
