import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  readRendererImplementationTree,
  rendererImplementationSourceContaining,
} from "./helpers/rendererImplementationSource.ts";

const renderer = readRendererImplementationTree();

test("shared menu select closes from pointer down before webview click handling", () => {
  const select = readFileSync(new URL("../src/MenuSelect.tsx", import.meta.url), "utf8");

  assert.match(select, /const selectOption = \(value: string\) => \{/);
  assert.match(select, /onPointerDown=\{\(event\) => \{/);
  assert.match(select, /event\.preventDefault\(\);/);
  assert.match(select, /selectOption\(option\.value\);/);
  assert.doesNotMatch(select, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("the renderer loads ssh host candidates into Settings and keeps host status outside worktree list", () => {
  const sidebar = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  const connections = readFileSync(
    new URL("../src/dashboard/Settings/ConnectionsSettings.tsx", import.meta.url),
    "utf8",
  );
  const catalog = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  );
  const composition = rendererImplementationSourceContaining(
    "useDashboardCatalog()",
    "sshHostCandidates={sshHostCandidates}",
    "hostStatuses={hostStatuses}",
  ).source;

  assert.match(composition, /useDashboardCatalog\(\)/);
  assert.match(catalog, /dashboardBackend\.hosts\.candidates\(\)/);
  assert.match(composition, /sshHostCandidates/);
  assert.match(composition, /sshHostCandidates=\{sshHostCandidates\}/);
  assert.match(composition, /hostStatuses=\{hostStatuses\}/);
  assert.match(connections, /sshHostCandidates:\s*readonly HostConfig\[\]/);
  assert.match(connections, /hostStatuses:\s*Readonly<Record<string, HostStatus>>/);
  assert.match(connections, /const status = hostStatuses\[host\.id\]/);
  assert.doesNotMatch(renderer, /sshHosts=\{sshHostCandidates\}/);
  const listIndex = sidebar.indexOf("tw-dashboard-sidebar__scroll-region");
  const connectionIndex = sidebar.indexOf("tw-dashboard-sidebar__connections");
  assert.ok(listIndex >= 0, "sidebar navigation should exist");
  assert.ok(connectionIndex > listIndex, "connection status should live in the footer after navigation");
  assert.match(sidebar, /summarizeSidebarConnections\(hosts, hostStatuses\)/);
  assert.doesNotMatch(renderer, /sidebar__host-status/);
});

test("the renderer polls host status separately from the main session refresh", () => {
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

  const { source } = rendererImplementationSourceContaining(
    "const refresh = useCallback",
    "useVisibilityAwarePolling(refresh",
    "catalogRefreshGenerationRef.current.started",
  );
  const refreshStart = source.indexOf("const refresh = useCallback");
  const refreshEnd = source.indexOf("useVisibilityAwarePolling(refresh", refreshStart);
  const refreshBlock = source.slice(refreshStart, refreshEnd);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "refresh block should be found");
  assert.doesNotMatch(refreshBlock, /dashboardBackend\.hosts\.statuses/);
});

test("host status exposes remote tw version and install action from Settings", () => {
  const sidebar = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  const connections = readFileSync(
    new URL("../src/dashboard/Settings/ConnectionsSettings.tsx", import.meta.url),
    "utf8",
  );
  const catalog = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  );
  const domainTypes = readFileSync(new URL("../src/platform/domainTypes.ts", import.meta.url), "utf8");
  const composition = rendererImplementationSourceContaining(
    "installingHostId={installingHostId}",
    "onInstallTw={installRemoteTw}",
  ).source;

  assert.match(domainTypes, /export type HostStatus = \{[\s\S]*?twAvailable:\s*boolean/);
  assert.match(domainTypes, /export type HostStatus = \{[\s\S]*?twVersion:\s*string \| null/);
  assert.match(domainTypes, /export type HostStatus = \{[\s\S]*?tmuxAvailable\?:\s*boolean/);
  assert.match(domainTypes, /export type HostStatus = \{[\s\S]*?twCompatible\?:\s*boolean/);
  assert.match(catalog, /dashboardBackend\.hosts\.installTw\(hostId\)/);
  assert.match(composition, /installingHostId/);
  assert.match(sidebar, /const installHost = connections\.twMissingHosts\[0\]/);
  assert.match(sidebar, /onInstallTw\(installHost\.id\)/);
  assert.match(connections, /\(testedStatus \?\? selectedStatus\)\?\.twVersion/);
  assert.match(connections, /Installing/);
  assert.match(connections, /Install tw/);
  assert.match(connections, /tmux is not available/);
  assert.match(connections, /RPC incompatible/);
});
