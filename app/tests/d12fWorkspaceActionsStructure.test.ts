import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  hook: readFileSync(
    new URL("../src/dashboard/hooks/useWorkspaceActions.ts", import.meta.url),
    "utf8",
  ),
  metadata: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalMetadata.ts", import.meta.url),
    "utf8",
  ),
  worktreeModal: readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8"),
  terminalModal: readFileSync(new URL("../src/NewTerminalModal.tsx", import.meta.url), "utf8"),
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

function callsWithPath(root: ts.Node, path: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) calls.push(node);
  });
  return calls;
}

function directCalls(body: ts.Block, path: string): ts.CallExpression[] {
  return body.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return [];
    }
    return expressionPath(statement.expression.expression) === path
      ? [statement.expression]
      : [];
  });
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
      ) matches.push(declaration.initializer);
    }
  }
  assert.equal(matches.length, 1, `expected one direct variable call ${name}`);
  return matches[0];
}

function jsxElement(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  name: string,
): ts.JsxOpeningLikeElement {
  const matches: ts.JsxOpeningLikeElement[] = [];
  visit(root, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === name
    ) matches.push(node);
  });
  assert.equal(matches.length, 1, `${name} must have one JSX owner`);
  return matches[0];
}

test("workspace actions and terminal metadata cannot bypass committed exact ownership", () => {
  const hookFile = parse("useWorkspaceActions.ts", sources.hook);
  const state = directFunction(hookFile, "useWorkspaceActions");
  const owner = directFunction(hookFile, "useWorkspaceActionsOwnerPhase");
  assert.ok(state.body);
  assert.ok(owner.body);
  assert.equal(callsWithPath(state.body, "useEffect").length, 0);
  assert.equal(callsWithPath(state.body, "useLayoutEffect").length, 0);
  assert.equal(callsWithPath(state.body, "coordinator.commitContext").length, 0);
  assert.equal(callsWithPath(state.body, "coordinator.capture").length, 1);
  for (const [binding, method] of [
    ["rememberAutomationContext", "rememberAutomationContext"],
    ["resolveAutomationRoot", "resolveAutomationRoot"],
    ["createWorktree", "createWorktree"],
    ["restoreWorktree", "restoreWorktree"],
    ["deleteWorktree", "deleteWorktree"],
    ["createTerminal", "createTerminal"],
    ["closeSession", "closeSession"],
    ["closeTerminal", "closeTerminal"],
  ] as const) {
    const callback = directVariableCall(state.body, binding);
    assert.equal(expressionPath(callback.expression), "useCallback");
    const action = callsWithPath(callback.arguments[0], `coordinator.${method}`);
    assert.equal(action.length, 1);
    assert.equal(compact(action[0].arguments[0], hookFile), "renderLease");
    assert.equal(callsWithPath(callback.arguments[0], "coordinator.capture").length, 0);
  }
  assert.equal(directCalls(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithPath(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithPath(owner.body, "useEffect").length, 0);
  assert.equal(callsWithPath(owner.body, "coordinator.commitContext").length, 1);
  assert.equal(callsWithPath(owner.body, "coordinator.activate").length, 1);
  assert.equal(callsWithPath(owner.body, "coordinator.deactivate").length, 1);

  const appFile = parse("App.tsx", sources.app);
  const app = directFunction(appFile, "App");
  assert.ok(app.body);
  const actionState = directVariableCall(app.body, "workspaceActions");
  assert.equal(expressionPath(actionState.expression), "useWorkspaceActions");
  assert.deepEqual(actionState.arguments.map((argument) => compact(argument, appFile)), [
    "dashboardBackend",
  ]);
  const ownerCalls = directCalls(app.body, "useWorkspaceActionsOwnerPhase");
  assert.equal(ownerCalls.length, 1);
  const context = ownerCalls[0].arguments[1];
  assert.ok(ts.isObjectLiteralExpression(context));
  const contextProperties = new Set(context.properties.map((property) => property.name?.getText(appFile)));
  for (const property of [
    "publishPendingSession",
    "publishCreatedTerminal",
    "publishClosedSession",
    "publishClosedTerminal",
    "reconcilePersistedTerminal",
    "refreshWorkspace",
    "refreshProjects",
  ]) assert.equal(contextProperties.has(property), true, `${property} must reach the coordinator`);
  assert.equal(directCalls(app.body, "useTerminalMetadataOwnerPhase").length, 1);
  for (const [publication, setter] of [
    ["publishCreatedTerminal", "terminalMetadata.upsertCreatedTerminal"],
    ["publishClosedSession", "setOpenedSessions"],
    ["publishClosedTerminal", "setOpenedTerminals"],
  ] as const) {
    const callback = directVariableCall(app.body, publication);
    assert.equal(callsWithPath(callback.arguments[0], setter).length, 1);
  }
  for (const path of [
    "dashboardBackend.projects.add",
    "dashboardBackend.worktrees.create",
    "dashboardBackend.worktrees.restore",
    "dashboardBackend.worktrees.delete",
    "dashboardBackend.terminals.create",
    "dashboardBackend.terminals.kill",
    "dashboardBackend.sessions.kill",
    "dashboardBackend.sessions.root",
  ]) assert.equal(callsWithPath(app.body, path).length, 0, `${path} must use the coordinator`);

  for (const [component, keyExpression] of [
    ["NewWorktreeModal", "{`worktree:${workspaceActionOwnerEpochKey}:${workspaceActions.orphanRevision}`}"] ,
    ["NewTerminalModal", "{`terminal:${workspaceActionOwnerEpochKey}`}"] ,
  ] as const) {
    const element = jsxElement(app.body, appFile, component);
    const key = element.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(appFile) === "key",
    );
    assert.ok(key?.initializer);
    assert.equal(
      compact(key.initializer, appFile),
      keyExpression,
    );
  }
  for (const [source, paths] of [
    [sources.worktreeModal, [
      "dashboardBackend.projects.add",
      "dashboardBackend.worktrees.create",
      "dashboardBackend.worktrees.restore",
      "dashboardBackend.worktrees.delete",
    ]],
    [sources.terminalModal, ["dashboardBackend.terminals.create"]],
  ] as const) {
    const modal = parse("modal.tsx", source);
    for (const path of paths) assert.equal(callsWithPath(modal, path).length, 0);
  }
  assert.match(
    sources.worktreeModal,
    /const accepted = await onCreateWorktree\([\s\S]*?if \(!accepted\)[\s\S]*?return;[\s\S]*?saveLastAiCmd/,
  );
  assert.match(
    sources.terminalModal,
    /const accepted = await onCreated\([\s\S]*?if \(!accepted\)[\s\S]*?return;[\s\S]*?saveLastAiCmd/,
  );

  const metadataFile = parse("useTerminalMetadata.ts", sources.metadata);
  const metadataState = directFunction(metadataFile, "useTerminalMetadata");
  const metadataOwner = directFunction(metadataFile, "useTerminalMetadataOwnerPhase");
  assert.ok(metadataState.body);
  assert.ok(metadataOwner.body);
  assert.equal(callsWithPath(metadataState.body, "useEffect").length, 0);
  assert.equal(callsWithPath(metadataState.body, "useLayoutEffect").length, 0);
  assert.equal(callsWithPath(metadataState.body, "registration.fence.commit").length, 0);
  assert.equal(callsWithPath(metadataState.body, "registration.fence.capture").length, 1);
  assert.equal(directCalls(metadataOwner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithPath(metadataOwner.body, "registration.fence.commit").length, 1);
  assert.equal(callsWithPath(metadataOwner.body, "registration.fence.activate").length, 1);
  assert.equal(callsWithPath(metadataOwner.body, "registration.fence.deactivate").length, 1);
});
