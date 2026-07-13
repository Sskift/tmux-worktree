import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("standalone CLI build and every automatic consumer use the canonical CJS artifact", () => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  const packageJson = JSON.parse(read("package.json"));
  assert.deepEqual(packageJson.bin, {
    "tmux-worktree": "dist/cli.cjs",
    tw: "dist/cli.cjs",
    "tw-dashboard-install": "app/installer/installer.mjs",
  });
  assert.equal(
    packageJson.scripts.build,
    "tsup && tsup --config tsup.standalone.config.ts",
  );

  const modulesConfig = read("tsup.config.ts");
  assert.doesNotMatch(modulesConfig, /src\/cli\.ts/);
  assert.match(modulesConfig, /format: \["esm"\]/);
  assert.match(modulesConfig, /clean: true/);
  const standaloneConfig = read("tsup.standalone.config.ts");
  for (const pattern of [
    /entry: \{ cli: "src\/cli\.ts" \}/,
    /format: \["cjs"\]/,
    /target: "node20"/,
    /platform: "node"/,
    /bundle: true/,
    /outExtension: \(\) => \(\{ js: "\.cjs" \}\)/,
    /clean: false/,
    /splitting: false/,
    /noExternal: \["ws"\]/,
  ]) assert.match(standaloneConfig, pattern);

  assert.equal(existsSync(new URL("dist/cli.js", root)), false);
  const standalone = read("dist/cli.cjs");
  assert.equal(standalone.startsWith("#!/usr/bin/env node\n"), true);
  assert.equal(standalone.match(/^#!\/usr\/bin\/env node$/gm)?.length, 1);
  assert.doesNotMatch(standalone, /import\.meta|createRequire/);
  const built = ts.createSourceFile(
    "cli.cjs",
    standalone,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  for (const statement of built.statements) {
    assert.equal(ts.isImportDeclaration(statement), false, "standalone cannot import ESM");
    assert.equal(ts.isExportDeclaration(statement), false, "standalone cannot export ESM");
    assert.equal(ts.isExportAssignment(statement), false, "standalone cannot export ESM");
  }

  const tauri = JSON.parse(read("app/src-tauri/tauri.conf.json"));
  assert.deepEqual(tauri.bundle.resources, {
    "../../dist/cli.cjs": "tw-cli/cli.cjs",
  });
  for (const path of [
    "app/src-tauri/src/features/control_plane/discovery.rs",
    "app/src-tauri/src/features/control_plane/hosts.rs",
    "app/src-tauri/src/features/mobile_relay/broker.rs",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /(?:tw-)?cli\.js/);
    assert.match(source, /(?:tw-)?cli\.cjs/);
  }
  const discovery = read("app/src-tauri/src/features/control_plane/discovery.rs");
  assert.ok(
    discovery.indexOf("TW_DASHBOARD_CLI") <
      discovery.indexOf('resources.join("tw-cli").join("cli.cjs")'),
  );
  const relayHost = read("src/relayHost.ts");
  const localTwStart = relayHost.indexOf("async function localTwOutput");
  const localTwEnd = relayHost.indexOf("\nfunction parseArgs", localTwStart);
  assert.ok(localTwStart >= 0 && localTwEnd > localTwStart);
  const localTw = relayHost.slice(localTwStart, localTwEnd);
  assert.ok(localTw.indexOf("TW_DASHBOARD_CLI") < localTw.indexOf("process.argv[1]"));
  assert.ok(localTw.indexOf("process.argv[1]") < localTw.lastIndexOf('execFileTracked("tw"'));
  assert.match(localTw, /\["cli\.cjs", "tw-cli\.cjs"\]/);
});
