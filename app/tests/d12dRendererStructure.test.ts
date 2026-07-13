import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  model: readFileSync(
    new URL("../src/dashboard/model/workspacePresentation.ts", import.meta.url),
    "utf8",
  ),
  hook: readFileSync(
    new URL("../src/dashboard/hooks/useWorkspacePresentation.ts", import.meta.url),
    "utf8",
  ),
  primary: readFileSync(
    new URL("../src/dashboard/WorkspacePrimaryView.tsx", import.meta.url),
    "utf8",
  ),
  contexts: readFileSync(
    new URL("../src/dashboard/WorkspaceContextViews.tsx", import.meta.url),
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

function compact(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
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
  const calls: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (ts.isCallExpression(node) && expressionPath(node.expression) === path) {
      calls.push(node);
    }
  });
  return calls;
}

function callsWithLeaf(root: ts.Node, leaf: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(root, (node) => {
    if (!ts.isCallExpression(node)) return;
    const path = expressionPath(node.expression);
    if (path?.split(".").at(-1) === leaf) calls.push(node);
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
      ) {
        matches.push(declaration.initializer);
      }
    }
  }
  assert.equal(matches.length, 1, `expected one direct variable call ${name}`);
  return matches[0];
}

function callbackBody(call: ts.CallExpression): ts.Block {
  const callback = call.arguments[0];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)));
  assert.ok(ts.isBlock(callback.body));
  return callback.body;
}

function effectDependencies(call: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  assert.equal(call.arguments.length, 2);
  const dependencies = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  return dependencies.elements.map((element) => compact(element, sourceFile));
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function exportedNames(sourceFile: ts.SourceFile, rejectReexports = true): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      assert.equal(rejectReexports, false, "canonical owners cannot re-export hidden implementations");
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      assert.equal(rejectReexports, false, "canonical owners cannot re-export hidden implementations");
      names.push("default");
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      assert.ok(statement.name);
      names.push(statement.name.getText(sourceFile));
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(...bindingNames(declaration.name));
      }
      continue;
    }
    assert.fail(`unsupported export ${ts.SyntaxKind[statement.kind]}`);
  }
  assert.equal(new Set(names).size, names.length, "duplicate exports are forbidden");
  return names.sort();
}

function importModules(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return [];
    assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
    return [statement.moduleSpecifier.text];
  });
}

const canonicalExports = new Map<string, readonly string[]>([
  ["dashboard/model/workspacePresentation.ts", [
    "WorkspaceBranchSource",
    "WorkspaceBranchValue",
    "WorkspaceDiffContext",
    "WorkspaceFilesContext",
    "WorkspaceGitContext",
    "WorkspacePresentation",
    "WorkspacePresentationInput",
    "WorkspacePrimaryContext",
    "deriveWorkspacePresentation",
  ]],
  ["dashboard/hooks/useWorkspacePresentation.ts", [
    "useWorkspaceBranchPhase",
    "useWorkspaceHomePhase",
    "useWorkspacePresentation",
    "useWorkspacePresentationOwnerPhase",
  ]],
  ["dashboard/WorkspacePrimaryView.tsx", ["WorkspacePrimaryView"]],
  ["dashboard/WorkspaceContextViews.tsx", [
    "WorkspaceDiffView",
    "WorkspaceFilesView",
    "WorkspaceGitView",
  ]],
]);

test("workspace presentation owners have exact exports and a one-way DAG", () => {
  const files = new Map([
    ["dashboard/model/workspacePresentation.ts", parse("workspacePresentation.ts", sources.model)],
    ["dashboard/hooks/useWorkspacePresentation.ts", parse("useWorkspacePresentation.ts", sources.hook)],
    ["dashboard/WorkspacePrimaryView.tsx", parse("WorkspacePrimaryView.tsx", sources.primary)],
    ["dashboard/WorkspaceContextViews.tsx", parse("WorkspaceContextViews.tsx", sources.contexts)],
  ]);
  for (const [path, expected] of canonicalExports) {
    assert.deepEqual(exportedNames(files.get(path)!), [...expected].sort(), path);
  }

  const reachable = readRendererImplementationFiles();
  for (const [ownerPath, names] of canonicalExports) {
    for (const name of names) {
      const owners = reachable.flatMap(({ path, source }) =>
        exportedNames(parse(path, source), false).includes(name) ? [path] : []
      );
      assert.deepEqual(owners, [ownerPath], `${name} must have one production owner`);
    }
  }

  assert.deepEqual(importModules(files.get("dashboard/model/workspacePresentation.ts")!).sort(), [
    "../../automationTypes",
    "../../platform",
    "../layout/types",
    "./selection",
    "./sessionActivity",
    "./terminalIdentity",
    "./workspaceSelectors",
  ].sort());
  assert.deepEqual(importModules(files.get("dashboard/hooks/useWorkspacePresentation.ts")!).sort(), [
    "../../platform",
    "../model/workspacePresentation",
    "../ownerEpochLease",
    "react",
  ].sort());
  assert.deepEqual(importModules(files.get("dashboard/WorkspacePrimaryView.tsx")!).sort(), [
    "../FileEditor",
    "./TerminalDeck",
    "./WorkspaceContextViews",
    "./model/workspacePresentation",
    "lucide-react",
    "react",
  ].sort());
  assert.deepEqual(importModules(files.get("dashboard/WorkspaceContextViews.tsx")!).sort(), [
    "../DiffViewer",
    "../FileTree",
    "../GitStatusPanel",
    "./model/workspacePresentation",
  ].sort());

  const modelFile = files.get("dashboard/model/workspacePresentation.ts")!;
  const platformImports = modelFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../../platform",
  );
  assert.equal(platformImports.length, 1);
  assert.ok(platformImports[0].importClause);
  assert.equal(
    platformImports[0].importClause.isTypeOnly,
    true,
    "the model platform edge must remain type-only",
  );
  assert.equal(
    modelFile.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "react",
    ),
    false,
    "the pure model cannot import or alias React",
  );
  assert.equal(
    modelFile.statements.some(ts.isImportEqualsDeclaration),
    false,
    "the pure model cannot hide runtime aliases behind import equals",
  );

  assert.doesNotMatch(sources.model, /from ["']react["']|use[A-Z]|DashboardBackend|window\.|document\.|localStorage|fetch\(/);
  assert.doesNotMatch(
    `${sources.primary}\n${sources.contexts}`,
    /dashboard\/hooks|use[A-Z][A-Za-z]+\(|DashboardBackend|useDashboardBackend|from ["'][^"']*platform[^"']*["']|from ["'][^"']*App[^"']*["']/,
  );
  assert.doesNotMatch(sources.hook, /WorkspacePrimaryView|WorkspaceContextViews/);
  assert.doesNotMatch(sources.model, /WorkspacePrimaryView|WorkspaceContextViews|useWorkspacePresentation/);
});

test("presentation state and phases preserve exact effect ownership and branch fencing", () => {
  const sourceFile = parse("useWorkspacePresentation.ts", sources.hook);
  const reactImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react",
  );
  assert.equal(reactImports.length, 1);
  const reactClause = reactImports[0].importClause;
  assert.ok(reactClause);
  assert.equal(reactClause.name, undefined, "React default aliases are forbidden");
  assert.ok(reactClause.namedBindings && ts.isNamedImports(reactClause.namedBindings));
  assert.deepEqual(
    reactClause.namedBindings.elements.map((element) => {
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
  const state = directFunction(sourceFile, "useWorkspacePresentation");
  const owner = directFunction(sourceFile, "useWorkspacePresentationOwnerPhase");
  const home = directFunction(sourceFile, "useWorkspaceHomePhase");
  const branch = directFunction(sourceFile, "useWorkspaceBranchPhase");
  assert.ok(state.body && owner.body && home.body && branch.body);
  assert.equal(callsWithLeaf(state.body, "useEffect").length, 0);
  assert.equal(callsWithLeaf(state.body, "useLayoutEffect").length, 0);
  assert.equal(directCalls(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithPath(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithLeaf(owner.body, "useLayoutEffect").length, 2);
  assert.equal(callsWithLeaf(owner.body, "useEffect").length, 0);
  const homeEffects = directCalls(home.body, "useEffect");
  const branchEffects = directCalls(branch.body, "useEffect");
  assert.equal(homeEffects.length, 1);
  assert.equal(branchEffects.length, 1);
  assert.equal(callsWithLeaf(home.body, "useEffect").length, 1);
  assert.equal(callsWithLeaf(home.body, "useLayoutEffect").length, 0);
  assert.equal(callsWithLeaf(branch.body, "useEffect").length, 1);
  assert.equal(callsWithLeaf(branch.body, "useLayoutEffect").length, 0);

  const homeBody = callbackBody(homeEffects[0]);
  assert.match(
    compact(homeBody.statements[0], sourceFile),
    /^constlease=registration\.fence\.capture\(dashboardBackend\);$/,
  );
  assert.equal(callsWithPath(homeBody, "dashboardBackend.persistence.homeDirectory").length, 1);
  assert.deepEqual(effectDependencies(homeEffects[0], sourceFile), [
    "dashboardBackend",
    "registration",
    "setHomeDirectory",
  ]);

  const branchBody = callbackBody(branchEffects[0]);
  assert.match(
    compact(branchBody.statements[0], sourceFile),
    /^constqueryLease=registration\.fence\.capture\(dashboardBackend\);$/,
  );
  assert.equal(callsWithPath(branchBody, "dashboardBackend.git.status").length, 1);
  assert.equal(callsWithPath(branchBody, "publishWorkspaceBranch").length, 0);
  assert.match(
    compact(branchBody, sourceFile),
    /constrequest:WorkspaceBranchRequest=\{lease:queryLease,sourceKey:source\.key,token:Symbol\(source\.key\),\};/,
  );
  assert.match(compact(branchBody, sourceFile), /registration\.branchRequest=request/);
  assert.match(compact(branchBody, sourceFile), /branchRequestIsCurrent\(registration,request\)/);
  assert.deepEqual(effectDependencies(branchEffects[0], sourceFile), [
    "dashboardBackend",
    "binding",
    "registration",
    "setWorkspaceBranch",
    "sourceHostId",
    "source.key",
    "source.kind",
    "sourceCwd",
  ]);

  const publisher = directVariableCall(branch.body, "publishWorkspaceBranch");
  assert.equal(expressionPath(publisher.expression), "useCallback");
  const publisherBody = callbackBody(publisher);
  assert.equal(callsWithPath(publisherBody, "registration.fence.capture").length, 0);
  assert.equal(
    compact(publisherBody.statements[0], sourceFile),
    "if(!binding||!registration.fence.isCurrent(binding.lease))return;",
  );
  assert.equal(
    compact(publisherBody.statements[1], sourceFile),
    "if(registration.branchBinding!==binding)return;",
  );
  assert.match(compact(publisherBody, sourceFile), /sourceKey:binding\.sourceKey,value:branch/);
});

function directTopLevelCalls(
  body: ts.Block,
): Array<{ path: string; index: number; call: ts.CallExpression }> {
  const result: Array<{ path: string; index: number; call: ts.CallExpression }> = [];
  for (const [index, statement] of body.statements.entries()) {
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
      if (path) result.push({ path, index, call });
    }
  }
  return result;
}

test("App delegates presentation and freezes passive ordinals 8 through 26", () => {
  const sourceFile = parse("App.tsx", sources.app);
  const app = directFunction(sourceFile, "App");
  assert.ok(app.body);
  assert.ok(sources.app.split(/\r?\n/).length <= 1650, "App must remain at most 1650 lines");
  assert.doesNotMatch(
    sources.app,
    /const renderFiles|const renderGit|const renderDiff|const selectedAutomation\s*=|const selectedAutomationProjectPath\s*=|const selectedGitHostId\s*=|const selectedCwd(?::[^=]+)?\s*=|const desktopRoot\s*=|const fileBrowserRoot\s*=|const workspaceStatus|const workspaceTitle|const workspaceProject/,
  );
  assert.equal(callsWithPath(app.body, "deriveWorkspacePresentation").length, 1);
  assert.equal(callsWithPath(app.body, "dashboardBackend.persistence.homeDirectory").length, 0);
  assert.equal(callsWithPath(app.body, "dashboardBackend.git.status").length, 0);
  for (const forbidden of ["TerminalDeck", "FileEditor", "FileTree", "GitStatusPanel", "DiffViewer"]) {
    assert.equal(importModules(sourceFile).some((module) => module.endsWith(`/${forbidden}`)), false);
  }

  const contributions = new Map<string, number>([
    ["useDashboardBackend", 0],
    ["useDashboardLayoutState", 0],
    ["useTerminalMetadata", 0],
    ["useAutomationWorkspace", 0],
    ["useConnectionCatalog", 0],
    ["useConnectionCatalogOwnerPhase", 0],
    ["useConnectionCatalogSyncPhase", 4],
    ["useMobileRelayController", 3],
    ["useTerminalDeckState", 0],
    ["useTerminalDeckOwnerPhase", 0],
    ["useWorkspacePresentation", 0],
    ["useWorkspacePresentationOwnerPhase", 0],
    ["useEditorNavigationGuard", 0],
    ["useWorkspaceHomePhase", 1],
    ["useDashboardViewportResizePhase", 1],
    ["useDashboardWindowCapturePhase", 1],
    ["useTerminalMetadataHydrationPhase", 1],
    ["useWorkspaceCatalog", 0],
    ["useWorkspaceCatalogOwnerPhase", 0],
    ["useDashboardLayoutHydrationPhase", 1],
    ["useTerminalMetadataPersistencePhase", 2],
    ["useDashboardLayoutPersistencePhase", 1],
    ["useAutomationWorkspaceOwnerPhase", 0],
    ["useAutomationWorkspaceHydrationPhase", 1],
    ["useEffect", 1],
    ["useCatalogSelectionHydration", 1],
    ["useTerminalDeckPreviewPhase", 1],
    ["useVisibilityAwarePolling", 1],
    ["useAutomationWorkspaceSchedulerPhase", 1],
    ["useTerminalDeckAttachPhase", 3],
    ["useWorkspaceBranchPhase", 1],
  ]);
  const expectedOrdinals = new Map<string, number>([
    ["useWorkspaceHomePhase", 8],
    ["useDashboardViewportResizePhase", 9],
    ["useDashboardWindowCapturePhase", 10],
    ["useDashboardLayoutHydrationPhase", 12],
    ["useDashboardLayoutPersistencePhase", 15],
    ["useCatalogSelectionHydration", 19],
    ["useTerminalDeckPreviewPhase", 20],
    ["useVisibilityAwarePolling", 21],
    ["useAutomationWorkspaceSchedulerPhase", 22],
    ["useTerminalDeckAttachPhase", 25],
    ["useWorkspaceBranchPhase", 26],
  ]);
  let ordinal = 0;
  const seen = new Map<string, number>();
  for (const { path } of directTopLevelCalls(app.body)) {
    const contribution = contributions.get(path);
    if (contribution === undefined) continue;
    ordinal += contribution;
    if (expectedOrdinals.has(path)) {
      assert.equal(seen.has(path), false, `${path} must be unique`);
      seen.set(path, ordinal);
    }
  }
  assert.deepEqual(seen, expectedOrdinals);

  const branchCalls = directTopLevelCalls(app.body).filter(
    ({ path }) => path === "useWorkspaceBranchPhase",
  );
  assert.equal(branchCalls.length, 1);
  assert.deepEqual(
    branchCalls[0].call.arguments.map((argument) => compact(argument, sourceFile)),
    [
      "workspacePresentationController",
      "dashboardBackend",
      "workspacePresentation.branchSource",
    ],
  );
});

test("primary and context views retain exact leaf ownership without hook backedges", () => {
  const primaryFile = parse("WorkspacePrimaryView.tsx", sources.primary);
  const contextFile = parse("WorkspaceContextViews.tsx", sources.contexts);
  const primary = directFunction(primaryFile, "WorkspacePrimaryView");
  assert.ok(primary.body);
  const terminalDecks: ts.JsxSelfClosingElement[] = [];
  visit(primary.body, (node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(primaryFile) === "TerminalDeck"
    ) {
      terminalDecks.push(node);
    }
  });
  assert.equal(terminalDecks.length, 1);
  assert.equal(sources.app.match(/<TerminalDeck\b/g)?.length ?? 0, 0);
  assert.match(sources.app, /terminalDeckKey=\{terminalDeckOwnerEpochKey\}/);
  assert.match(sources.primary, /<TerminalDeck key=\{terminalDeckKey\} \{\.\.\.terminalDeckProps\} \/>/);
  assert.match(sources.app, /key=\{`\$\{terminalDeckOwnerEpochKey\}:\$\{key\}`\}/);
  assert.equal(sources.app.match(/terminalDeckKey=\{terminalDeckOwnerEpochKey\}/g)?.length, 1);
  assert.equal(sources.app.match(/key=\{`\$\{terminalDeckOwnerEpochKey\}:\$\{key\}`\}/g)?.length, 1);
  assert.doesNotMatch(`${sources.primary}\n${sources.contexts}`, /useWorkspacePresentation|useTerminalDeck[A-Z]/);
  assert.equal(callsWithPath(contextFile, "useEffect").length, 0);
});
