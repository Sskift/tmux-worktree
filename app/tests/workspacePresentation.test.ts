import assert from "node:assert/strict";
import test from "node:test";
import { deriveWorkspacePresentation } from "../src/dashboard/model/workspacePresentation.ts";
import type { WorkspacePresentationInput } from "../src/dashboard/model/workspacePresentation.ts";

function baseInput(
  overrides: Partial<WorkspacePresentationInput> = {},
): WorkspacePresentationInput {
  return {
    ownerReady: true,
    selection: { kind: "session", name: "local-session" },
    selectionMetadataPending: false,
    selectedSession: {
      name: "local-session",
      attached: false,
      window_count: 1,
      created: 1,
      activity: 1,
      project: "project-a",
      hostId: null,
      rawName: "raw-session",
    },
    selectedTerminal: null,
    automations: [],
    projectPresets: [{ name: "project-a", path: "/projects/a" }],
    hosts: [],
    hostStatuses: {},
    sessionActivity: {
      "local-session": {
        state: "running",
        label: "Running",
        changed: true,
        ageSeconds: 1,
        outputSignature: "output",
        lastChangedAt: 1,
      },
    },
    cwdsBySession: { "local-session": "/worktrees/a" },
    homeDirectory: "/Users/example",
    workspaceBranch: {
      sourceKey: JSON.stringify(["session:local-session", "/worktrees/a", null]),
      value: "main",
    },
    editingFile: null,
    diffFile: null,
    ...overrides,
  };
}

test("owner and metadata pending cuts fail closed without unmounting the terminal surface", () => {
  const staleEditor = { path: "/secret/from-A.ts" };
  const inactive = deriveWorkspacePresentation(baseInput({
    ownerReady: false,
    selection: { kind: "automation", id: "automation-a" },
    automations: [{
      id: "automation-a",
      name: "A secret automation",
      instruction: "work",
      aiCmd: "codex",
      project: "secret-project",
      path: "/secret",
      schedule: "",
      allowOverlap: false,
      active: true,
    }],
    editingFile: staleEditor,
  }));
  assert.equal(inactive.metadataPending, true);
  assert.equal(inactive.terminalVisible, true);
  assert.deepEqual(inactive.primary, { kind: "pending" });
  assert.deepEqual(inactive.files, { kind: "pending" });
  assert.deepEqual(inactive.git, { kind: "pending" });
  assert.deepEqual(inactive.diff, { kind: "pending" });
  assert.equal(inactive.selectedAutomation, null);
  assert.equal(inactive.selectedCwd, null);
  assert.equal(inactive.fileBrowserRoot, null);
  assert.equal(inactive.header.title, "Loading workspace…");
  assert.equal(inactive.header.project, null);
  assert.equal(inactive.header.branch, null);
  assert.equal(inactive.header.status, "reconnecting");

  assert.equal(deriveWorkspacePresentation(baseInput({
    ownerReady: false,
    selection: { kind: "session", name: "safe-session" },
  })).header.title, "safe-session");
  assert.equal(deriveWorkspacePresentation(baseInput({
    ownerReady: false,
    selection: { kind: "terminal", id: "terminal-a" },
  })).header.title, "Loading terminal…");
  assert.equal(deriveWorkspacePresentation(baseInput({
    ownerReady: false,
    selection: null,
  })).header.title, "No workspace selected");
});

test("branch values are visible only for the exact current source key", () => {
  const current = deriveWorkspacePresentation(baseInput());
  assert.equal(current.header.branch, "main");
  const stale = deriveWorkspacePresentation(baseInput({
    workspaceBranch: { sourceKey: "stale-source", value: "stale" },
  }));
  assert.equal(stale.header.branch, null);
  assert.equal(stale.branchSource.kind, "workspace");
  assert.match(stale.branchSource.key, /session:local-session/);
});

test("cwd host and file roots preserve local remote and automation fallback order", () => {
  const local = deriveWorkspacePresentation(baseInput());
  assert.equal(local.selectedCwd, "/worktrees/a");
  assert.equal(local.selectedGitHostId, null);
  assert.equal(local.fileBrowserRoot, "/worktrees/a");
  assert.equal(local.header.title, "raw-session");
  assert.equal(local.header.project, "project-a");
  assert.equal(local.header.status, "running");

  const remote = deriveWorkspacePresentation(baseInput({
    selection: { kind: "terminal", id: "remote-terminal" },
    selectedSession: null,
    selectedTerminal: {
      id: "remote-terminal",
      label: "Remote terminal",
      cwd: "/remote/repo",
      tmuxName: "host-a:raw",
      hostId: "host-a",
      rawName: "raw",
    },
    hosts: [{ id: "host-a", label: "Build Host", host: "build.example" }],
    hostStatuses: {
      "host-a": {
        id: "host-a",
        label: "Build Host",
        reachable: false,
        latencyMs: null,
        error: "offline",
        twAvailable: true,
        twVersion: "1",
        twError: null,
      },
    },
  }));
  assert.equal(remote.selectedCwd, "/remote/repo");
  assert.equal(remote.selectedGitHostId, "host-a");
  assert.equal(remote.fileBrowserRoot, "/remote/repo");
  assert.equal(remote.header.hostLabel, "Build Host");
  assert.equal(remote.header.status, "offline");

  const automation = deriveWorkspacePresentation(baseInput({
    selection: { kind: "automation", id: "automation-a" },
    selectedSession: null,
    automations: [{
      id: "automation-a",
      name: "Automation A",
      instruction: "work",
      aiCmd: "codex",
      project: "project-a",
      path: "",
      schedule: "",
      allowOverlap: false,
      active: true,
      status: "queued",
    }],
  }));
  assert.equal(automation.selectedAutomationProjectPath, "/projects/a");
  assert.equal(automation.selectedCwd, "/projects/a");
  assert.equal(automation.fileBrowserRoot, "/projects/a");
  assert.deepEqual(automation.primary, { kind: "automation" });
  assert.equal(automation.header.status, "waiting");
});

test("editor diff files and empty contexts retain the presentation priority", () => {
  const editor = deriveWorkspacePresentation(baseInput({
    editingFile: { path: "/worktrees/a/src/index.ts", line: 4, column: 2 },
    diffFile: { path: "src/old.ts", cwd: "/worktrees/a" },
  }));
  assert.equal(editor.primary.kind, "editor");
  assert.equal(editor.header.title, "index.ts");
  assert.equal(editor.terminalVisible, false);
  assert.equal(editor.files.kind, "tree");
  assert.equal(editor.files.kind === "tree" ? editor.files.selectedFile : null, "/worktrees/a/src/index.ts");

  const diff = deriveWorkspacePresentation(baseInput({
    editingFile: null,
    diffFile: { path: "src/changed.ts", cwd: "/worktrees/a" },
  }));
  assert.equal(diff.primary.kind, "diff");
  assert.equal(diff.diff.kind, "viewer");
  assert.equal(diff.header.title, "changed.ts");

  const empty = deriveWorkspacePresentation(baseInput({
    selection: null,
    selectedSession: null,
    cwdsBySession: {},
  }));
  assert.deepEqual(empty.primary, { kind: "empty" });
  assert.deepEqual(empty.files, { kind: "empty" });
  assert.equal(empty.header.filesAvailable, false);
  assert.equal(empty.header.gitAvailable, false);
});

test("workspace roots preserve local remote and automation fallback boundaries", () => {
  const localHome = deriveWorkspacePresentation(baseInput({
    cwdsBySession: {},
  }));
  assert.equal(localHome.selectedCwd, null);
  assert.equal(localHome.fileBrowserRoot, "/Users/example");
  assert.equal(localHome.branchSource.kind, "inactive");
  assert.equal(localHome.header.branch, null);

  const localRoot = deriveWorkspacePresentation(baseInput({
    cwdsBySession: {},
    homeDirectory: null,
  }));
  assert.equal(localRoot.fileBrowserRoot, "/");

  const remoteWithoutCwd = deriveWorkspacePresentation(baseInput({
    selectedSession: {
      ...baseInput().selectedSession!,
      hostId: "host-a",
    },
    hosts: [{ id: "host-a", label: "Remote", host: "remote.example" }],
    hostStatuses: {
      "host-a": {
        id: "host-a",
        label: "Remote",
        reachable: true,
        latencyMs: 1,
        error: null,
        twAvailable: true,
        twVersion: "1",
        twError: null,
      },
    },
    cwdsBySession: {},
  }));
  assert.equal(remoteWithoutCwd.selectedCwd, null);
  assert.equal(remoteWithoutCwd.selectedGitHostId, "host-a");
  assert.equal(remoteWithoutCwd.fileBrowserRoot, null);

  const automation = (path: string, project: string) => ({
    id: "automation-a",
    name: "Automation A",
    instruction: "work",
    aiCmd: "codex",
    project,
    path,
    schedule: "",
    allowOverlap: false,
    active: true,
  });
  const automationInput = {
    selection: { kind: "automation", id: "automation-a" } as const,
    selectedSession: null,
  };
  const explicit = deriveWorkspacePresentation(baseInput({
    ...automationInput,
    automations: [automation("/explicit", "project-a")],
  }));
  assert.equal(explicit.selectedCwd, "/explicit");
  assert.equal(explicit.fileBrowserRoot, "/explicit");

  const preset = deriveWorkspacePresentation(baseInput({
    ...automationInput,
    automations: [automation("", "project-a")],
  }));
  assert.equal(preset.selectedAutomationProjectPath, "/projects/a");
  assert.equal(preset.fileBrowserRoot, "/projects/a");

  const desktop = deriveWorkspacePresentation(baseInput({
    ...automationInput,
    automations: [automation("", "missing-project")],
  }));
  assert.equal(desktop.selectedCwd, null);
  assert.equal(desktop.fileBrowserRoot, "/Users/example/Desktop");

  const unavailable = deriveWorkspacePresentation(baseInput({
    ...automationInput,
    automations: [automation("", "missing-project")],
    homeDirectory: null,
  }));
  assert.equal(unavailable.desktopRoot, null);
  assert.equal(unavailable.fileBrowserRoot, null);
});

test("file selection and status fallbacks stay tied to the current workspace", () => {
  const remoteTerminal = {
    id: "remote-terminal",
    label: "Remote terminal",
    cwd: "/remote/repo",
    tmuxName: "host-a:raw",
    hostId: "host-a",
    rawName: "raw",
  };
  const mismatchedFile = deriveWorkspacePresentation(baseInput({
    selection: { kind: "terminal", id: remoteTerminal.id },
    selectedSession: null,
    selectedTerminal: remoteTerminal,
    editingFile: { path: "/remote/repo/file.ts", hostId: "host-b" },
  }));
  assert.equal(mismatchedFile.files.kind, "tree");
  assert.equal(
    mismatchedFile.files.kind === "tree" ? mismatchedFile.files.selectedFile : "unexpected",
    null,
  );

  const statusOf = (
    overrides: Partial<WorkspacePresentationInput>,
  ) => deriveWorkspacePresentation(baseInput(overrides)).header.status;
  assert.equal(statusOf({
    selectedSession: { ...baseInput().selectedSession!, hostId: "missing-host" },
    hosts: [{ id: "missing-host", label: "Missing", host: "missing.example" }],
    hostStatuses: {},
  }), "reconnecting");

  const automation = (
    overrides: Partial<WorkspacePresentationInput["automations"][number]> = {},
  ) => ({
    id: "automation-a",
    name: "Automation A",
    instruction: "work",
    aiCmd: "codex",
    project: "project-a",
    path: "",
    schedule: "",
    allowOverlap: false,
    active: true,
    ...overrides,
  });
  const automationStatus = (items: WorkspacePresentationInput["automations"]) => statusOf({
    selection: { kind: "automation", id: "automation-a" },
    selectedSession: null,
    automations: items,
  });
  assert.equal(automationStatus([automation({ status: "failed" })]), "stopped");
  assert.equal(automationStatus([automation({ active: false })]), "stopped");
  assert.equal(automationStatus([]), "stopped");

  assert.equal(statusOf({
    sessionActivity: {
      "local-session": {
        ...baseInput().sessionActivity["local-session"],
        state: "stopped",
      },
    },
  }), "stopped");
  assert.equal(statusOf({
    cwdsBySession: {},
    sessionActivity: {},
  }), "waiting");
  assert.equal(statusOf({ sessionActivity: {} }), "unknown");
  assert.equal(statusOf({
    selection: { kind: "terminal", id: "missing-terminal" },
    selectedSession: null,
    selectedTerminal: null,
  }), "unknown");
});
