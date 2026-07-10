import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("add host modal only offers ssh config candidates", () => {
  const modal = readFileSync(new URL("../src/AddHostModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /import \{ MenuSelect, type MenuOption \} from "\.\/MenuSelect";/);
  assert.match(modal, /sshHosts:\s*HostConfig\[\]/);
  assert.match(modal, /const hostOptions\s*:\s*MenuOption\[\]/);
  assert.doesNotMatch(modal, /CUSTOM_HOST_VALUE/);
  assert.doesNotMatch(modal, /label:\s*"Custom"/);
  assert.doesNotMatch(modal, /onChange=\{\(e\) => setHost\(e\.target\.value\)\}/);
  assert.doesNotMatch(modal, /onChange=\{\(e\) => setUser\(e\.target\.value\)\}/);
  assert.doesNotMatch(modal, /onChange=\{\(e\) => setPort\(e\.target\.value\.replace/);
  assert.doesNotMatch(modal, /onChange=\{\(e\) => setIdentityFile\(e\.target\.value\)\}/);
  assert.match(modal, /applySshHostCandidate/);
  assert.match(modal, /<MenuSelect\s+ariaLabel="SSH host"/);
  assert.match(modal, /disabled=\{busy \|\| hostOptions\.length === 0\}/);
});

test("shared menu select closes from pointer down before webview click handling", () => {
  const select = readFileSync(new URL("../src/MenuSelect.tsx", import.meta.url), "utf8");

  assert.match(select, /const selectOption = \(value: string\) => \{/);
  assert.match(select, /onPointerDown=\{\(event\) => \{/);
  assert.match(select, /event\.preventDefault\(\);/);
  assert.match(select, /selectOption\(option\.value\);/);
  assert.doesNotMatch(select, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("add host modal omits empty optional fields from tauri args", () => {
  const modal = readFileSync(new URL("../src/AddHostModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /const args: HostConfig = \{/);
  assert.match(modal, /if \(selectedCandidate\.user\?\.trim\(\)\) \{/);
  assert.match(modal, /if \(typeof selectedCandidate\.port === "number"\) \{/);
  assert.match(modal, /if \(selectedCandidate\.identityFile\?\.trim\(\)\) \{/);
  assert.doesNotMatch(modal, /port:\s*selectedCandidate\.port/);
  assert.doesNotMatch(modal, /selectedCandidate\.port !== undefined/);
  assert.doesNotMatch(modal, /user:\s*selectedCandidate\.user\?\.trim\(\) \|\| undefined/);
});

test("add host modal shows the default SSH port when none is configured", () => {
  const modal = readFileSync(new URL("../src/AddHostModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /const selectedPort = typeof selectedCandidate\?\.port === "number" \? selectedCandidate\.port : undefined;/);
  assert.match(modal, /const displayPort = selectedPort \?\? 22;/);
  assert.match(modal, /Port: <code>\{displayPort\}<\/code>/);
  assert.match(modal, /\{selectedPort === undefined && <span> \(default\)<\/span>\}/);
  assert.doesNotMatch(modal, /\{selectedCandidate\.port && <div>Port:/);
});

test("app loads ssh host candidates into Settings and keeps host status outside worktree list", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const connections = readFileSync(
    new URL("../src/dashboard/Settings/ConnectionsSettings.tsx", import.meta.url),
    "utf8",
  );
  const catalog = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  );

  assert.match(app, /useDashboardCatalog\(\)/);
  assert.match(catalog, /dashboardBackend\.hosts\.candidates\(\)/);
  assert.match(app, /sshHostCandidates/);
  assert.match(app, /sshHostCandidates=\{sshHostCandidates\}/);
  assert.match(app, /hostStatuses=\{hostStatuses\}/);
  assert.match(connections, /sshHostCandidates:\s*readonly HostConfig\[\]/);
  assert.match(connections, /hostStatuses:\s*Readonly<Record<string, HostStatus>>/);
  assert.match(connections, /const status = hostStatuses\[host\.id\]/);
  assert.doesNotMatch(app, /sshHosts=\{sshHostCandidates\}/);
  const statusIndex = app.indexOf("sidebar__host-status");
  const listsIndex = app.indexOf('className="sidebar__lists"');
  assert.ok(statusIndex >= 0, "host status should render in its own header area");
  assert.ok(listsIndex >= 0, "sidebar lists should still exist");
  assert.ok(statusIndex < listsIndex, "host status should not sit above worktrees inside the list");
});

test("app polls host status separately from the main session refresh", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const catalog = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  );

  assert.match(catalog, /const HOST_STATUS_REFRESH_MS = /);
  assert.match(catalog, /const refreshHostStatuses = useCallback/);
  assert.match(catalog, /dashboardBackend\.hosts\.statuses\(\)/);
  assert.match(catalog, /useVisibilityAwarePolling\(refreshHostStatuses, \{/);
  assert.match(catalog, /visibleIntervalMs: HOST_STATUS_REFRESH_MS/);
  assert.match(catalog, /hiddenIntervalMs: HOST_STATUS_HIDDEN_REFRESH_MS/);
  assert.doesNotMatch(catalog, /setInterval\(/);

  const refreshStart = app.indexOf("const refresh = useCallback");
  const refreshEnd = app.indexOf("const handleAutomationCreate", refreshStart);
  const refreshBlock = app.slice(refreshStart, refreshEnd);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "refresh block should be found");
  assert.doesNotMatch(refreshBlock, /dashboardBackend\.hosts\.statuses/);
});

test("host status exposes remote tw version and install action", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const modal = readFileSync(new URL("../src/AddHostModal.tsx", import.meta.url), "utf8");
  const catalog = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  );
  const domainTypes = readFileSync(new URL("../src/platform/domainTypes.ts", import.meta.url), "utf8");

  assert.match(domainTypes, /export type HostStatus = \{[\s\S]*?twAvailable:\s*boolean/);
  assert.match(domainTypes, /export type HostStatus = \{[\s\S]*?twVersion:\s*string \| null/);
  assert.match(catalog, /dashboardBackend\.hosts\.installTw\(hostId\)/);
  assert.match(app, /installingHostId/);
  assert.match(app, /const twLabel/);
  assert.match(app, /st\.twVersion \?\? "ok"/);
  assert.match(modal, /type HostStatus/);
  assert.match(modal, /testResult\.twAvailable/);
  assert.match(modal, /testResult\.twVersion/);
  assert.match(modal, /Remote TW/);
});
