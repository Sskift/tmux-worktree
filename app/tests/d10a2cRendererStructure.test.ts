import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { readRendererImplementationFiles } from "./helpers/rendererImplementationSource.ts";

const sources = {
  app: readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  deck: readFileSync(
    new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
    "utf8",
  ),
  selection: readFileSync(
    new URL(
      "../src/dashboard/hooks/useCatalogSelectionHydration.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  polling: readFileSync(
    new URL(
      "../src/dashboard/hooks/useVisibilityAwarePolling.ts",
      import.meta.url,
    ),
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
    "canonical owners cannot be facades",
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
): Array<{ call: ts.CallExpression; index: number; declaration?: ts.VariableDeclaration }> {
  const matches: Array<{
    call: ts.CallExpression;
    index: number;
    declaration?: ts.VariableDeclaration;
  }> = directCalls(body, path);
  for (const [index, statement] of body.statements.entries()) {
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
  return matches.sort((left, right) => left.index - right.index);
}

function hookPathLeaf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function directEffectRegistrations(
  body: ts.Block,
): Array<{ call: ts.CallExpression; index: number; path: string }> {
  return body.statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      return [];
    }
    const path = expressionPath(statement.expression.expression);
    return path && hookPathLeaf(path) === "useEffect"
      ? [{ call: statement.expression, index, path }]
      : [];
  });
}

function directHookRegistrationsBetween(
  body: ts.Block,
  start: number,
  end: number,
): string[] {
  const names: string[] = [];
  for (const statement of body.statements.slice(start + 1, end)) {
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
      if (path && /^use[A-Z]/.test(hookPathLeaf(path))) names.push(path);
    }
  }
  return names;
}

type CriticalPhaseIndices = {
  selection: number;
  preview: number;
  polling: number;
  scheduler: number;
  attach: number;
  git: number;
};

function assertCriticalPhaseIntervals(
  body: ts.Block,
  indices: CriticalPhaseIndices,
): void {
  const directEffects = directEffectRegistrations(body);
  const effectsBetween = (start: number, end: number) =>
    directEffects.filter(({ index }) => start < index && index < end);
  assert.equal(effectsBetween(indices.selection, indices.preview).length, 0);
  assert.equal(effectsBetween(indices.preview, indices.polling).length, 0);
  assert.equal(effectsBetween(indices.polling, indices.scheduler).length, 0);
  assert.equal(effectsBetween(indices.scheduler, indices.attach).length, 0);
  assert.equal(effectsBetween(indices.attach, indices.git).length, 0);

  assert.deepEqual(directHookRegistrationsBetween(body, indices.selection, indices.preview), []);
  assert.deepEqual(directHookRegistrationsBetween(body, indices.preview, indices.polling), []);
  assert.deepEqual(
    directHookRegistrationsBetween(body, indices.polling, indices.scheduler),
    ["useCallback", "useCallback", "useCallback", "useCallback", "useCallback"],
  );
  assert.deepEqual(directHookRegistrationsBetween(body, indices.scheduler, indices.attach), []);
  assert.deepEqual(directHookRegistrationsBetween(body, indices.attach, indices.git), []);
}

function directVariable(
  body: ts.Block,
  name: string,
): { declaration: ts.VariableDeclaration; index: number } {
  const matches: Array<{ declaration: ts.VariableDeclaration; index: number }> = [];
  for (const [index, statement] of body.statements.entries()) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push({ declaration, index });
      }
    }
  }
  assert.equal(matches.length, 1, `expected one direct variable ${name}`);
  return matches[0];
}

function effectDependencies(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string[] {
  assert.equal(call.arguments.length, 2);
  const dependencies = call.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  return dependencies.elements.map((element) => element.getText(sourceFile));
}

function effectBody(call: ts.CallExpression): ts.Block {
  assert.equal(expressionPath(call.expression), "useEffect");
  const callback = call.arguments[0];
  assert.ok(
    callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)),
  );
  assert.ok(ts.isBlock(callback.body));
  return callback.body;
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

const deckExports = [
  "useTerminalDeckAttachPhase",
  "useTerminalDeckPreviewPhase",
  "useTerminalDeckState",
] as const;

const stateInventory = [
  "openedSessions,setOpenedSessions",
  "openedTerminals,setOpenedTerminals",
  "tmuxPreviews,setTmuxPreviews",
  "cwdsBySession,setCwdsBySession",
  "cwdRequested",
  "tmuxPreviewRequested",
  "tmuxPreviewLiveRef",
  "handleFullCatalogPublished",
  "return",
] as const;

type StateAnalysis = {
  sourceFile: ts.SourceFile;
  body: ts.Block;
  callback: ts.ArrowFunction;
};

function assertState(source: string): StateAnalysis {
  const sourceFile = parse("useTerminalDeckState.ts", source);
  const state = directFunction(sourceFile, "useTerminalDeckState");
  const body = state.body;
  assert.ok(body);
  const inventory = body.statements.map((statement) => {
    if (ts.isReturnStatement(statement)) return "return";
    assert.ok(ts.isVariableStatement(statement));
    assert.equal(statement.declarationList.declarations.length, 1);
    return bindingNames(statement.declarationList.declarations[0].name).join(",");
  });
  assert.deepEqual(inventory, stateInventory);
  assert.equal(callsWithPath(body, "useState").length, 4);
  assert.equal(callsWithPath(body, "useRef").length, 3);
  assert.equal(callsWithPath(body, "useCallback").length, 1);
  assert.equal(callsWithPath(body, "useEffect").length, 0);
  assert.equal(callsWithPath(body, "useMemo").length, 0);

  const stateInitializers = new Map<string, string>([
    ["openedSessions", "useState<string[]>([])"],
    ["openedTerminals", "useState<string[]>([])"],
    ["tmuxPreviews", "useState<Record<string,string>>({})"],
    ["cwdsBySession", "useState<Record<string,string>>({})"],
  ]);
  for (const [value, expected] of stateInitializers) {
    const matches: ts.VariableDeclaration[] = body.statements.flatMap((statement) => {
      if (!ts.isVariableStatement(statement)) return [];
      const declaration = statement.declarationList.declarations[0];
      return bindingNames(declaration.name).includes(value) ? [declaration] : [];
    });
    assert.equal(matches.length, 1);
    assert.equal(compact(matches[0].initializer!, sourceFile), expected);
  }

  const callbackDeclaration = directVariable(
    body,
    "handleFullCatalogPublished",
  ).declaration;
  assert.ok(
    callbackDeclaration.initializer &&
      ts.isCallExpression(callbackDeclaration.initializer),
  );
  assert.equal(expressionPath(callbackDeclaration.initializer.expression), "useCallback");
  assert.equal(callbackDeclaration.initializer.arguments.length, 2);
  const dependencies = callbackDeclaration.initializer.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(dependencies));
  assert.equal(dependencies.elements.length, 0);
  const callback = callbackDeclaration.initializer.arguments[0];
  assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  assert.equal(hasModifier(callback, ts.SyntaxKind.AsyncKeyword), false);
  assert.equal(callback.parameters.length, 1);
  const parameter = callback.parameters[0];
  assert.equal(parameter.dotDotDotToken, undefined);
  assert.equal(parameter.initializer, undefined);
  assert.ok(ts.isObjectBindingPattern(parameter.name));
  assert.equal(parameter.name.elements.length, 1);
  const [sessionNames] = parameter.name.elements;
  assert.equal(sessionNames.dotDotDotToken, undefined);
  assert.equal(sessionNames.propertyName, undefined);
  assert.equal(sessionNames.initializer, undefined);
  assert.ok(ts.isIdentifier(sessionNames.name));
  assert.equal(sessionNames.name.text, "sessionNames");
  assert.ok(parameter.type);
  assert.equal(compact(parameter.type, sourceFile), "FullCatalogPublished");
  return { sourceFile, body, callback };
}

type AppPhaseAnalysis = {
  sourceFile: ts.SourceFile;
  app: ts.FunctionDeclaration;
  selection: { call: ts.CallExpression; index: number };
  preview: { call: ts.CallExpression; index: number };
  polling: { call: ts.CallExpression; index: number };
  attach: { call: ts.CallExpression; index: number };
};

function identifierCount(root: ts.Node, name: string): number {
  let count = 0;
  visit(root, (node) => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
  });
  return count;
}

function assertAppPhaseRegistration(source: string): AppPhaseAnalysis {
  const sourceFile = parse("App.tsx", source);
  const app = directFunction(sourceFile, "App");
  const body = app.body;
  assert.ok(body);
  const registrations = {
    selection: directTopLevelCalls(body, "useCatalogSelectionHydration"),
    preview: directTopLevelCalls(body, "useTerminalDeckPreviewPhase"),
    polling: directTopLevelCalls(body, "useVisibilityAwarePolling"),
    attach: directTopLevelCalls(body, "useTerminalDeckAttachPhase"),
  };
  const names = {
    selection: "useCatalogSelectionHydration",
    preview: "useTerminalDeckPreviewPhase",
    polling: "useVisibilityAwarePolling",
    attach: "useTerminalDeckAttachPhase",
  } as const;
  for (const key of Object.keys(registrations) as Array<keyof typeof registrations>) {
    const name = names[key];
    assert.equal(registrations[key].length, 1, `${name} must be a direct App call`);
    assert.equal(callsWithPath(body, name).length, 1, `${name} must have one full-tree call`);
    assert.equal(identifierCount(body, name), 1, `${name} cannot be locally aliased`);
  }

  const preview = registrations.preview[0];
  assert.equal(preview.call.arguments.length, 3);
  assert.equal(expressionPath(preview.call.arguments[0]), "terminalDeck");
  assert.equal(expressionPath(preview.call.arguments[1]), "dashboardBackend");
  const previewOptions = preview.call.arguments[2];
  assert.ok(ts.isObjectLiteralExpression(previewOptions));
  const previewProperties = directObjectProperties(previewOptions);
  assert.deepEqual(previewProperties.names, ["sessions", "allTerminals"]);

  const attach = registrations.attach[0];
  assert.equal(attach.call.arguments.length, 3);
  assert.equal(expressionPath(attach.call.arguments[0]), "terminalDeck");
  assert.equal(expressionPath(attach.call.arguments[1]), "dashboardBackend");
  const attachOptions = attach.call.arguments[2];
  assert.ok(ts.isObjectLiteralExpression(attachOptions));
  const attachProperties = directObjectProperties(attachOptions);
  assert.deepEqual(attachProperties.names, [
    "selection",
    "selectedSession",
    "selectedTerminal",
    "selectionMetadataPending",
    "allTerminals",
  ]);
  for (const properties of [previewProperties, attachProperties]) {
    for (const name of properties.names) {
      assert.equal(
        compact(propertyInitializer(properties.byName.get(name)), sourceFile),
        name,
      );
    }
  }

  return {
    sourceFile,
    app,
    selection: registrations.selection[0],
    preview,
    polling: registrations.polling[0],
    attach,
  };
}

test("terminal deck hooks have one reachable canonical owner and an exact API", () => {
  const sourceFile = parse("useTerminalDeckState.ts", sources.deck);
  assertExactCanonicalExport(sourceFile, deckExports);
  assert.deepEqual(importManifest(sourceFile), [
    "../../platform|DashboardBackend|DashboardBackend|type",
    "../../platform|PlainTerminal|PlainTerminal|type",
    "../../platform|Session|Session|type",
    "../model/catalogEquality|sameStringArray|sameStringArray|value",
    "../model/catalogEquality|sameStringRecord|sameStringRecord|value",
    "../model/selection|Selection|Selection|type",
    "../model/terminalIdentity|terminalSessionKey|terminalSessionKey|value",
    "react|Dispatch|Dispatch|type",
    "react|MutableRefObject|MutableRefObject|type",
    "react|SetStateAction|SetStateAction|type",
    "react|useCallback|useCallback|value",
    "react|useEffect|useEffect|value",
    "react|useRef|useRef|value",
    "react|useState|useState|value",
    "./useWorkspaceCatalog|FullCatalogPublished|FullCatalogPublished|type",
  ].sort());
  assert.deepEqual(sourceFile.referencedFiles, []);
  assert.deepEqual(sourceFile.typeReferenceDirectives, []);
  assert.deepEqual(sourceFile.libReferenceDirectives, []);
  visit(sourceFile, (node) => {
    assert.ok(!ts.isImportEqualsDeclaration(node));
    assert.ok(!ts.isImportTypeNode(node));
    assert.ok(
      !(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword),
    );
    assert.ok(
      !(ts.isCallExpression(node) && expressionPath(node.expression) === "require"),
    );
  });

  const reachable = readRendererImplementationFiles();
  assert.ok(
    reachable.some(({ path }) => path === "dashboard/hooks/useTerminalDeckState.ts"),
  );
  for (const name of deckExports) {
    const owners = reachable.flatMap(({ path, source }) =>
      exportedNames(parse(path, source))
        .filter((candidate) => candidate.runtime && candidate.name === name)
        .map(() => path)
    );
    assert.deepEqual(owners, ["dashboard/hooks/useTerminalDeckState.ts"]);
  }

  const appFile = parse("App.tsx", sources.app);
  const canonicalImports = appFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./dashboard/hooks/useTerminalDeckState",
  );
  assert.equal(canonicalImports.length, 1);
  const bindings = canonicalImports[0].importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  assert.deepEqual(
    bindings.elements.map((element) => ({
      imported: element.propertyName?.text ?? element.name.text,
      local: element.name.text,
      typeOnly: canonicalImports[0].importClause!.isTypeOnly || element.isTypeOnly,
    })),
    deckExports.map((name) => ({ imported: name, local: name, typeOnly: false })),
  );

  const decoy = parse("decoy.ts", `
    export const useTerminalDeckState = () => {};
    const preview = () => {};
    export { preview as useTerminalDeckPreviewPhase };
    export { attach as useTerminalDeckAttachPhase } from "./hidden";
  `);
  assert.throws(() => assertExactCanonicalExport(decoy, deckExports));
});

test("terminal deck state owns exactly four states, three refs, and the synchronous full cut", () => {
  const {
    sourceFile,
    body: stateBody,
    callback: callbackBody,
  } = assertState(sources.deck);

  for (const name of [
    "cwdRequested",
    "tmuxPreviewRequested",
    "tmuxPreviewLiveRef",
  ]) {
    const declaration: ts.VariableDeclaration = directVariable(stateBody, name).declaration;
    assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
    assert.equal(expressionPath(declaration.initializer.expression), "useRef");
    assert.equal(compact(declaration.initializer.arguments[0], sourceFile), "newSet()");
  }

  const fullCutBody = callbackBody.body;
  assert.ok(ts.isBlock(fullCutBody));
  assert.equal(fullCutBody.statements.length, 3);
  const [live, sessionCut, cwdCut] = fullCutBody.statements;
  assert.ok(ts.isVariableStatement(live));
  assert.equal(
    compact(live.declarationList.declarations[0].initializer!, sourceFile),
    "newSet(sessionNames)",
  );
  assert.equal(
    compact(sessionCut, sourceFile),
    "setOpenedSessions((previous)=>{constnext=previous.filter((name)=>live.has(name));returnsameStringArray(previous,next)?previous:next;});",
  );
  assert.equal(
    compact(cwdCut, sourceFile),
    "setCwdsBySession((previous)=>{constnext:Record<string,string>={};for(const[name,cwd]ofObject.entries(previous)){if(live.has(name))next[name]=cwd;}returnsameStringRecord(previous,next)?previous:next;});",
  );
  assert.equal(callsWithPath(fullCutBody, "setOpenedSessions").length, 1);
  assert.equal(callsWithPath(fullCutBody, "setCwdsBySession").length, 1);
  assert.equal(callsWithPath(fullCutBody, "setTimeout").length, 0);
  assert.equal(callsWithPath(fullCutBody, "queueMicrotask").length, 0);

  const returns = stateBody.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1);
  assert.ok(returns[0].expression && ts.isObjectLiteralExpression(returns[0].expression));
  const returnProperties = directObjectProperties(returns[0].expression);
  assert.deepEqual(returnProperties.names, [
    "openedSessions",
    "setOpenedSessions",
    "openedTerminals",
    "setOpenedTerminals",
    "tmuxPreviews",
    "setTmuxPreviews",
    "cwdsBySession",
    "setCwdsBySession",
    "cwdRequested",
    "tmuxPreviewRequested",
    "tmuxPreviewLiveRef",
    "handleFullCatalogPublished",
  ]);
  for (const name of returnProperties.names) {
    assert.equal(
      compact(propertyInitializer(returnProperties.byName.get(name)), sourceFile),
      name,
    );
  }
});

test("preview phase preserves live gates, serial preload, and exact dependencies", () => {
  const sourceFile = parse("useTerminalDeckState.ts", sources.deck);
  const preview = directFunction(sourceFile, "useTerminalDeckPreviewPhase");
  assert.ok(preview.body);
  assert.equal(preview.parameters.length, 3);
  assert.ok(ts.isIdentifier(preview.parameters[0].name));
  assert.equal(preview.parameters[0].name.text, "controller");
  assert.ok(ts.isIdentifier(preview.parameters[1].name));
  assert.equal(preview.parameters[1].name.text, "dashboardBackend");
  assert.ok(ts.isObjectBindingPattern(preview.parameters[2].name));
  assert.deepEqual(bindingNames(preview.parameters[2].name), ["sessions", "allTerminals"]);
  assert.equal(preview.body.statements.length, 2);
  assert.ok(ts.isVariableStatement(preview.body.statements[0]));
  assert.deepEqual(
    bindingNames(preview.body.statements[0].declarationList.declarations[0].name),
    ["setTmuxPreviews", "tmuxPreviewLiveRef", "tmuxPreviewRequested"],
  );
  const effects = directCalls(preview.body, "useEffect");
  assert.equal(effects.length, 1);
  assert.equal(effects[0].index, 1);
  assert.equal(callsWithPath(preview.body, "useEffect").length, 1);
  assert.deepEqual(effectDependencies(effects[0].call, sourceFile), [
    "sessions",
    "allTerminals",
  ]);
  const body = effectBody(effects[0].call);
  assert.equal(body.statements.length, 6);
  const [names, live, publishLive, clearRequests, prune, preload] = body.statements;
  assert.ok(ts.isVariableStatement(names));
  assert.equal(
    compact(names.declarationList.declarations[0].initializer!, sourceFile),
    "[...sessions.map((session)=>session.name),...allTerminals.map(terminalSessionKey),]",
  );
  assert.ok(ts.isVariableStatement(live));
  assert.equal(
    compact(live.declarationList.declarations[0].initializer!, sourceFile),
    "newSet(names)",
  );
  assert.equal(
    compact(publishLive, sourceFile),
    "tmuxPreviewLiveRef.current=live;",
  );
  assert.equal(
    compact(clearRequests, sourceFile),
    "for(constnameofArray.from(tmuxPreviewRequested.current)){if(!live.has(name))tmuxPreviewRequested.current.delete(name);}",
  );
  assert.equal(
    compact(prune, sourceFile),
    "setTmuxPreviews((prev)=>{constnext:Record<string,string>={};for(const[name,history]ofObject.entries(prev)){if(live.has(name))next[name]=history;}returnsameStringRecord(prev,next)?prev:next;});",
  );
  assert.ok(ts.isExpressionStatement(preload));
  assert.ok(ts.isCallExpression(preload.expression));
  const preloadFunction = unwrapParentheses(preload.expression.expression);
  assert.ok(ts.isArrowFunction(preloadFunction) && ts.isBlock(preloadFunction.body));
  assert.equal(hasModifier(preloadFunction, ts.SyntaxKind.AsyncKeyword), true);
  assert.equal(preloadFunction.body.statements.length, 1);
  assert.equal(
    compact(preloadFunction.body.statements[0], sourceFile),
    "for(constnameofnames){if(tmuxPreviewRequested.current.has(name))continue;tmuxPreviewRequested.current.add(name);consthistory=awaitdashboardBackend.sessions.captureHistory(name,PRELOAD_HISTORY_LINES).catch(()=>\"\");if(!tmuxPreviewLiveRef.current.has(name)){tmuxPreviewRequested.current.delete(name);continue;}setTmuxPreviews((prev)=>(prev[name]===history?prev:{...prev,[name]:history}));}",
  );
  assert.equal(callsWithPath(preloadFunction.body, "dashboardBackend.sessions.captureHistory").length, 1);
  assert.match(sources.deck, /const PRELOAD_HISTORY_LINES = 300;/);
});

test("attach phase preserves three ordered barriers, dependencies, and cleanup semantics", () => {
  const sourceFile = parse("useTerminalDeckState.ts", sources.deck);
  const attach = directFunction(sourceFile, "useTerminalDeckAttachPhase");
  assert.ok(attach.body);
  assert.equal(attach.parameters.length, 3);
  assert.ok(ts.isIdentifier(attach.parameters[0].name));
  assert.equal(attach.parameters[0].name.text, "controller");
  assert.ok(ts.isIdentifier(attach.parameters[1].name));
  assert.equal(attach.parameters[1].name.text, "dashboardBackend");
  assert.ok(ts.isObjectBindingPattern(attach.parameters[2].name));
  assert.deepEqual(bindingNames(attach.parameters[2].name), [
    "selection",
    "selectedSession",
    "selectedTerminal",
    "selectionMetadataPending",
    "allTerminals",
  ]);
  assert.equal(attach.body.statements.length, 4);
  assert.ok(ts.isVariableStatement(attach.body.statements[0]));
  assert.deepEqual(
    bindingNames(attach.body.statements[0].declarationList.declarations[0].name),
    [
      "cwdRequested",
      "cwdsBySession",
      "setCwdsBySession",
      "setOpenedSessions",
      "setOpenedTerminals",
    ],
  );
  const effects = directCalls(attach.body, "useEffect");
  assert.equal(effects.length, 3);
  assert.deepEqual(effects.map(({ index }) => index), [1, 2, 3]);
  assert.equal(callsWithPath(attach.body, "useEffect").length, 3);
  assert.deepEqual(effectDependencies(effects[0].call, sourceFile), [
    "dashboardBackend",
    "selection",
    "selectedSession",
    "selectionMetadataPending",
    "cwdsBySession",
  ]);
  assert.deepEqual(effectDependencies(effects[1].call, sourceFile), [
    "selection",
    "selectedTerminal",
    "selectionMetadataPending",
  ]);
  assert.deepEqual(effectDependencies(effects[2].call, sourceFile), [
    "allTerminals",
  ]);
  assert.equal(
    compact(effectBody(effects[0].call), sourceFile),
    "{if(selection?.kind!==\"session\")return;if(!selectedSession||selectionMetadataPending)return;constname=selection.name;setOpenedSessions((prev)=>prev.includes(name)?prev:[...prev,name],);if(cwdsBySession[name]||cwdRequested.current.has(name))return;cwdRequested.current.add(name);dashboardBackend.sessions.root(name).then((cwd)=>{if(cwd)setCwdsBySession((prev)=>({...prev,[name]:cwd}));}).catch(()=>{}).finally(()=>{cwdRequested.current.delete(name);});}",
  );
  assert.equal(
    compact(effectBody(effects[1].call), sourceFile),
    "{if(selection?.kind!==\"terminal\")return;if(!selectedTerminal||selectionMetadataPending)return;constid=selection.id;setOpenedTerminals((prev)=>prev.includes(id)?prev:[...prev,id],);}",
  );
  assert.equal(
    compact(effectBody(effects[2].call), sourceFile),
    "{constliveTerminalIds=newSet(allTerminals.map((terminal)=>terminal.id));setOpenedTerminals((prev)=>{constnext=prev.filter((id)=>liveTerminalIds.has(id));returnsameStringArray(prev,next)?prev:next;});}",
  );
});

test("App preserves the global deck phase order and direct controller wiring", () => {
  const {
    sourceFile: appFile,
    app,
    selection: selectionCall,
    preview: previewCall,
    polling: pollingCall,
    attach: attachCall,
  } = assertAppPhaseRegistration(sources.app);
  const appBody = app.body;
  assert.ok(appBody);
  const stateCalls = directTopLevelCalls(appBody, "useTerminalDeckState");
  const workspaceCalls = directTopLevelCalls(appBody, "useWorkspaceCatalog");
  for (const [name, calls] of [
    ["state", stateCalls],
    ["workspace", workspaceCalls],
  ] as const) {
    assert.equal(calls.length, 1, `expected one direct App ${name} registration`);
  }

  const handleAutomationCreate = directVariable(appBody, "handleAutomationCreate");
  const handleAutomationRun = directVariable(appBody, "handleAutomationRun");
  const selectedAutomation = directVariable(appBody, "selectedAutomation");
  const appEffects = directEffectRegistrations(appBody);
  const schedulers = appEffects.filter(({ call }) =>
    callsWithPath(call.arguments[0], "shouldRunAutomationSchedule").length === 1
  );
  const gitEffects = appEffects.filter(({ call }) =>
    callsWithPath(call.arguments[0], "dashboardBackend.git.status").length === 1
  );
  assert.equal(schedulers.length, 1);
  assert.equal(gitEffects.length, 1);
  const order: Array<[string, number]> = [
    ["terminal deck state", stateCalls[0].index],
    ["workspace catalog", workspaceCalls[0].index],
    ["selection effect 19", selectionCall.index],
    ["preview effect 20", previewCall.index],
    ["workspace polling effect 21", pollingCall.index],
    ["automation create", handleAutomationCreate.index],
    ["automation run", handleAutomationRun.index],
    ["automation scheduler effect 22", schedulers[0].index],
    ["attach effects 23-25", attachCall.index],
    ["selected automation", selectedAutomation.index],
    ["Git effect", gitEffects[0].index],
  ];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(
      order[index - 1][1] < order[index][1],
      `${order[index - 1][0]} must remain before ${order[index][0]}`,
    );
  }

  assertCriticalPhaseIntervals(appBody, {
    selection: selectionCall.index,
    preview: previewCall.index,
    polling: pollingCall.index,
    scheduler: schedulers[0].index,
    attach: attachCall.index,
    git: gitEffects[0].index,
  });

  assert.ok(stateCalls[0].declaration);
  assert.ok(ts.isIdentifier(stateCalls[0].declaration.name));
  assert.equal(stateCalls[0].declaration.name.text, "terminalDeck");
  const deckBindings = appBody.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      declaration.initializer &&
          ts.isIdentifier(declaration.initializer) &&
          declaration.initializer.text === "terminalDeck" &&
          ts.isObjectBindingPattern(declaration.name)
        ? [declaration.name]
        : []
    );
  });
  assert.equal(deckBindings.length, 1);
  assert.deepEqual(
    deckBindings[0].elements.map((element) => {
      assert.equal(element.dotDotDotToken, undefined);
      assert.equal(element.propertyName, undefined);
      assert.equal(element.initializer, undefined);
      assert.ok(ts.isIdentifier(element.name));
      return { property: element.name.text, local: element.name.text };
    }),
    [
      { property: "openedSessions", local: "openedSessions" },
      { property: "setOpenedSessions", local: "setOpenedSessions" },
      { property: "openedTerminals", local: "openedTerminals" },
      { property: "setOpenedTerminals", local: "setOpenedTerminals" },
      { property: "tmuxPreviews", local: "tmuxPreviews" },
      { property: "cwdsBySession", local: "cwdsBySession" },
      {
        property: "handleFullCatalogPublished",
        local: "handleFullCatalogPublished",
      },
    ],
  );

  const workspaceOptions = workspaceCalls[0].call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(workspaceOptions));
  const workspaceProperties = directObjectProperties(workspaceOptions);
  assert.equal(
    compact(
      propertyInitializer(workspaceProperties.byName.get("onFullCatalogPublished")),
      appFile,
    ),
    "handleFullCatalogPublished",
  );
  assert.equal(callsWithPath(appBody, "dashboardBackend.sessions.captureHistory").length, 0);
  assert.equal(callsWithPath(appBody, "setTmuxPreviews").length, 0);
  assert.equal(callsWithPath(appBody, "setCwdsBySession").length, 0);
  assert.doesNotMatch(sources.app, /tmuxPreviewLiveRef|tmuxPreviewRequested|cwdRequested/);

  const selection = directFunction(
    parse("useCatalogSelectionHydration.ts", sources.selection),
    "useCatalogSelectionHydration",
  );
  const preview = directFunction(
    parse("useTerminalDeckState.ts", sources.deck),
    "useTerminalDeckPreviewPhase",
  );
  const polling = directFunction(
    parse("useVisibilityAwarePolling.ts", sources.polling),
    "useVisibilityAwarePolling",
  );
  const attach = directFunction(
    parse("useTerminalDeckState.ts", sources.deck),
    "useTerminalDeckAttachPhase",
  );
  assert.ok(selection.body && preview.body && polling.body && attach.body);
  const selectionContribution = directCalls(selection.body, "useEffect").length;
  const previewContribution = directCalls(preview.body, "useEffect").length;
  const pollingContribution = directCalls(polling.body, "useEffect").length;
  const attachContribution = directCalls(attach.body, "useEffect").length;
  assert.deepEqual(
    [
      selectionContribution,
      previewContribution,
      pollingContribution,
      attachContribution,
    ],
    [1, 1, 1, 3],
  );
  let effectOrdinal = 18;
  effectOrdinal += selectionContribution;
  assert.equal(effectOrdinal, 19);
  effectOrdinal += previewContribution;
  assert.equal(effectOrdinal, 20);
  effectOrdinal += pollingContribution;
  assert.equal(effectOrdinal, 21);
  effectOrdinal += schedulers.length;
  assert.equal(effectOrdinal, 22);
  const attachOrdinals = Array.from({ length: attachContribution }, () => {
    effectOrdinal += 1;
    return effectOrdinal;
  });
  assert.deepEqual(attachOrdinals, [23, 24, 25]);
});

test("deck structure guards reject extra state work and hidden App phase calls", () => {
  const hiddenStateEffect = sources.deck.replace(
    "  return {\n    openedSessions,",
    `  const hiddenEffect = useEffect;
  hiddenEffect(() => {}, []);

  return {
    openedSessions,`,
  );
  assert.notEqual(hiddenStateEffect, sources.deck);
  assert.throws(() => assertState(hiddenStateEffect));

  const appWithPhases = ({
    previewOptions = "{ sessions, allTerminals }",
    extra = "",
  }: {
    previewOptions?: string;
    extra?: string;
  } = {}) => `
    function App() {
      const selectionResult = useCatalogSelectionHydration({});
      useTerminalDeckPreviewPhase(
        terminalDeck,
        dashboardBackend,
        ${previewOptions}
      );
      useVisibilityAwarePolling(refresh, {});
      useTerminalDeckAttachPhase(terminalDeck, dashboardBackend, {
        selection,
        selectedSession,
        selectedTerminal,
        selectionMetadataPending,
        allTerminals,
      });
      ${extra}
    }
  `;
  assert.doesNotThrow(() => assertAppPhaseRegistration(appWithPhases()));
  assert.throws(() => assertAppPhaseRegistration(appWithPhases({
    extra: `
      const hiddenPreview = useTerminalDeckPreviewPhase;
      hiddenPreview(terminalDeck, dashboardBackend, { sessions, allTerminals });
    `,
  })));
  assert.throws(() => assertAppPhaseRegistration(appWithPhases({
    extra: `
      function nested() {
        useTerminalDeckPreviewPhase(
          terminalDeck,
          dashboardBackend,
          { sessions, allTerminals }
        );
      }
    `,
  })));
  assert.throws(() => assertAppPhaseRegistration(appWithPhases({
    previewOptions: "{ ...inputs, sessions, allTerminals }",
  })));

  const appWithCriticalIntervals = ({
    afterPreview = "",
    afterScheduler = "",
  }: {
    afterPreview?: string;
    afterScheduler?: string;
  } = {}) => `
    function App() {
      const selectionResult = useCatalogSelectionHydration({});
      useTerminalDeckPreviewPhase(
        terminalDeck,
        dashboardBackend,
        { sessions, allTerminals }
      );
      ${afterPreview}
      useVisibilityAwarePolling(refresh, {});
      const one = useCallback(() => {}, []);
      const two = useCallback(() => {}, []);
      const three = useCallback(() => {}, []);
      const four = useCallback(() => {}, []);
      const five = useCallback(() => {}, []);
      useEffect(() => {
        shouldRunAutomationSchedule(automation, now);
      }, []);
      ${afterScheduler}
      useTerminalDeckAttachPhase(terminalDeck, dashboardBackend, {
        selection,
        selectedSession,
        selectedTerminal,
        selectionMetadataPending,
        allTerminals,
      });
      useEffect(() => {
        dashboardBackend.git.status(cwd, hostId);
      }, []);
    }
  `;
  const assertSyntheticCriticalIntervals = (source: string) => {
    const analysis = assertAppPhaseRegistration(source);
    const body = analysis.app.body;
    assert.ok(body);
    const effects = directEffectRegistrations(body);
    const scheduler = effects.filter(({ call }) =>
      callsWithPath(call.arguments[0], "shouldRunAutomationSchedule").length === 1
    );
    const git = effects.filter(({ call }) =>
      callsWithPath(call.arguments[0], "dashboardBackend.git.status").length === 1
    );
    assert.equal(scheduler.length, 1);
    assert.equal(git.length, 1);
    assertCriticalPhaseIntervals(body, {
      selection: analysis.selection.index,
      preview: analysis.preview.index,
      polling: analysis.polling.index,
      scheduler: scheduler[0].index,
      attach: analysis.attach.index,
      git: git[0].index,
    });
  };
  assert.doesNotThrow(() =>
    assertSyntheticCriticalIntervals(appWithCriticalIntervals())
  );
  assert.throws(() =>
    assertSyntheticCriticalIntervals(appWithCriticalIntervals({
      afterPreview: "React.useEffect(() => {}, []);",
    }))
  );
  assert.throws(() =>
    assertSyntheticCriticalIntervals(appWithCriticalIntervals({
      afterScheduler: "Hooks.useFoo();",
    }))
  );
});
