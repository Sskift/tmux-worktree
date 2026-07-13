import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { readRendererImplementationTree } from "./helpers/rendererImplementationSource.ts";

const deckSource = readFileSync(
  new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const primarySource = readFileSync(
  new URL("../src/dashboard/WorkspacePrimaryView.tsx", import.meta.url),
  "utf8",
);
const contextViewsSource = readFileSync(
  new URL("../src/dashboard/WorkspaceContextViews.tsx", import.meta.url),
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

function pathOf(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = pathOf(expression.expression);
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

function allCalls(node: ts.Node, path: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(node, (candidate) => {
    if (ts.isCallExpression(candidate) && pathOf(candidate.expression) === path) {
      calls.push(candidate);
    }
  });
  return calls;
}

function directCalls(body: ts.Block, path: string): ts.CallExpression[] {
  return body.statements.flatMap((statement) =>
    ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      pathOf(statement.expression.expression) === path
      ? [statement.expression]
      : []
  );
}

function dependencies(call: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  assert.equal(call.arguments.length, 2);
  const value = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(value));
  return value.elements.map((element) => compact(element, sourceFile));
}

function exportedFunctions(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) return [];
    const exported = (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    return exported ? [statement.name.text] : [];
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

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
}

function assertAncestorChain(
  node: ts.Node,
  root: ts.Node,
  description: string,
): void {
  let current: ts.Node | undefined = node;
  while (current && current !== root) {
    assert.equal(
      isFunctionLikeNode(current),
      false,
      `${description} cannot be hidden in a nested function`,
    );
    assert.equal(
      ts.isConditionalExpression(current),
      false,
      `${description} cannot be conditional`,
    );
    assert.equal(
      ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
      false,
      `${description} cannot be behind a logical condition`,
    );
    current = current.parent;
  }
  assert.equal(current, root, `${description} must belong to the canonical JSX tree`);
}

function assertCanonicalPrimaryDeck(source: string): void {
  const sourceFile = parse("WorkspacePrimaryView.tsx", source);
  const primary = directFunction(sourceFile, "WorkspacePrimaryView");
  assert.ok(primary.body);
  const returns = primary.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1, "primary must have one top-level return");
  assert.ok(returns[0].expression, "primary return must contain JSX");
  const root = unwrapParentheses(returns[0].expression);
  assert.ok(ts.isJsxElement(root), "primary must return one canonical JSX element");
  assert.equal(root.openingElement.tagName.getText(sourceFile), "section");

  const terminalDecks: ts.JsxSelfClosingElement[] = [];
  visit(primary.body, (node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "TerminalDeck"
    ) {
      terminalDecks.push(node);
    }
  });
  assert.equal(terminalDecks.length, 1);
  assertAncestorChain(terminalDecks[0], root, "TerminalDeck");

  const attributes = terminalDecks[0].attributes.properties;
  const keys = attributes.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "key",
  );
  const spreads = attributes.filter(ts.isJsxSpreadAttribute);
  assert.equal(keys.length, 1);
  assert.equal(compact(keys[0].initializer!, sourceFile), "{terminalDeckKey}");
  assert.equal(spreads.length, 1);
  assert.equal(compact(spreads[0].expression, sourceFile), "terminalDeckProps");
}

function assertAppPrimaryInCentralWorkspace(source: string): void {
  const sourceFile = parse("App.tsx", source);
  const app = directFunction(sourceFile, "App");
  assert.ok(app.body);
  const centralWorkspace = directVariable(app.body, "centralWorkspace");
  assert.ok(centralWorkspace.initializer);
  const root = unwrapParentheses(centralWorkspace.initializer);
  assert.ok(ts.isJsxElement(root), "centralWorkspace must be a JSX root");

  const primaryElements: ts.JsxSelfClosingElement[] = [];
  visit(app.body, (node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "WorkspacePrimaryView"
    ) {
      primaryElements.push(node);
    }
  });
  assert.equal(primaryElements.length, 1);
  assertAncestorChain(primaryElements[0], root, "WorkspacePrimaryView");
  const terminalDeckKeys = primaryElements[0].attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      property.name.getText(sourceFile) === "terminalDeckKey",
  );
  assert.equal(terminalDeckKeys.length, 1);
  assert.equal(
    compact(terminalDeckKeys[0].initializer!, sourceFile),
    "{terminalDeckOwnerEpochKey}",
  );
}

test("terminal deck has an exact owner phase and no workspace-catalog backedge", () => {
  const sourceFile = parse("useTerminalDeckState.ts", deckSource);
  assert.deepEqual(exportedFunctions(sourceFile), [
    "useTerminalDeckState",
    "useTerminalDeckOwnerPhase",
    "useTerminalDeckPreviewPhase",
    "useTerminalDeckAttachPhase",
  ]);
  assert.equal(
    sourceFile.statements.filter(ts.isExportDeclaration).length,
    0,
    "the canonical owner cannot re-export a hidden implementation",
  );
  assert.doesNotMatch(deckSource, /from\s+["']\.\/useWorkspaceCatalog["']/);
  assert.doesNotMatch(deckSource, /\bFullCatalogPublished\b/);

  const state = directFunction(sourceFile, "useTerminalDeckState");
  assert.ok(state.body);
  assert.equal(state.parameters.length, 1);
  assert.equal(compact(state.parameters[0].name, sourceFile), "dashboardBackend");
  assert.equal(allCalls(state.body, "useEffect").length, 0);
  assert.equal(allCalls(state.body, "useLayoutEffect").length, 0);
  assert.equal(allCalls(state.body, "useState").length, 7);
  assert.equal(allCalls(state.body, "useRef").length, 5);
  assert.equal(allCalls(state.body, "useCallback").length, 5);
  for (const callback of allCalls(state.body, "useCallback")) {
    assert.deepEqual(dependencies(callback, sourceFile), ["lease", "registration"]);
  }
  const fullCut = directVariableCall(state.body, "handleFullCatalogPublished");
  assert.equal(allCalls(fullCut.arguments[0], "registration.fence.capture").length, 0);
  assert.match(
    compact(fullCut.arguments[0], sourceFile),
    /^\(\{sessionNames,\}:TerminalDeckCatalogPublication\)=>\{if\(!lease\|\|!registration\.fence\.isCurrent\(lease\)\)return;/,
  );

  const request = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "TerminalDeckRequest",
  );
  assert.ok(request && ts.isTypeReferenceNode(request.type));
  assert.equal(request.type.typeName.getText(sourceFile), "Readonly");
  assert.equal(request.type.typeArguments?.length, 1);
  const requestShape = request.type.typeArguments![0];
  assert.ok(ts.isTypeLiteralNode(requestShape));
  assert.deepEqual(
    requestShape.members.map((member) => {
      assert.ok(ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name));
      return member.name.text;
    }),
    ["lease", "incarnation", "token"],
  );

  const sessionFingerprint = directFunction(sourceFile, "sessionIncarnation");
  const terminalFingerprint = directFunction(sourceFile, "terminalIncarnation");
  assert.match(
    compact(sessionFingerprint, sourceFile),
    /session\.name,session\.created,session\.hostId\?\?null,session\.rawName\?\?session\.name/,
  );
  assert.match(
    compact(terminalFingerprint, sourceFile),
    /terminal\.id,terminal\.tmuxName,terminal\.hostId\?\?null,terminal\.rawName\?\?terminal\.tmuxName,objectIncarnation/,
  );
  assert.match(compact(terminalFingerprint, sourceFile), /registration\.terminalIncarnations\.get\(terminal\)/);

  const owner = directFunction(sourceFile, "useTerminalDeckOwnerPhase");
  assert.ok(owner.body);
  const layoutEffects = directCalls(owner.body, "useLayoutEffect");
  assert.equal(layoutEffects.length, 2);
  assert.deepEqual(dependencies(layoutEffects[0], sourceFile), [
    "dashboardBackend",
    "ownerPhase",
    "registration",
  ]);
  assert.deepEqual(dependencies(layoutEffects[1], sourceFile), [
    "ownerPhase",
    "registration",
  ]);
  const ownerText = compact(owner.body, sourceFile);
  assert.match(ownerText, /registration\.terminalIncarnations=newWeakMap\(\)/);
  assert.match(ownerText, /registration\.nextTerminalIncarnation=1/);
  for (const stateName of [
    "setOpenedSessions([])",
    "setOpenedTerminals([])",
    "setTmuxPreviews({})",
    "setCwdsBySession({})",
  ]) {
    assert.match(ownerText, new RegExp(stateName.replace(/[()[\]{}]/g, "\\$&")));
  }
  for (const mapName of [
    "cwdRequested",
    "cwdIncarnations",
    "tmuxPreviewRequested",
    "tmuxPreviewLiveRef",
    "tmuxPreviewIncarnations",
  ]) {
    assert.match(ownerText, new RegExp(`${mapName}\\.current=newMap\\(\\)`));
  }
  assert.match(ownerText, /registration\.fence\.deactivate\(activation\)/);
});

test("preview and attach retain one plus three passive effects with exact owner tokens", () => {
  const sourceFile = parse("useTerminalDeckState.ts", deckSource);
  const preview = directFunction(sourceFile, "useTerminalDeckPreviewPhase");
  const attach = directFunction(sourceFile, "useTerminalDeckAttachPhase");
  assert.ok(preview.body && attach.body);
  const previewEffects = directCalls(preview.body, "useEffect");
  const attachEffects = directCalls(attach.body, "useEffect");
  assert.equal(previewEffects.length, 1);
  assert.equal(attachEffects.length, 3);
  assert.deepEqual(dependencies(previewEffects[0], sourceFile), [
    "dashboardBackend",
    "sessions",
    "allTerminals",
  ]);
  assert.deepEqual(dependencies(attachEffects[0], sourceFile), [
    "dashboardBackend",
    "selection",
    "selectedSession",
    "selectionMetadataPending",
  ]);
  assert.deepEqual(dependencies(attachEffects[1], sourceFile), [
    "dashboardBackend",
    "selection",
    "selectedTerminal",
    "selectionMetadataPending",
  ]);
  assert.deepEqual(dependencies(attachEffects[2], sourceFile), [
    "dashboardBackend",
    "allTerminals",
  ]);
  const previewText = compact(previewEffects[0], sourceFile);
  const rootText = compact(attachEffects[0], sourceFile);
  for (const text of [previewText, rootText]) {
    assert.match(text, /registration\.fence\.capture\(dashboardBackend\)/);
    assert.match(text, /registration\.fence\.isCurrent\(lease\)/);
    assert.match(text, /token:Symbol\(name\)/);
  }
  assert.match(previewText, /tmuxPreviewRequested\.current\.get\(name\)!==request/);
  assert.match(previewText, /tmuxPreviewLiveRef\.current\.get\(name\)!==incarnation/);
  assert.match(rootText, /cwdRequested\.current\.get\(name\)!==request/);
  assert.match(
    rootText,
    /if\(cwdRequested\.current\.get\(name\)===request\)\{cwdRequested\.current\.delete\(name\);\}/,
  );
  assert.match(deckSource, /const PRELOAD_HISTORY_LINES = 300;/);
});

test("App commits terminal ownership and remounts main and scratch PTYs by owner epoch", () => {
  const sourceFile = parse("App.tsx", appSource);
  const primaryFile = parse("WorkspacePrimaryView.tsx", primarySource);
  const app = directFunction(sourceFile, "App");
  const primary = directFunction(primaryFile, "WorkspacePrimaryView");
  assert.ok(app.body);
  assert.ok(primary.body);
  const stateCalls = allCalls(app.body, "useTerminalDeckState");
  const ownerCalls = allCalls(app.body, "useTerminalDeckOwnerPhase");
  assert.equal(stateCalls.length, 1);
  assert.equal(ownerCalls.length, 1);
  assert.equal(compact(stateCalls[0].arguments[0], sourceFile), "dashboardBackend");
  assert.deepEqual(
    ownerCalls[0].arguments.map((argument) => compact(argument, sourceFile)),
    ["terminalDeckOwnerPhase", "dashboardBackend"],
  );
  assert.equal(allCalls(app.body, "useTerminalDeckPreviewPhase").length, 1);
  assert.equal(allCalls(app.body, "useTerminalDeckAttachPhase").length, 1);
  for (const [handler, setter] of [
    ["closeSession", "setOpenedSessions"],
    ["closeTerminal", "setOpenedTerminals"],
  ] as const) {
    const call = directVariableCall(app.body, handler);
    const deps = call.arguments[1];
    assert.ok(ts.isArrayLiteralExpression(deps));
    assert.equal(
      deps.elements.some((element) => compact(element, sourceFile) === setter),
      true,
      `${handler} must refresh with the exact owner-bound setter`,
    );
  }

  const scratchKeys: ts.JsxAttribute[] = [];
  visit(app.body, (node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sourceFile) === "key" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      compact(node.initializer.expression, sourceFile).includes("terminalDeckOwnerEpochKey")
    ) {
      scratchKeys.push(node);
    }
  });
  assertAppPrimaryInCentralWorkspace(appSource);
  assert.equal(scratchKeys.length, 1, "App scratch key must include the epoch exactly once");
  assert.match(appSource, /key=\{`\$\{terminalDeckOwnerEpochKey\}:\$\{key\}`\}/);
  assertCanonicalPrimaryDeck(primarySource);
  assert.equal(appSource.match(/<TerminalDeck\b/g)?.length ?? 0, 0);
  assert.equal(readRendererImplementationTree().match(/<TerminalDeck\b/g)?.length, 1);
  assert.doesNotMatch(`${primarySource}\n${contextViewsSource}`, /useTerminalDeck[A-Z]/);
});

test("canonical deck and App primary locators reject nested or conditional decoys", () => {
  const primaryPreamble = `
    declare const terminalDeckKey: string;
    declare const terminalDeckProps: Record<string, unknown>;
    declare function TerminalDeck(props: unknown): JSX.Element;
  `;
  assert.throws(() => assertCanonicalPrimaryDeck(`${primaryPreamble}
    export function WorkspacePrimaryView() {
      function hidden() {
        return <TerminalDeck key={terminalDeckKey} {...terminalDeckProps} />;
      }
      return <section>{null}</section>;
    }
  `));
  assert.throws(() => assertCanonicalPrimaryDeck(`${primaryPreamble}
    export function WorkspacePrimaryView() {
      return <section>{true ? <TerminalDeck key={terminalDeckKey} {...terminalDeckProps} /> : null}</section>;
    }
  `));
  assert.throws(() => assertAppPrimaryInCentralWorkspace(`
    declare const terminalDeckOwnerEpochKey: string;
    declare function WorkspacePrimaryView(props: unknown): JSX.Element;
    export function App() {
      const centralWorkspace = <div />;
      const hidden = () => <WorkspacePrimaryView terminalDeckKey={terminalDeckOwnerEpochKey} />;
      return <main>{hidden()}</main>;
    }
  `));
});
