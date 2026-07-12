import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readRendererImplementationFiles,
  readRendererImplementationFilesFromEntry,
} from "./helpers/rendererImplementationSource.ts";

function rendererFixture(files: Record<string, string>): {
  entryPoint: string;
  remove: () => void;
  sourceRoot: string;
} {
  const sourceRoot = mkdtempSync(join(tmpdir(), "tw-renderer-characterization-"));
  for (const [path, source] of Object.entries(files)) {
    writeFileSync(resolve(sourceRoot, path), source, "utf8");
  }
  return {
    entryPoint: resolve(sourceRoot, "main.tsx"),
    remove: () => rmSync(sourceRoot, { recursive: true, force: true }),
    sourceRoot,
  };
}

test("renderer characterization starts at the real main.tsx production entry", () => {
  const paths = readRendererImplementationFiles().map(({ path }) => path);

  assert.ok(paths.includes("main.tsx"));
  assert.ok(paths.includes("App.tsx"));
  assert.ok(paths.includes("platform/previewBackend.ts"));
});

test("renderer characterization excludes a stale App when main switches implementation", (context) => {
  const fixture = rendererFixture({
    "main.tsx": 'import NewApp from "./NewApp";\nvoid NewApp;\n',
    "NewApp.tsx": "export default function NewApp() { return null; }\n",
    "App.tsx": "export default function StaleApp() { return null; }\n",
  });
  context.after(fixture.remove);

  const paths = readRendererImplementationFilesFromEntry(
    fixture.sourceRoot,
    fixture.entryPoint,
  ).map(({ path }) => path);

  assert.deepEqual(paths, ["main.tsx", "NewApp.tsx"]);
});

test("renderer characterization follows statically resolvable dynamic imports", (context) => {
  const fixture = rendererFixture({
    "main.tsx": 'void import("./DynamicApp");\n',
    "DynamicApp.tsx": "export default function DynamicApp() { return null; }\n",
    "App.tsx": "export default function StaleApp() { return null; }\n",
  });
  context.after(fixture.remove);

  const paths = readRendererImplementationFilesFromEntry(
    fixture.sourceRoot,
    fixture.entryPoint,
  ).map(({ path }) => path);

  assert.deepEqual(paths, ["DynamicApp.tsx", "main.tsx"]);
});

test("renderer characterization fails closed on non-literal dynamic imports", (context) => {
  const fixture = rendererFixture({
    "main.tsx": 'const implementation = "./DynamicApp";\nvoid import(implementation);\n',
    "DynamicApp.tsx": "export default function DynamicApp() { return null; }\n",
  });
  context.after(fixture.remove);

  assert.throws(
    () => readRendererImplementationFilesFromEntry(fixture.sourceRoot, fixture.entryPoint),
    /renderer dynamic import is not statically analyzable at .*main\.tsx:2:6/,
  );
});

test("renderer characterization fails closed on import.meta glob entry points", (context) => {
  const fixture = rendererFixture({
    "main.tsx": 'const implementations = import.meta.glob("./*.tsx");\nvoid implementations;\n',
    "DynamicApp.tsx": "export default function DynamicApp() { return null; }\n",
  });
  context.after(fixture.remove);

  assert.throws(
    () => readRendererImplementationFilesFromEntry(fixture.sourceRoot, fixture.entryPoint),
    /renderer import\.meta\.glob is not supported by the static reachability graph at .*main\.tsx:1:25/,
  );
});

test("renderer characterization treats explicit assets as leaves", (context) => {
  const fixture = rendererFixture({
    "main.tsx": 'import "./styles.css";\nimport icon from "../../icon.png";\nvoid icon;\n',
  });
  context.after(fixture.remove);

  const paths = readRendererImplementationFilesFromEntry(
    fixture.sourceRoot,
    fixture.entryPoint,
  ).map(({ path }) => path);

  assert.deepEqual(paths, ["main.tsx"]);
});

test("renderer characterization fails closed on unresolved relative code imports", (context) => {
  const fixture = rendererFixture({
    "main.tsx": 'import Missing from "./Missing.tsx";\nvoid Missing;\n',
  });
  context.after(fixture.remove);

  assert.throws(
    () => readRendererImplementationFilesFromEntry(fixture.sourceRoot, fixture.entryPoint),
    /renderer TS\/TSX import cannot be resolved: \.\/Missing\.tsx from main\.tsx/,
  );
});
