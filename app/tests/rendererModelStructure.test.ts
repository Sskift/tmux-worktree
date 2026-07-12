import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  readRendererImplementationFiles,
  readRendererImplementationTree,
} from "./helpers/rendererImplementationSource.ts";

const files = readRendererImplementationFiles();
const filesByPath = new Map(files.map((file) => [file.path, file.source]));
const renderer = readRendererImplementationTree();
const rendererSourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

const canonicalOwners = {
  "dashboard/model/selection.ts": [
    "Selection",
    "PinnedItem",
    "CatalogSelection",
    "PendingCatalogSelection",
    "CatalogHydration",
    "CatalogSelectionResolution",
    "sameCatalogSelection",
    "pendingRestoredCatalogSelection",
    "pendingCreatedCatalogSelection",
    "reconcileCatalogSelection",
  ],
  "dashboard/model/terminalIdentity.ts": [
    "sessionDisplayName",
    "terminalRawName",
    "terminalSessionKey",
    "isInternalTerminalName",
    "basenameFromPath",
    "normalizePlainTerminal",
    "isLocalDiscoveredInternalTerminal",
  ],
  "dashboard/model/sessionActivity.ts": [
    "SessionActivityState",
    "PreviousSessionActivity",
    "SessionActivityInfo",
    "formatActivityAge",
    "describeSessionActivity",
  ],
  "dashboard/model/catalogEquality.ts": [
    "sameStringArray",
    "sameStringRecord",
    "sameSessions",
    "samePlainTerminals",
    "sameSessionActivity",
  ],
  "dashboard/model/catalogSnapshot.ts": [
    "MergedDashboardCatalog",
    "mergeDashboardCatalogSnapshot",
  ],
  "dashboard/model/workspaceSelectors.ts": [
    "SidebarSessionGroup",
    "SidebarConnectionTone",
    "SidebarConnectionSummary",
    "SidebarActivityDescription",
    "groupSessionsByHostProject",
    "summarizeSidebarConnections",
    "describeSidebarActivity",
    "WorkspaceStatus",
    "WORKSPACE_STATUS_LABELS",
    "workspaceStatusLabel",
    "projectKey",
  ],
  "dashboard/layout/types.ts": [
    "WindowLayout",
    "EditingFile",
    "DiffFile",
    "LayoutColumn",
    "SidebarView",
    "PersistedInspectorTab",
    "DashboardLayoutPreferences",
    "ResizablePanel",
    "ViewportTier",
  ],
  "dashboard/layout/schema.ts": [
    "DASHBOARD_LAYOUT_SCHEMA_VERSION",
    "DEFAULT_COLUMN_ORDER",
    "DashboardLayoutDecodeOutcome",
    "DashboardLayoutExtensions",
    "DashboardLayoutInvalidReason",
    "DashboardLayoutV2",
    "normalizeColumnOrder",
    "isDashboardLayoutV2",
    "createDashboardLayoutV2",
    "decodeDashboardLayout",
  ],
  "dashboard/layout/panelGeometry.ts": [
    "DEFAULT_SIDEBAR_WIDTH",
    "DEFAULT_INSPECTOR_WIDTH",
    "DASHBOARD_WIDE_BREAKPOINT",
    "DASHBOARD_SIDEBAR_DOCK_BREAKPOINT",
    "DASHBOARD_MIN_WORKSPACE_WIDTH",
    "DASHBOARD_PANEL_LIMITS",
    "viewportTierForWidth",
    "clampDashboardPanelWidth",
    "clampDashboardPanelWidthForViewport",
    "normalizeDashboardPanelWidths",
    "dashboardPanelWidthFromPointer",
    "dashboardPanelWidthFromKey",
  ],
  "dashboard/layout/scratchGeometry.ts": [
    "SCRATCH_PANEL_LIMITS",
    "DEFAULT_SCRATCH_PANEL_WIDTH",
    "clampScratchPanelWidth",
    "scratchPanelWidthFromPointer",
    "scratchPanelWidthFromKey",
    "scratchPanelMaximumWidth",
  ],
  "terminal/attach.ts": [
    "shellQuoteArg",
    "remoteShellPathExpr",
    "sharedSshConnectionArgs",
    "buildSshAttachArgs",
    "buildSshShellArgs",
  ],
} as const;

function scriptKindForPath(path: string): ts.ScriptKind {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

const canonicalAllowedImports: Record<keyof typeof canonicalOwners, readonly string[]> = {
  "dashboard/model/selection.ts": ["../../platform"],
  "dashboard/model/terminalIdentity.ts": ["../../platform"],
  "dashboard/model/sessionActivity.ts": [],
  "dashboard/model/catalogEquality.ts": ["../../platform", "./sessionActivity"],
  "dashboard/model/catalogSnapshot.ts": ["../../platform"],
  "dashboard/model/workspaceSelectors.ts": ["../../platform", "./sessionActivity"],
  "dashboard/layout/types.ts": ["../model/selection"],
  "dashboard/layout/schema.ts": ["../model/selection", "./types"],
  "dashboard/layout/panelGeometry.ts": ["./types"],
  "dashboard/layout/scratchGeometry.ts": [],
  "terminal/attach.ts": ["../platform"],
};

const historicalFacadeExports = {
  "dashboard/layoutPreferences.ts": {
    DashboardLayoutDecodeOutcome: ["type", "./layout/schema", "DashboardLayoutDecodeOutcome"],
    DashboardLayoutExtensions: ["type", "./layout/schema", "DashboardLayoutExtensions"],
    DashboardLayoutInvalidReason: ["type", "./layout/schema", "DashboardLayoutInvalidReason"],
    DashboardLayoutPreferences: ["type", "./layout/types", "DashboardLayoutPreferences"],
    DashboardLayoutV2: ["type", "./layout/schema", "DashboardLayoutV2"],
    DiffFile: ["type", "./layout/types", "DiffFile"],
    EditingFile: ["type", "./layout/types", "EditingFile"],
    LayoutColumn: ["type", "./layout/types", "LayoutColumn"],
    PersistedInspectorTab: ["type", "./layout/types", "PersistedInspectorTab"],
    PinnedItem: ["type", "./model/selection", "PinnedItem"],
    Selection: ["type", "./model/selection", "Selection"],
    SidebarView: ["type", "./layout/types", "SidebarView"],
    WindowLayout: ["type", "./layout/types", "WindowLayout"],
    DASHBOARD_LAYOUT_SCHEMA_VERSION: [
      "value",
      "./layout/schema",
      "DASHBOARD_LAYOUT_SCHEMA_VERSION",
    ],
    DEFAULT_COLUMN_ORDER: ["value", "./layout/schema", "DEFAULT_COLUMN_ORDER"],
    createDashboardLayoutV2: ["value", "./layout/schema", "createDashboardLayoutV2"],
    decodeDashboardLayout: ["value", "./layout/schema", "decodeDashboardLayout"],
    isDashboardLayoutV2: ["value", "./layout/schema", "isDashboardLayoutV2"],
    normalizeColumnOrder: ["value", "./layout/schema", "normalizeColumnOrder"],
  },
  "dashboard/dashboardShellModel.ts": {
    ResizablePanel: ["type", "./layout/types", "ResizablePanel"],
    DASHBOARD_MIN_WORKSPACE_WIDTH: [
      "value",
      "./layout/panelGeometry",
      "DASHBOARD_MIN_WORKSPACE_WIDTH",
    ],
    DASHBOARD_PANEL_LIMITS: ["value", "./layout/panelGeometry", "DASHBOARD_PANEL_LIMITS"],
    DASHBOARD_SIDEBAR_DOCK_BREAKPOINT: [
      "value",
      "./layout/panelGeometry",
      "DASHBOARD_SIDEBAR_DOCK_BREAKPOINT",
    ],
    DASHBOARD_WIDE_BREAKPOINT: [
      "value",
      "./layout/panelGeometry",
      "DASHBOARD_WIDE_BREAKPOINT",
    ],
    clampDashboardPanelWidth: [
      "value",
      "./layout/panelGeometry",
      "clampDashboardPanelWidth",
    ],
    clampDashboardPanelWidthForViewport: [
      "value",
      "./layout/panelGeometry",
      "clampDashboardPanelWidthForViewport",
    ],
    dashboardPanelWidthFromKey: [
      "value",
      "./layout/panelGeometry",
      "dashboardPanelWidthFromKey",
    ],
    dashboardPanelWidthFromPointer: [
      "value",
      "./layout/panelGeometry",
      "dashboardPanelWidthFromPointer",
    ],
    normalizeDashboardPanelWidths: [
      "value",
      "./layout/panelGeometry",
      "normalizeDashboardPanelWidths",
    ],
  },
  "dashboard/scratchPanelModel.ts": {
    DEFAULT_SCRATCH_PANEL_WIDTH: [
      "value",
      "./layout/scratchGeometry",
      "DEFAULT_SCRATCH_PANEL_WIDTH",
    ],
    SCRATCH_PANEL_LIMITS: ["value", "./layout/scratchGeometry", "SCRATCH_PANEL_LIMITS"],
    clampScratchPanelWidth: ["value", "./layout/scratchGeometry", "clampScratchPanelWidth"],
    scratchPanelMaximumWidth: [
      "value",
      "./layout/scratchGeometry",
      "scratchPanelMaximumWidth",
    ],
    scratchPanelWidthFromKey: [
      "value",
      "./layout/scratchGeometry",
      "scratchPanelWidthFromKey",
    ],
    scratchPanelWidthFromPointer: [
      "value",
      "./layout/scratchGeometry",
      "scratchPanelWidthFromPointer",
    ],
  },
  "sessionActivity.ts": {
    PreviousSessionActivity: [
      "type",
      "./dashboard/model/sessionActivity",
      "PreviousSessionActivity",
    ],
    SessionActivityInfo: ["type", "./dashboard/model/sessionActivity", "SessionActivityInfo"],
    SessionActivityState: ["type", "./dashboard/model/sessionActivity", "SessionActivityState"],
    describeSessionActivity: [
      "value",
      "./dashboard/model/sessionActivity",
      "describeSessionActivity",
    ],
    formatActivityAge: ["value", "./dashboard/model/sessionActivity", "formatActivityAge"],
  },
  "dashboard/catalogSelectionHydration.ts": {
    CatalogHydration: ["type", "./model/selection", "CatalogHydration"],
    CatalogSelection: ["type", "./model/selection", "CatalogSelection"],
    CatalogSelectionResolution: ["type", "./model/selection", "CatalogSelectionResolution"],
    PendingCatalogSelection: ["type", "./model/selection", "PendingCatalogSelection"],
    pendingCreatedCatalogSelection: ["value", "./model/selection", "pendingCreatedCatalogSelection"],
    pendingRestoredCatalogSelection: [
      "value",
      "./model/selection",
      "pendingRestoredCatalogSelection",
    ],
    reconcileCatalogSelection: ["value", "./model/selection", "reconcileCatalogSelection"],
    sameCatalogSelection: ["value", "./model/selection", "sameCatalogSelection"],
  },
  "dashboard/dashboardCatalogSnapshot.ts": {
    MergedDashboardCatalog: ["type", "./model/catalogSnapshot", "MergedDashboardCatalog"],
    mergeDashboardCatalogSnapshot: [
      "value",
      "./model/catalogSnapshot",
      "mergeDashboardCatalogSnapshot",
    ],
  },
  "dashboard/workspaceStatus.ts": {
    WorkspaceStatus: ["type", "./model/workspaceSelectors", "WorkspaceStatus"],
    WORKSPACE_STATUS_LABELS: [
      "value",
      "./model/workspaceSelectors",
      "WORKSPACE_STATUS_LABELS",
    ],
    workspaceStatusLabel: ["value", "./model/workspaceSelectors", "workspaceStatusLabel"],
  },
  "dashboard/DashboardSidebarModel.ts": {
    SidebarActivityDescription: [
      "type",
      "./model/workspaceSelectors",
      "SidebarActivityDescription",
    ],
    SidebarConnectionSummary: [
      "type",
      "./model/workspaceSelectors",
      "SidebarConnectionSummary",
    ],
    SidebarConnectionTone: ["type", "./model/workspaceSelectors", "SidebarConnectionTone"],
    SidebarSessionGroup: ["type", "./model/workspaceSelectors", "SidebarSessionGroup"],
    describeSidebarActivity: ["value", "./model/workspaceSelectors", "describeSidebarActivity"],
    groupSessionsByHostProject: [
      "value",
      "./model/workspaceSelectors",
      "groupSessionsByHostProject",
    ],
    summarizeSidebarConnections: [
      "value",
      "./model/workspaceSelectors",
      "summarizeSidebarConnections",
    ],
  },
} as const;

function topLevelDeclarationNames(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

function collectProtectedTypeScriptFiles(): string[] {
  const protectedRoots = ["dashboard/model", "dashboard/layout", "terminal"];
  const paths: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        paths.push(relative(rendererSourceRoot, absolutePath).split(sep).join("/"));
      }
    }
  }

  for (const root of protectedRoots) visit(join(rendererSourceRoot, root));
  return paths.sort();
}

function exportedDeclarationNames(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    assert.equal(
      ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
      false,
      `${path} canonical owners must export declarations in place`,
    );
    const exported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        assert.ok(
          ts.isIdentifier(declaration.name),
          `${path} exported variable declarations must use static identifier names`,
        );
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else {
      assert.fail(`${path} has an unsupported exported declaration kind`);
    }
  }
  return names.sort();
}

function namedFacadeExports(
  path: string,
  source: string,
): Record<string, ["type" | "value", string, string]> {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const names: Record<string, ["type" | "value", string, string]> = {};
  assert.ok(sourceFile.statements.length > 0, `${path} must re-export its canonical owner`);
  for (const statement of sourceFile.statements) {
    assert.equal(ts.isExportDeclaration(statement), true, `${path} must contain exports only`);
    if (!ts.isExportDeclaration(statement)) continue;
    assert.ok(statement.moduleSpecifier, `${path} exports must come from canonical modules`);
    assert.ok(
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier),
      `${path} export module specifiers must be static strings`,
    );
    assert.ok(
      statement.exportClause && ts.isNamedExports(statement.exportClause),
      `${path} must not use export * or namespace exports`,
    );
    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) continue;
    for (const element of statement.exportClause.elements) {
      const kind = statement.isTypeOnly || element.isTypeOnly ? "type" : "value";
      const publicName = element.name.text;
      assert.equal(names[publicName], undefined, `${path} must not export ${publicName} twice`);
      names[publicName] = [
        kind,
        statement.moduleSpecifier.text,
        element.propertyName?.text ?? publicName,
      ];
    }
  }
  return names;
}

function canonicalImportSpecifiers(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    assert.equal(
      ts.isImportEqualsDeclaration(statement),
      false,
      `${path} must not use import-equals value edges`,
    );
    if (!ts.isImportDeclaration(statement)) continue;
    assert.ok(
      ts.isStringLiteral(statement.moduleSpecifier),
      `${path} imports must use static string module specifiers`,
    );
    assert.equal(
      statement.importClause?.isTypeOnly,
      true,
      `${path} imports must use declaration-level import type`,
    );
    if (ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  function rejectNonDeclarationImports(node: ts.Node): void {
    assert.equal(
      ts.isImportTypeNode(node),
      false,
      `${path} must use explicit import type declarations`,
    );
    if (ts.isCallExpression(node)) {
      assert.notEqual(
        node.expression.kind,
        ts.SyntaxKind.ImportKeyword,
        `${path} must not use dynamic imports`,
      );
    }
    ts.forEachChild(node, rejectNonDeclarationImports);
  }
  rejectNonDeclarationImports(sourceFile);

  return specifiers.sort();
}

function canonicalTarget(path: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = posix.normalize(posix.join(posix.dirname(path), specifier));
  const candidate = unresolved.endsWith(".ts") ? unresolved : `${unresolved}.ts`;
  return Object.prototype.hasOwnProperty.call(canonicalOwners, candidate) ? candidate : null;
}

function assertAcyclicOwnerGraph(graph: ReadonlyMap<string, readonly string[]>): void {
  const complete = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  function visit(path: string): void {
    if (complete.has(path)) return;
    if (active.has(path)) {
      const cycleStart = stack.indexOf(path);
      assert.fail(`canonical owner cycle: ${[...stack.slice(cycleStart), path].join(" -> ")}`);
    }
    active.add(path);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) visit(dependency);
    stack.pop();
    active.delete(path);
    complete.add(path);
  }

  for (const path of graph.keys()) visit(path);
}

function identifierIsRuntimeReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    ((ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) && parent.name === node) ||
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent)) && parent.name === node)
  ) {
    return false;
  }

  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isStatement(current) || ts.isExpression(current)) break;
  }
  return true;
}

const purityCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
};

const allowedExternalRuntimeSymbols = new Set([
  "Array",
  "Boolean",
  "Date",
  "Map",
  "Math",
  "Number",
  "Object",
  "Reflect",
  "Set",
  "String",
  "undefined",
]);

function pathIsInside(root: string, candidate: string): boolean {
  const candidateRelativePath = relative(root, candidate);
  return candidateRelativePath !== ".." &&
    !candidateRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(candidateRelativePath);
}

function createCanonicalPurityProgram(): ts.Program {
  return ts.createProgram({
    rootNames: Object.keys(canonicalOwners).map((path) => join(rendererSourceRoot, path)),
    options: purityCompilerOptions,
  });
}

function createPurityProgramForSource(
  path: string,
  source: string,
): { program: ts.Program; fileName: string } {
  const fileName = resolve(rendererSourceRoot, "__renderer_model_decoys__", path);
  const host = ts.createCompilerHost(purityCompilerOptions, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (candidate) => resolve(candidate) === fileName || defaultFileExists(candidate);
  host.readFile = (candidate) => resolve(candidate) === fileName ? source : defaultReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(candidate) === fileName
      ? ts.createSourceFile(
          fileName,
          source,
          languageVersion,
          true,
          scriptKindForPath(fileName),
        )
      : defaultGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  return {
    program: ts.createProgram({ rootNames: [fileName], options: purityCompilerOptions, host }),
    fileName,
  };
}

function declarationIsAmbient(declaration: ts.Declaration): boolean {
  if (declaration.getSourceFile().isDeclarationFile) return true;
  for (
    let current: ts.Node | undefined = declaration;
    current && !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (
      ts.canHaveModifiers(current) &&
      ((ts.getCombinedModifierFlags(current as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0 ||
        ts.getModifiers(current)?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
        ))
    ) {
      return true;
    }
  }
  return false;
}

function assertRuntimeIdentifiersUseAllowlistedGlobals(
  path: string,
  program: ts.Program,
  sourceFile: ts.SourceFile,
): void {
  assert.equal(
    sourceFile.referencedFiles.length,
    0,
    `${path} must not use triple-slash path references`,
  );
  assert.equal(
    sourceFile.typeReferenceDirectives.length,
    0,
    `${path} must not use triple-slash types references`,
  );
  assert.equal(
    sourceFile.libReferenceDirectives.length,
    0,
    `${path} must not use triple-slash lib references`,
  );
  const checker = program.getTypeChecker();
  const allowedDirectConstructors = new Set([
    "Array",
    "Boolean",
    "Date",
    "Map",
    "Number",
    "Object",
    "Set",
    "String",
  ]);

  function visit(node: ts.Node): void {
    assert.equal(
      ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node),
      false,
      `${path} must not contain component JSX`,
    );
    if (ts.isIdentifier(node) && identifierIsRuntimeReference(node)) {
      assert.equal(/backend/i.test(node.text), false, `${path} has forbidden backend edge ${node.text}`);

      const rawSymbol = checker.getSymbolAtLocation(node);
      if (!rawSymbol) {
        assert.equal(
          allowedExternalRuntimeSymbols.has(node.text),
          true,
          `${path} has unresolved or forbidden runtime global ${node.text}`,
        );
      } else {
        assert.equal(
          (rawSymbol.flags & ts.SymbolFlags.Alias) !== 0,
          false,
          `${path} must not use an imported symbol as a runtime value: ${node.text}`,
        );
        const declarations = rawSymbol.getDeclarations() ?? [];
        const projectOwned = declarations.some((declaration) => {
          if (declarationIsAmbient(declaration)) return false;
          const declarationSource = declaration.getSourceFile();
          return declarationSource === sourceFile ||
            pathIsInside(rendererSourceRoot, resolve(declarationSource.fileName));
        });
        if (!projectOwned) {
          assert.equal(
            allowedExternalRuntimeSymbols.has(node.text),
            true,
            `${path} runtime global ${node.text} is outside the pure JS allowlist`,
          );
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      assert.equal(
        /backend/i.test(node.name.text),
        false,
        `${path} has forbidden backend member edge ${node.name.text}`,
      );
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      assert.equal(
        /backend/i.test(node.argumentExpression.text),
        false,
        `${path} has forbidden backend member edge ${node.argumentExpression.text}`,
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      assert.equal(
        !!calleeName && /^use[A-Z0-9]/.test(calleeName),
        false,
        `${path} must not call React-style hooks`,
      );
      assert.equal(
        !!calleeName &&
          /^[A-Z]/.test(calleeName) &&
          !(ts.isIdentifier(callee) && allowedDirectConstructors.has(calleeName)),
        false,
        `${path} must not call component-like values`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function assertNoForbiddenRuntimeEdges(path: string, source: string): void {
  const { program, fileName } = createPurityProgramForSource(path, source);
  const sourceFile = program.getSourceFile(fileName);
  assert.ok(sourceFile, `${path} must exist in its purity program`);
  assertRuntimeIdentifiersUseAllowlistedGlobals(path, program, sourceFile);
}

test("D9 AST guards fail closed on export, dependency, runtime, and cycle decoys", () => {
  assert.throws(
    () => exportedDeclarationNames("decoy.ts", "const value = 1; export { value };"),
    /export declarations in place/,
  );
  assert.throws(
    () => exportedDeclarationNames("decoy.ts", "const value = 1; export default value;"),
    /export declarations in place/,
  );
  assert.throws(
    () => canonicalImportSpecifiers("decoy.ts", 'import { value } from "./value";'),
    /declaration-level import type/,
  );
  assert.throws(
    () => canonicalImportSpecifiers("decoy.ts", 'type Value = import("./value").Value;'),
    /explicit import type declarations/,
  );

  for (const expression of [
    "window.innerWidth",
    "document.body",
    "localStorage.getItem('key')",
    "fetch('/status')",
    "globalThis.location",
    "navigator.userAgent",
    "location.href",
    "crypto.randomUUID()",
    "setTimeout(() => {}, 0)",
    "new WebSocket('ws://localhost')",
    "eval('1 + 1')",
    "process.env.HOME",
    "Buffer.from('value')",
    "require('./value')",
    "__TAURI__.core.invoke('command')",
    "source.backend",
    "source['dashboardBackend']",
    "hooks.useCatalog()",
    "components.TerminalDeck()",
  ]) {
    assert.throws(
      () => assertNoForbiddenRuntimeEdges("decoy.ts", `${expression};`),
      /./,
      expression,
    );
  }
  assert.throws(
    () => assertNoForbiddenRuntimeEdges(
      "decoy.ts",
      "declare const navigator: Navigator; navigator.userAgent;",
    ),
    /runtime global navigator is outside the pure JS allowlist/,
  );
  for (const [source, pattern] of [
    ['/// <reference path="./ambient.d.ts" />\nconst value = 1;', /path references/],
    ['/// <reference types="node" />\nconst value = 1;', /types references/],
    ['/// <reference lib="dom" />\nconst value = 1;', /lib references/],
  ] as const) {
    assert.throws(
      () => assertNoForbiddenRuntimeEdges("decoy.ts", source),
      pattern,
    );
  }
  assert.doesNotThrow(() =>
    assertNoForbiddenRuntimeEdges(
      "decoy.ts",
      "type Layout = { window?: number }; const source = { window: 1 }; const value = source.window; String(value);",
    ),
  );
  assert.throws(
    () => assertNoForbiddenRuntimeEdges("decoy.tsx", "const view = <TerminalDeck />;"),
    /component JSX/,
  );

  assert.throws(
    () => assertAcyclicOwnerGraph(new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["a.ts"]],
    ])),
    /canonical owner cycle: a\.ts -> b\.ts -> a\.ts/,
  );
});

test("D9 protected TS/TSX filesystem tree exactly matches the canonical owner manifest", () => {
  assert.deepEqual(
    collectProtectedTypeScriptFiles(),
    Object.keys(canonicalOwners).sort(),
    "every protected .ts/.tsx file must be listed in canonicalOwners",
  );
});

test("D9 canonical modules are production-reachable and uniquely own every moved symbol", () => {
  const declarations = files.flatMap(({ path, source }) =>
    topLevelDeclarationNames(path, source).map((name) => ({ name, path })),
  );

  for (const [expectedPath, names] of Object.entries(canonicalOwners)) {
    assert.equal(filesByPath.has(expectedPath), true, `${expectedPath} must be reachable from main.tsx`);
    const source = filesByPath.get(expectedPath) ?? "";
    assert.deepEqual(
      exportedDeclarationNames(expectedPath, source),
      [...names].sort(),
      `${expectedPath} owner list must cover every exported declaration exactly`,
    );
    for (const name of names) {
      const owners = declarations.filter((declaration) => declaration.name === name);
      assert.deepEqual(owners, [{ name, path: expectedPath }], `${name} must have one canonical owner`);
    }
  }
});

test("D9 model, layout, and attach modules stay pure and preserve the one-way DAG", () => {
  const graph = new Map<string, string[]>();
  const purityProgram = createCanonicalPurityProgram();
  for (const [path, expectedImports] of Object.entries(canonicalAllowedImports)) {
    const source = filesByPath.get(path);
    assert.ok(source, `${path} must be production-reachable`);
    const imports = canonicalImportSpecifiers(path, source);
    assert.deepEqual(imports, [...expectedImports].sort(), `${path} imports must match its frozen type DAG`);
    const sourceFile = purityProgram.getSourceFile(join(rendererSourceRoot, path));
    assert.ok(sourceFile, `${path} must exist in the canonical purity program`);
    assertRuntimeIdentifiersUseAllowlistedGlobals(path, purityProgram, sourceFile);
    graph.set(
      path,
      imports
        .map((specifier) => canonicalTarget(path, specifier))
        .filter((target): target is string => target !== null),
    );
  }
  assertAcyclicOwnerGraph(graph);
});

test("legacy entrypoints are thin re-export facades and implementation copies stay out of App and TerminalDeck", () => {
  for (const [path, expected] of Object.entries(historicalFacadeExports)) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    assert.deepEqual(namedFacadeExports(path, source), expected);
  }

  const forbiddenCopies = Object.values(canonicalOwners).flat();
  for (const path of ["App.tsx", "dashboard/TerminalDeck.tsx"]) {
    const source = filesByPath.get(path) ?? "";
    const declarations = new Set(topLevelDeclarationNames(path, source));
    for (const name of forbiddenCopies) {
      assert.equal(declarations.has(name), false, `${path} must not implement ${name}`);
    }
  }
  assert.doesNotMatch(renderer, /\bmigrateDashboardLayout\b/);
});
