import assert from "node:assert/strict";
import test from "node:test";
import {
  canReorderSessionsWithinGroup,
  describeSidebarActivity,
  groupSessionsByHostProject,
  orderSidebarSessionGroups,
  orderSessionsByName,
  summarizeSidebarConnections,
} from "../src/dashboard/model/workspaceSelectors.ts";
import {
  moveSortableItem,
  resolveSortableMove,
} from "../src/dashboard/hooks/useSortable.ts";
import type { HostConfig, HostStatus, Session } from "../src/platform/domainTypes.ts";

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

test("worktree sorting preserves groups, supports group blocks, and rejects cross-group rows", () => {
  const ordered = orderSessionsByName(sessions, [
    "build-alpha-tests",
    "build-alpha-review",
    "local-alpha-fix",
  ]);
  assert.deepEqual(ordered.map((session) => session.name), [
    "build-alpha-tests",
    "build-alpha-review",
    "local-alpha-fix",
    "relay-beta-docs",
  ]);
  assert.equal(canReorderSessionsWithinGroup(ordered, 0, 1), true);
  assert.equal(canReorderSessionsWithinGroup(ordered, 1, 2), false);

  const groups = groupSessionsByHostProject(ordered, hosts);
  const movedGroups = moveSortableItem(groups, 2, 0);
  assert.deepEqual(
    movedGroups.flatMap((group) => group.sessions.map((session) => session.name)),
    [
      "relay-beta-docs",
      "build-alpha-tests",
      "build-alpha-review",
      "local-alpha-fix",
    ],
  );

  const interleaved = orderSessionsByName(sessions, [
    "build-alpha-review",
    "local-alpha-fix",
    "build-alpha-tests",
    "relay-beta-docs",
  ]);
  const visualSessions = groupSessionsByHostProject(interleaved, hosts)
    .flatMap((group) => group.sessions);
  assert.deepEqual(visualSessions.map((session) => session.name), [
    "build-alpha-review",
    "build-alpha-tests",
    "local-alpha-fix",
    "relay-beta-docs",
  ]);
  assert.equal(canReorderSessionsWithinGroup(visualSessions, 0, 1), true);
  const rowMove = resolveSortableMove(
    visualSessions,
    "build-alpha-review",
    "build-alpha-tests",
    (session) => session.name,
    (fromIndex, toIndex) =>
      canReorderSessionsWithinGroup(visualSessions, fromIndex, toIndex),
  );
  assert.deepEqual(rowMove?.items.map((session) => session.name), [
    "build-alpha-tests",
    "build-alpha-review",
    "local-alpha-fix",
    "relay-beta-docs",
  ]);

  const refreshedDuringDrag = [
    sessions[0],
    sessions[2],
    sessions[1],
    sessions[3],
  ];
  const stableMove = resolveSortableMove(
    refreshedDuringDrag,
    "build-alpha-review",
    "build-alpha-tests",
    (session) => session.name,
  );
  assert.deepEqual(stableMove?.items.map((session) => session.name), [
    "local-alpha-fix",
    "build-alpha-review",
    "build-alpha-tests",
    "relay-beta-docs",
  ]);

  const groupsAfterAnchorClose = groupSessionsByHostProject(
    sessions.filter((session) => session.name !== "build-alpha-review"),
    hosts,
  );
  assert.deepEqual(
    orderSidebarSessionGroups(groupsAfterAnchorClose, [
      "ssh:build:alpha",
      "local:alpha",
      "ssh:relay:beta",
    ]).map((group) => group.key),
    ["ssh:build:alpha", "local:alpha", "ssh:relay:beta"],
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
