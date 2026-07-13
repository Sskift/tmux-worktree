import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const workspaceSource = readFileSync(
  new URL("../src/dashboard/hooks/useWorkspaceCatalog.ts", import.meta.url),
  "utf8",
);
const pollingSource = readFileSync(
  new URL("../src/dashboard/hooks/useVisibilityAwarePolling.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

function parse(name: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function path(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = path(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : null;
  }
  return null;
}

function directFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assert.equal(matches.length, 1);
  assert.ok(matches[0].body);
  return matches[0];
}

function calls(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && path(node.expression) === name) found.push(node);
  });
  return found;
}

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

test("workspace ownership has no render publication and uses exact ordered layout phases", () => {
  const sourceFile = parse("useWorkspaceCatalog.ts", workspaceSource);
  const hook = directFunction(sourceFile, "useWorkspaceCatalog");
  const phase = directFunction(sourceFile, "useWorkspaceCatalogOwnerPhase");
  assert.equal(calls(hook.body!, "useLayoutEffect").length, 0);
  assert.equal(calls(hook.body!, "useEffect").length, 0);
  const renderCurrentWrites: ts.BinaryExpression[] = [];
  visit(hook.body!, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "current"
    ) {
      renderCurrentWrites.push(node);
    }
  });
  assert.deepEqual(renderCurrentWrites, []);

  const phases = calls(phase.body!, "useLayoutEffect");
  assert.equal(phases.length, 2);
  const contextCallback = phases[0].arguments[0];
  const contextDeps = phases[0].arguments[1];
  assert.ok(ts.isArrowFunction(contextCallback) && ts.isBlock(contextCallback.body));
  assert.ok(contextDeps && ts.isArrayLiteralExpression(contextDeps));
  assert.deepEqual(
    contextDeps.elements.map((element) => compact(element, sourceFile)),
    ["dashboardBackend", "onFullCatalogPublished", "ownerPhase", "registration", "sessionOrder"],
  );
  assert.deepEqual(
    contextCallback.body.statements.map((statement) => compact(statement, sourceFile)),
    [
      "registration.backend=dashboardBackend;",
      "registration.sessionOrder=sessionOrder;",
      "registration.onFullCatalogPublished=onFullCatalogPublished;",
      "constownerCommit=registration.fence.commit(dashboardBackend);",
      "if(!ownerCommit.changed)return;",
      "registration.firstGeneration=registration.generation.started+1;",
      "registration.ownerPublishedGeneration=0;",
      "registration.sessions=[];",
      "registration.discoveredTerminals=[];",
      "registration.previousActivity=newMap();",
      "registration.sessionActivity={};",
      "registration.failedSessionHostIds=[];",
      "registration.failedTerminalHostIds=[];",
      "registration.error=null;",
    ],
  );

  const lifecycleCallback = phases[1].arguments[0];
  const lifecycleDeps = phases[1].arguments[1];
  assert.ok(ts.isArrowFunction(lifecycleCallback) && ts.isBlock(lifecycleCallback.body));
  assert.ok(lifecycleDeps && ts.isArrayLiteralExpression(lifecycleDeps));
  assert.deepEqual(
    lifecycleDeps.elements.map((element) => compact(element, sourceFile)),
    ["ownerPhase", "registration"],
  );
  assert.deepEqual(
    lifecycleCallback.body.statements.map((statement) => compact(statement, sourceFile)),
    [
      "constactivation=registration.fence.activate();",
      "return()=>{registration.fence.deactivate(activation);};",
    ],
  );
});

test("polling publishes task identity only in layout commit and keeps one passive controller", () => {
  const sourceFile = parse("useVisibilityAwarePolling.ts", pollingSource);
  const hook = directFunction(sourceFile, "useVisibilityAwarePolling");
  const layout = calls(hook.body!, "useLayoutEffect");
  const passive = calls(hook.body!, "useEffect");
  assert.equal(layout.length, 1);
  assert.equal(passive.length, 1);
  assert.equal(compact(layout[0].arguments[0], sourceFile), "()=>{taskRef.current=task;}");
  assert.equal(compact(layout[0].arguments[1], sourceFile), "[task]");
  assert.equal(
    compact(passive[0].arguments[1], sourceFile),
    "[enabled,hiddenIntervalMs,refreshKey,restartKey,visibleIntervalMs]",
  );
  const hookStatements = hook.body!.statements.map((statement) => compact(statement, sourceFile));
  assert.equal(hookStatements.filter((statement) => statement.includes("taskRef.current=task")).length, 1);
});

test("App commits the catalog owner directly after the hook and before layout hydration", () => {
  const sourceFile = parse("App.tsx", appSource);
  const app = directFunction(sourceFile, "App");
  const statements = app.body!.statements;
  const callIndex = (name: string) => statements.findIndex((statement) => calls(statement, name).length > 0);
  const catalogIndex = callIndex("useWorkspaceCatalog");
  const ownerIndex = callIndex("useWorkspaceCatalogOwnerPhase");
  const layoutIndex = callIndex("useDashboardLayoutHydrationPhase");
  assert.ok(catalogIndex >= 0 && ownerIndex >= 0 && layoutIndex >= 0);
  assert.equal(ownerIndex, catalogIndex + 1);
  assert.equal(layoutIndex, ownerIndex + 1);
  const catalogCall = calls(statements[catalogIndex], "useWorkspaceCatalog")[0];
  assert.equal(compact(catalogCall.arguments[0], sourceFile), "dashboardBackend");
  const ownerCall = calls(statements[ownerIndex], "useWorkspaceCatalogOwnerPhase")[0];
  assert.equal(compact(ownerCall.arguments[0], sourceFile), "workspaceCatalogOwnerPhase");
  assert.equal(
    compact(ownerCall.arguments[1], sourceFile),
    "{dashboardBackend,sessionOrder,onFullCatalogPublished:handleFullCatalogPublished,}",
  );
});
