import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function compact(node: ts.Node, file: ts.SourceFile): string {
  return node.getText(file).replace(/\s+/g, "");
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function callCount(file: ts.SourceFile, expression: string): number {
  let count = 0;
  visit(file, (node) => {
    if (
      ts.isCallExpression(node) &&
      compact(node.expression, file) === expression
    ) {
      count += 1;
    }
  });
  return count;
}

function interfaceDeclaration(
  file: ts.SourceFile,
  name: string,
): ts.InterfaceDeclaration {
  const matches = file.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  assert.equal(matches.length, 1);
  return matches[0];
}

function memberName(member: ts.TypeElement): string {
  assert.ok(member.name && ts.isIdentifier(member.name));
  return member.name.text;
}

test("close lifecycle types expose one optional atomic transport capability", () => {
  const types = parse("platform/types.ts");
  const closeHandler = types.statements.filter(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "DashboardCloseHandler",
  );
  assert.equal(closeHandler.length, 1);
  assert.equal(
    compact(closeHandler[0].type, types),
    "(signal:AbortSignal,)=>void|Promise<void>",
  );

  const lifecycle = interfaceDeclaration(types, "DashboardWindowCloseLifecycle");
  assert.deepEqual(lifecycle.members.map(memberName), ["bind"]);
  assert.equal(
    compact(lifecycle.members[0], types),
    "bind(handler:DashboardCloseHandler):BackendUnlisten;",
  );
  const transport = interfaceDeclaration(types, "DashboardTransport");
  const closeMembers = transport.members.filter(
    (member) => memberName(member) === "closeLifecycle",
  );
  assert.equal(closeMembers.length, 1);
  assert.ok(ts.isPropertySignature(closeMembers[0]));
  assert.ok(closeMembers[0].questionToken);
  assert.equal(closeMembers[0].type?.getText(types), "DashboardWindowCloseLifecycle");
});

test("the raw Tauri close capability is atomic and construction caches one window", () => {
  const factory = parse("platform/tauriTransportFactory.ts");
  const rawLifecycle = interfaceDeclaration(
    factory,
    "RawDashboardWindowCloseLifecycle",
  );
  assert.deepEqual(rawLifecycle.members.map(memberName), [
    "onCloseRequested",
    "destroy",
  ]);
  for (const member of rawLifecycle.members) assert.equal(member.questionToken, undefined);

  const rawWindow = interfaceDeclaration(factory, "RawDashboardWindow");
  const rawNames = rawWindow.members.map(memberName);
  assert.equal(rawNames.includes("onCloseRequested"), false);
  assert.equal(rawNames.includes("destroy"), false);
  const capability = rawWindow.members.find(
    (member) => memberName(member) === "closeLifecycle",
  );
  assert.ok(capability && ts.isPropertySignature(capability));
  assert.ok(capability.questionToken);
  assert.equal(
    capability.type?.getText(factory),
    "RawDashboardWindowCloseLifecycle",
  );
  assert.equal(callCount(factory, "dependencies.currentWindow"), 1);
  assert.equal(callCount(factory, "createWindowCloseBridge"), 1);
});

test("the Tauri backend caches one native window and injects destroy without close", () => {
  const backend = parse("platform/tauriBackend.ts");
  assert.equal(callCount(backend, "getCurrentWindow"), 1);
  assert.equal(callCount(backend, "currentWindow.destroy"), 1);
  assert.equal(callCount(backend, "currentWindow.close"), 0);
  const closeLifecycleProperties: ts.PropertyAssignment[] = [];
  visit(backend, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "closeLifecycle"
    ) {
      closeLifecycleProperties.push(node);
    }
  });
  assert.equal(closeLifecycleProperties.length, 1);
  assert.ok(ts.isObjectLiteralExpression(closeLifecycleProperties[0].initializer));
  assert.deepEqual(
    closeLifecycleProperties[0].initializer.properties.map((property) => {
      assert.ok(property.name && ts.isIdentifier(property.name));
      return property.name.text;
    }),
    ["onCloseRequested", "destroy"],
  );
});

test("main resolves fake before a literal dynamic Tauri import", () => {
  const main = parse("main.tsx");
  const imports = main.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => {
      assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
      return statement.moduleSpecifier.text;
    });
  assert.equal(imports.includes("./platform/tauriBackend"), false);

  const functions = main.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "resolveDashboardBackend",
  );
  assert.equal(functions.length, 1);
  assert.ok(functions[0].body);
  const statements = functions[0].body.statements;
  const previewIf = statements.findIndex(
    (statement) =>
      ts.isIfStatement(statement) &&
      compact(statement.expression, main) === "previewRequested",
  );
  assert.ok(previewIf >= 0);
  assert.equal(
    compact(statements[previewIf], main),
    'if(previewRequested){constpreview=awaitimport("./platform/previewBackend");returnpreview.previewDashboardBackend;}',
  );
  assert.equal(
    compact(statements[previewIf + 1], main),
    'consttauri=awaitimport("./platform/tauriBackend");',
  );
  assert.equal(
    compact(statements[previewIf + 2], main),
    "returntauri.tauriDashboardBackend;",
  );
});

test("the main capability adds destroy and does not grant native close", () => {
  const capability = JSON.parse(
    readFileSync(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ) as { permissions: string[] };
  assert.deepEqual(capability.permissions, [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-is-fullscreen",
    "core:window:allow-is-maximized",
    "core:window:allow-inner-size",
    "core:window:allow-set-size",
    "core:window:allow-destroy",
    "core:window:allow-scale-factor",
    "dialog:default",
  ]);
  assert.equal(capability.permissions.includes("core:window:allow-close"), false);
});
