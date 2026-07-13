import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  describeSidebarActivity,
  groupSessionsByHostProject,
  summarizeSidebarConnections,
} from "../src/dashboard/model/workspaceSelectors.ts";
import type { HostConfig, HostStatus, Session } from "../src/platform/domainTypes.ts";
import { rendererImplementationSourceContaining } from "./helpers/rendererImplementationSource.ts";

const hosts: HostConfig[] = [
  { id: "build", label: "Build host", host: "build.internal" },
  { id: "relay", label: "Relay host", host: "relay.internal" },
];

const sessions: Session[] = [
  {
    name: "local-alpha-fix",
    rawName: "alpha-fix",
    project: "alpha",
    attached: true,
    window_count: 1,
    created: 1,
    activity: 2,
  },
  {
    name: "build-alpha-review",
    rawName: "alpha-review",
    project: "alpha",
    hostId: "build",
    attached: false,
    window_count: 1,
    created: 2,
    activity: 3,
  },
  {
    name: "build-alpha-tests",
    rawName: "alpha-tests",
    project: "alpha",
    hostId: "build",
    attached: false,
    window_count: 1,
    created: 3,
    activity: 4,
  },
  {
    name: "relay-beta-docs",
    rawName: "beta-docs",
    hostId: "relay",
    attached: false,
    window_count: 1,
    created: 4,
    activity: 5,
  },
];

test("groups worktrees by host and project with collapse-compatible keys", () => {
  const groups = groupSessionsByHostProject(sessions, hosts);

  assert.deepEqual(
    groups.map(({ key, hostLabel, project, sessions: groupedSessions }) => ({
      key,
      hostLabel,
      project,
      sessionNames: groupedSessions.map((session) => session.name),
    })),
    [
      {
        key: "local:alpha",
        hostLabel: "Local",
        project: "alpha",
        sessionNames: ["local-alpha-fix"],
      },
      {
        key: "ssh:build:alpha",
        hostLabel: "Build host",
        project: "alpha",
        sessionNames: ["build-alpha-review", "build-alpha-tests"],
      },
      {
        key: "ssh:relay:beta",
        hostLabel: "Relay host",
        project: "beta",
        sessionNames: ["relay-beta-docs"],
      },
    ],
  );
});

test("connection summary distinguishes checking, offline, and missing tw", () => {
  const statuses: Record<string, HostStatus> = {
    build: {
      id: "build",
      label: "Build host",
      reachable: true,
      latencyMs: 18,
      error: null,
      twAvailable: false,
      twVersion: null,
      twError: "tw was not found",
    },
  };

  const partial = summarizeSidebarConnections(hosts, statuses);
  assert.equal(partial.label, "0/2 hosts ready");
  assert.equal(partial.detail, "1 checking · 1 needs tw");
  assert.equal(partial.tone, "warning");
  assert.deepEqual(partial.twMissingHosts.map((host) => host.id), ["build"]);

  const offline = summarizeSidebarConnections(hosts, {
    ...statuses,
    relay: {
      id: "relay",
      label: "Relay host",
      reachable: false,
      latencyMs: null,
      error: "unreachable",
      twAvailable: false,
      twVersion: null,
      twError: null,
    },
  });
  assert.equal(offline.detail, "1 offline · 1 needs tw");
  assert.equal(offline.tone, "danger");
});

test("connection summary has an honest zero-host state and a complete ready state", () => {
  assert.deepEqual(summarizeSidebarConnections([], {}), {
    label: "No hosts configured",
    detail: "Open Connections in Settings",
    tone: "neutral",
    readyCount: 0,
    checkingCount: 0,
    offlineCount: 0,
    twMissingHosts: [],
  });

  const readyStatuses = Object.fromEntries(
    hosts.map((host) => [
      host.id,
      {
        id: host.id,
        label: host.label,
        reachable: true,
        latencyMs: 10,
        error: null,
        twAvailable: true,
        twVersion: "1.0.3",
        twError: null,
      } satisfies HostStatus,
    ]),
  );
  const ready = summarizeSidebarConnections(hosts, readyStatuses);
  assert.equal(ready.label, "2/2 hosts ready");
  assert.equal(ready.detail, "All hosts connected");
  assert.equal(ready.tone, "success");
});

test("activity description always pairs semantic color state with readable text", () => {
  assert.deepEqual(describeSidebarActivity(undefined, false), {
    state: "unknown",
    label: "Status unknown",
    title: "Agent activity is unknown",
  });
  assert.equal(
    describeSidebarActivity(
      {
        state: "stopped",
        label: "3m",
        ageSeconds: 180,
        changed: false,
        outputSignature: "sig",
        lastChangedAt: 1,
      },
      false,
    ).label,
    "Stopped · 3m",
  );
});

test("sidebar source uses the icon library and responsive accessible styling", () => {
  const source = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.css", import.meta.url),
    "utf8",
  );

  assert.match(source, /from "lucide-react"/);
  assert.match(source, />New worktree</);
  assert.match(source, />Pin a worktree or terminal for quick access\.</);
  assert.match(source, /aria-label={`\$\{pinned \? "Unpin" : "Pin"\} worktree/);
  assert.equal(source.match(/className="tw-dashboard-sidebar__connections"/g)?.length, 1);
  assert.match(source, /aria-label={`Close worktree \$\{displayName\}`}/);
  assert.match(source, /aria-label={`Close terminal \$\{terminal\.label\}`}/);
  assert.match(source, /onClick=\{\(\) => onOpenSettings\(\)\}/);
  assert.match(source, /className="tw-dashboard-sidebar__connection-title">Settings</);
  assert.match(source, /localRuntimeState === "error"/);
  assert.match(source, /mobileRelay\.statusKnown/);
  assert.match(source, /data-relay=\{relayState\}/);
  assert.match(source, /Relay \{relayLabel\}/);
  assert.doesNotMatch(source, /Local ready ·/);
  assert.doesNotMatch(source, /relay-host · connected/);
  assert.doesNotMatch(source, /codex-5/);
  assert.doesNotMatch(source, /<svg\b/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
  assert.match(css, /max-inline-size:\s*100%/);
  assert.match(css, /font-size:\s*13px/);
  assert.match(css, /font-size:\s*11px/);
  assert.match(
    css,
    /\.tw-sidebar-group__project\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*650;[\s\S]*?line-height:\s*1\.25;/,
  );
  assert.match(
    css,
    /\.tw-sidebar-row__title\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*600;[\s\S]*?line-height:\s*1\.35;/,
  );
  assert.match(
    css,
    /\.tw-sidebar-row__meta\s*\{[\s\S]*?color:\s*var\(--shell-text-faint\);[\s\S]*?font-size:\s*11\.5px;[\s\S]*?line-height:\s*1\.3;/,
  );
  assert.match(css, /button:focus-visible/);
  assert.match(css, /@media \(max-width:\s*959px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test("sidebar keeps independent Workspaces and Files views mounted around a shared footer", () => {
  const source = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.css", import.meta.url),
    "utf8",
  );

  assert.match(source, /export type \{ SidebarView \} from "\.\/layout\/types"/);
  assert.match(source, /activeView: SidebarView/);
  assert.match(source, /filesContent: ReactNode/);
  assert.match(source, /onViewChange: \(view: SidebarView\) => void/);
  assert.match(source, /role="tablist" aria-label="Sidebar view"/);
  assert.match(source, />Workspaces</);
  assert.match(source, />Files</);
  assert.match(source, /onViewChange\("workspaces"\)/);
  assert.match(source, /onViewChange\("files"\)/);
  assert.match(source, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
  assert.match(source, /viewTabRefs\.current\.get\(next\)\?\.focus\(\)/);
  assert.equal(source.match(/role="tabpanel"/g)?.length, 2);
  assert.equal(source.match(/\n\s+hidden=\{activeView !==/g)?.length, 2);
  assert.equal(source.match(/inert=\{activeView !==/g)?.length, 2);
  assert.equal(source.match(/aria-hidden=\{activeView !==/g)?.length, 2);
  assert.match(source, /tw-dashboard-sidebar__files-content[\s\S]*\{filesContent\}/);
  assert.equal(source.match(/<footer className="tw-dashboard-sidebar__footer">/g)?.length, 1);
  assert.match(css, /\.tw-dashboard-sidebar__view\[hidden\]\s*\{[\s\S]*?display:\s*none/);
  assert.match(css, /\.tw-dashboard-sidebar__view--workspaces\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(css, /\.tw-dashboard-sidebar__files-content\s*\{[\s\S]*?flex:\s*1/);
});

test("persisted terminals expose inline rename without enabling it for discovered tmux sessions", () => {
  const source = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.css", import.meta.url),
    "utf8",
  );
  const composition = rendererImplementationSourceContaining(
    "renamePersistedTerminal(current, allTerminals, id, label)",
    "onRenameTerminal={renameTerminal}",
  ).source;

  assert.match(source, /onRenameTerminal: \(terminalId: string, label: string\)/);
  assert.match(source, /onDoubleClick=\{!terminal\.discovered \?/);
  assert.match(source, /className="tw-sidebar-row__rename"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key === "Enter"[\s\S]*event\.currentTarget\.blur\(\)/);
  assert.match(css, /\.tw-sidebar-row__rename\s*\{/);
  assert.match(composition, /renamePersistedTerminal\(current, allTerminals, id, label\)/);
  assert.match(composition, /onRenameTerminal=\{renameTerminal\}/);
});
