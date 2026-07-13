import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  panel: readFileSync(new URL("../src/AutomationPanel.tsx", import.meta.url), "utf8"),
  coordinator: readFileSync(
    new URL("../src/dashboard/automation/automationWorkspaceCoordinator.ts", import.meta.url),
    "utf8",
  ),
  hook: readFileSync(
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
    const owner = expressionPath(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : null;
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

function allCalls(node: ts.Node, path: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  visit(node, (candidate) => {
    if (ts.isCallExpression(candidate) && expressionPath(candidate.expression) === path) {
      matches.push(candidate);
    }
  });
  return matches;
}

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

function importSpecifiers(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : []
  );
}

function exportedDeclarationNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    const exported = ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (!exported) return [];
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      return statement.name ? [statement.name.text] : ["default"];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
      );
    }
    assert.fail(`unsupported canonical export: ${ts.SyntaxKind[statement.kind]}`);
  });
}

function exportedNames(sourceFile: ts.SourceFile): string[] {
  for (const statement of sourceFile.statements) {
    assert.equal(
      ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
      false,
      "canonical owners cannot contain re-exports or export assignments",
    );
  }
  return exportedDeclarationNames(sourceFile);
}

function variableFunctionBody(root: ts.Node, name: string): ts.Block {
  const matches: ts.FunctionLikeDeclaration[] = [];
  visit(root, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      matches.push(node.initializer);
    }
  });
  assert.equal(matches.length, 1, `expected one function variable ${name}`);
  const body = matches[0].body;
  assert.ok(body && ts.isBlock(body), `${name} must use a block body`);
  return body;
}

function dependencyTexts(call: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  assert.equal(call.arguments.length, 2);
  const dependencies = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  return dependencies.elements.map((element) => compact(element, sourceFile));
}

function objectProperties(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): Map<string, string> {
  const properties = new Map<string, string>();
  for (const property of object.properties) {
    assert.ok(!ts.isSpreadAssignment(property), "owner context cannot contain spreads");
    assert.ok(
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
      "owner context must use direct data properties",
    );
    const name = property.name.getText(sourceFile);
    assert.equal(properties.has(name), false, `duplicate owner context property ${name}`);
    properties.set(
      name,
      ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : compact(property.initializer, sourceFile),
    );
  }
  return properties;
}

test("automation workspace canonical owners have exact exports and a one-way import DAG", () => {
  const coordinator = parse("automationWorkspaceCoordinator.ts", sources.coordinator);
  const hook = parse("useAutomationWorkspace.ts", sources.hook);
  assert.deepEqual(exportedNames(coordinator).sort(), [
    "AutomationWorkspaceContext",
    "AutomationWorkspaceCoordinator",
    "AutomationWorkspaceState",
    "EMPTY_AUTOMATION_WORKSPACE_STATE",
    "createAutomationWorkspaceCoordinator",
  ].sort());
  assert.deepEqual(exportedNames(hook).sort(), [
    "useAutomationWorkspace",
    "useAutomationWorkspaceHydrationPhase",
    "useAutomationWorkspaceOwnerPhase",
    "useAutomationWorkspaceSchedulerPhase",
  ].sort());
  assert.deepEqual(importSpecifiers(coordinator), [
    "../../automationDraftSync",
    "../../automationTypes",
    "../../platform",
    "../ownerEpochLease",
  ]);
  assert.deepEqual(importSpecifiers(hook), [
    "react",
    "../../automationTypes",
    "../../platform",
    "../automation/automationWorkspaceCoordinator",
  ]);
  assert.doesNotMatch(sources.coordinator, /(?:from\s+["']react["']|\.\/hooks\/|\.\/App)/);
  assert.doesNotMatch(sources.hook, /(?:\.\/App|AutomationPanel|useWorkspaceCatalog)/);

  const targetOwners = new Map<string, string[]>();
  const expectedOwners = new Map<string, string>([
    ["AutomationWorkspaceContext", "dashboard/automation/automationWorkspaceCoordinator.ts"],
    ["AutomationWorkspaceCoordinator", "dashboard/automation/automationWorkspaceCoordinator.ts"],
    ["AutomationWorkspaceState", "dashboard/automation/automationWorkspaceCoordinator.ts"],
    ["EMPTY_AUTOMATION_WORKSPACE_STATE", "dashboard/automation/automationWorkspaceCoordinator.ts"],
    ["createAutomationWorkspaceCoordinator", "dashboard/automation/automationWorkspaceCoordinator.ts"],
    ["useAutomationWorkspace", "dashboard/hooks/useAutomationWorkspace.ts"],
    ["useAutomationWorkspaceOwnerPhase", "dashboard/hooks/useAutomationWorkspace.ts"],
    ["useAutomationWorkspaceHydrationPhase", "dashboard/hooks/useAutomationWorkspace.ts"],
    ["useAutomationWorkspaceSchedulerPhase", "dashboard/hooks/useAutomationWorkspace.ts"],
  ]);
  for (const file of readRendererImplementationFiles()) {
    const sourceFile = parse(file.path, file.source);
    for (const name of exportedDeclarationNames(sourceFile)) {
      if (!expectedOwners.has(name)) continue;
      const owners = targetOwners.get(name) ?? [];
      owners.push(file.path);
      targetOwners.set(name, owners);
    }
  }
  for (const [target, expectedOwner] of expectedOwners) {
    assert.deepEqual(targetOwners.get(target), [expectedOwner], `${target} needs one canonical owner`);
  }
});

test("automation phases keep exact effects and App context wiring", () => {
  const hook = parse("useAutomationWorkspace.ts", sources.hook);
  const stateHook = directFunction(hook, "useAutomationWorkspace");
  assert.equal(allCalls(stateHook.body!, "useEffect").length, 0);
  assert.equal(allCalls(stateHook.body!, "useLayoutEffect").length, 0);

  const owner = directFunction(hook, "useAutomationWorkspaceOwnerPhase");
  const ownerEffects = directCalls(owner.body!, "useLayoutEffect");
  assert.equal(ownerEffects.length, 2);
  assert.equal(allCalls(owner.body!, "useEffect").length, 0);
  assert.equal(
    compact(ownerEffects[0].arguments[0], hook),
    "()=>{coordinator.commitContext(context);}",
  );
  assert.deepEqual(dependencyTexts(ownerEffects[0], hook), [
    "context.backend",
    "context.clearDeletedAutomationSelection",
    "context.getAutomationSubmitOwner",
    "context.navigateToSavedAutomation",
    "context.reconcileAutomationSelection",
    "context.refreshWorkspace",
    "coordinator",
  ]);
  assert.equal(
    compact(ownerEffects[1].arguments[0], hook),
    "()=>{constactivation=coordinator.activate();return()=>{coordinator.deactivate(activation);};}",
  );
  assert.deepEqual(dependencyTexts(ownerEffects[1], hook), ["coordinator"]);
  const hydration = directFunction(hook, "useAutomationWorkspaceHydrationPhase");
  const hydrationEffects = directCalls(hydration.body!, "useEffect");
  assert.equal(hydrationEffects.length, 1);
  assert.equal(compact(hydrationEffects[0].arguments[0], hook), "()=>{voidload();}");
  assert.deepEqual(dependencyTexts(hydrationEffects[0], hook), ["load"]);
  const scheduler = directFunction(hook, "useAutomationWorkspaceSchedulerPhase");
  const schedulerEffects = directCalls(scheduler.body!, "useEffect");
  assert.equal(schedulerEffects.length, 1);
  assert.equal(
    compact(schedulerEffects[0].arguments[0], hook),
    "()=>{construnScheduledAutomations=()=>{voidtick(newDate());};constid=setInterval(runScheduledAutomations,30_000);return()=>clearInterval(id);}",
  );
  assert.deepEqual(dependencyTexts(schedulerEffects[0], hook), ["tick"]);
  assert.equal(allCalls(schedulerEffects[0], "setInterval").length, 1);
  assert.equal(allCalls(schedulerEffects[0], "clearInterval").length, 1);

  const appFile = parse("App.tsx", sources.app);
  const app = directFunction(appFile, "App");
  const ownerCalls = directCalls(app.body!, "useAutomationWorkspaceOwnerPhase");
  assert.equal(ownerCalls.length, 1);
  assert.equal(ownerCalls[0].arguments.length, 2);
  assert.equal(compact(ownerCalls[0].arguments[0], appFile), "automationWorkspaceOwnerPhase");
  assert.ok(ts.isObjectLiteralExpression(ownerCalls[0].arguments[1]));
  assert.deepEqual(
    objectProperties(ownerCalls[0].arguments[1], appFile),
    new Map([
      ["backend", "dashboardBackend"],
      ["getAutomationSubmitOwner", "getAutomationSubmitOwner"],
      ["navigateToSavedAutomation", "navigateToSavedAutomation"],
      ["reconcileAutomationSelection", "reconcileAutomationSelection"],
      ["clearDeletedAutomationSelection", "clearDeletedAutomationSelection"],
      ["refreshWorkspace", "refresh"],
    ]),
  );
  const hydrationCalls = directCalls(app.body!, "useAutomationWorkspaceHydrationPhase");
  const schedulerCalls = directCalls(app.body!, "useAutomationWorkspaceSchedulerPhase");
  assert.equal(hydrationCalls.length, 1);
  assert.equal(schedulerCalls.length, 1);
  assert.deepEqual(
    hydrationCalls[0].arguments.map((argument) => compact(argument, appFile)),
    ["loadAutomations"],
  );
  assert.deepEqual(
    schedulerCalls[0].arguments.map((argument) => compact(argument, appFile)),
    ["tickScheduledAutomations"],
  );
});

test("App delegates backend CRUD and bounded scheduling to the automation workspace", () => {
  assert.doesNotMatch(
    sources.app,
    /\b(?:automationsRef|scheduledAutomationMinuteRef|setAutomations|setAutomationRuns|setAutomationError)\b/,
  );
  assert.doesNotMatch(sources.app, /dashboardBackend\.automations\.(?:list|listRuns|save|delete|trigger)\b/);
  assert.doesNotMatch(
    sources.app,
    /\b(?:automationFromRecord|automationRunFromRecord|automationSaveInputFromDraft|createAutomationDraft|shouldRunAutomationSchedule)\b/,
  );
  assert.doesNotMatch(sources.app, /setInterval\([^)]*runScheduledAutomations/);
  assert.match(
    sources.app,
    /const automationDraftKey = selection\?\.kind === "automation"[\s\S]*?automationOwnerEpochKey/,
  );
  assert.match(sources.app, /<AutomationPanel\s+key=\{automationOwnerEpochKey\}/);

  const coordinator = parse("automationWorkspaceCoordinator.ts", sources.coordinator);
  const factory = directFunction(coordinator, "createAutomationWorkspaceCoordinator");
  const scheduledTick = variableFunctionBody(factory.body!, "runScheduledTick");
  assert.equal(allCalls(scheduledTick, "Promise.all").length, 0);
  const loops: ts.ForOfStatement[] = [];
  visit(scheduledTick, (node) => {
    if (ts.isForOfStatement(node)) loops.push(node);
  });
  assert.equal(loops.length, 1);
  assert.equal(allCalls(loops[0].statement, "runForLease").length, 1);
  const loopAwaits: ts.AwaitExpression[] = [];
  visit(loops[0].statement, (node) => {
    if (ts.isAwaitExpression(node)) loopAwaits.push(node);
  });
  assert.equal(loopAwaits.length, 1, "the scheduler loop must contain one serial await");
  assert.equal(
    allCalls(loopAwaits[0].expression, "runForLease").length,
    1,
    "the sole scheduler await must recursively own one runForLease call",
  );
  const schedulerStateNames: string[] = [];
  visit(factory.body!, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "schedulerRunning" || node.name.text === "pendingScheduledBatch")
    ) {
      schedulerStateNames.push(node.name.text);
    }
  });
  assert.deepEqual(schedulerStateNames.sort(), ["pendingScheduledBatch", "schedulerRunning"]);
  assert.doesNotMatch(sources.coordinator, /\bschedulerDrain\b/);
});

test("command palette awaits runs and AutomationPanel keeps rejected ownership dirty", () => {
  const appFile = parse("App.tsx", sources.app);
  const executeHandlers: ts.ArrowFunction[] = [];
  visit(appFile, (node) => {
    if (!ts.isPropertyAssignment(node) || node.name.getText(appFile) !== "execute") return;
    if (!ts.isArrowFunction(node.initializer)) return;
    if (allCalls(node.initializer, "handleAutomationRun").length === 1) {
      executeHandlers.push(node.initializer);
    }
  });
  assert.equal(executeHandlers.length, 1);
  const execute = executeHandlers[0];
  assert.ok(
    (ts.getModifiers(execute) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ),
  );
  assert.ok(ts.isBlock(execute.body));
  assert.equal(execute.body.statements.length, 1);
  const executeStatement = execute.body.statements[0];
  assert.ok(ts.isExpressionStatement(executeStatement));
  assert.ok(ts.isAwaitExpression(executeStatement.expression));
  assert.equal(
    compact(executeStatement.expression.expression, appFile),
    "handleAutomationRun(automation.id)",
  );
  let voidCalls = 0;
  visit(execute, (node) => {
    if (ts.isVoidExpression(node)) voidCalls += 1;
  });
  assert.equal(voidCalls, 0);

  const panelFile = parse("AutomationPanel.tsx", sources.panel);
  const panel = directFunction(panelFile, "AutomationPanel");
  const handleSubmits: ts.ArrowFunction[] = [];
  visit(panel.body!, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "handleSubmit" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      handleSubmits.push(node.initializer);
    }
  });
  assert.equal(handleSubmits.length, 1);
  const handleSubmit = handleSubmits[0];
  assert.ok(ts.isBlock(handleSubmit.body));
  const submitBody = handleSubmit.body;
  const acceptedGuard: ts.IfStatement[] = [];
  visit(submitBody, (node) => {
    if (
      ts.isIfStatement(node) &&
      compact(node.expression, panelFile) === "accepted===false"
    ) {
      acceptedGuard.push(node);
    }
  });
  assert.equal(acceptedGuard.length, 1);
  assert.ok(ts.isReturnStatement(acceptedGuard[0].thenStatement));
  assert.equal(acceptedGuard[0].thenStatement.expression, undefined);
  const guardEnd = acceptedGuard[0].end;
  for (const path of ["saveLastAiCmd", "setDraftClean", "setCreatingMode"]) {
    const calls = allCalls(submitBody, path);
    assert.ok(calls.length >= 1, `${path} must remain in the successful submit tail`);
    assert.ok(
      calls.every((call) => call.getStart(panelFile) > guardEnd),
      `${path} must follow accepted=false`,
    );
  }
});
