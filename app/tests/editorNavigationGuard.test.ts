import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  editingFileSourceKey,
  runGuardedEditorNavigation,
  runGuardedWorkspaceNavigation,
  type EditorDirtySnapshot,
} from "../src/editorNavigationGuard.ts";
import {
  beginFileEditorLoad,
  completeFileEditorLoad,
  editFileEditorContent,
  isFileEditorDirty,
  markFileEditorSaved,
} from "../src/fileEditorDirtyState.ts";
import { createLatestRequestGate } from "../src/latestRequestGate.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("dirty state resets after save and every file load", () => {
  let state = beginFileEditorLoad("local:a");
  assert.equal(isFileEditorDirty(state), false);

  state = completeFileEditorLoad(state, "local:a", "one");
  assert.equal(isFileEditorDirty(state), false);
  state = editFileEditorContent(state, "local:a", "two");
  assert.equal(isFileEditorDirty(state), true);
  state = markFileEditorSaved(state, "local:a", "two");
  assert.equal(isFileEditorDirty(state), false);

  state = editFileEditorContent(state, "local:a", "three");
  assert.equal(isFileEditorDirty(state), true);
  state = editFileEditorContent(state, "local:a", "four");
  state = markFileEditorSaved(state, "local:a", "three");
  assert.equal(isFileEditorDirty(state), true, "edits made during a save stay dirty");
  state = beginFileEditorLoad("remote:b");
  assert.equal(isFileEditorDirty(state), false);
  state = completeFileEditorLoad(state, "remote:b", "remote content");
  assert.equal(isFileEditorDirty(state), false);
});

test("clean navigation proceeds without prompting and dirty cancellation stays put", async () => {
  const gate = createLatestRequestGate();
  const fileKey = editingFileSourceKey({ path: "/repo/a.ts", hostId: null });
  let snapshot: EditorDirtySnapshot = { fileKey, dirty: false, revision: 1 };
  let navigations = 0;
  let confirmations = 0;

  assert.equal(await runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: async () => {
      confirmations += 1;
      return true;
    },
    navigate: () => {
      navigations += 1;
    },
  }), true);
  assert.equal(confirmations, 0);
  assert.equal(navigations, 1);

  snapshot = { ...snapshot, dirty: true, revision: 2 };
  assert.equal(await runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: async () => false,
    navigate: () => {
      navigations += 1;
    },
  }), false);
  assert.equal(navigations, 1);
});

test("late confirmations cannot replay an older navigation intent", async () => {
  const gate = createLatestRequestGate();
  const snapshot: EditorDirtySnapshot = {
    fileKey: editingFileSourceKey({ path: "/repo/a.ts", hostId: "builder" }),
    dirty: true,
    revision: 4,
  };
  const firstConfirm = deferred<boolean>();
  const secondConfirm = deferred<boolean>();
  const navigations: string[] = [];

  const first = runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: () => firstConfirm.promise,
    navigate: () => navigations.push("first"),
  });
  const second = runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: () => secondConfirm.promise,
    navigate: () => navigations.push("second"),
  });

  secondConfirm.resolve(true);
  assert.equal(await second, true);
  firstConfirm.resolve(true);
  assert.equal(await first, false);
  assert.deepEqual(navigations, ["second"]);
});

test("a confirmation is stale after the active document revision changes", async () => {
  const gate = createLatestRequestGate();
  let snapshot: EditorDirtySnapshot = {
    fileKey: editingFileSourceKey({ path: "/repo/a.ts", hostId: null }),
    dirty: true,
    revision: 1,
  };
  const confirm = deferred<boolean>();
  let navigated = false;
  const request = runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: () => confirm.promise,
    navigate: () => {
      navigated = true;
    },
  });

  snapshot = { ...snapshot, dirty: false, revision: 2 };
  confirm.resolve(true);
  assert.equal(await request, false);
  assert.equal(navigated, false);
});

test("workspace navigation protects an unsaved automation draft", async () => {
  const gate = createLatestRequestGate();
  let file = { key: null, dirty: false, revision: 0 };
  let automation = { key: "automation:daily", dirty: true, revision: 3 };
  let navigated = false;

  assert.equal(await runGuardedWorkspaceNavigation({
    gate,
    surfaces: [
      { ...file, getCurrent: () => file, confirmDiscard: async () => true },
      { ...automation, getCurrent: () => automation, confirmDiscard: async () => false },
    ],
    navigate: () => {
      navigated = true;
    },
  }), false);
  assert.equal(navigated, false);

  assert.equal(await runGuardedWorkspaceNavigation({
    gate,
    surfaces: [
      { ...file, getCurrent: () => file, confirmDiscard: async () => true },
      { ...automation, getCurrent: () => automation, confirmDiscard: async () => true },
    ],
    navigate: () => {
      navigated = true;
      automation = { ...automation, dirty: false, revision: 4 };
    },
  }), true);
  assert.equal(navigated, true);
});

test("App guards every editor-destructive routing entry point", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const editor = readFileSync(new URL("../src/FileEditor.tsx", import.meta.url), "utf8");

  assert.match(editor, /onDirtyChange\?: \(dirty: boolean\) => void/);
  assert.match(editor, /publishDirty\(isFileEditorDirty\(dirtyStateRef\.current\)\)/);
  assert.match(editor, /markFileEditorSaved/);
  assert.match(editor, /beginFileEditorLoad/);

  assert.match(app, /const requestEditorNavigation = useCallback/);
  assert.match(app, /const closeEditingFile = useCallback[\s\S]*?requestEditorNavigation/);
  assert.match(app, /const handleOpenFile = useCallback[\s\S]*?requestEditorNavigation/);
  assert.match(app, /const selectSession = useCallback[\s\S]*?requestEditorNavigation/);
  assert.match(app, /const selectTerminal = useCallback[\s\S]*?requestEditorNavigation/);
  assert.match(app, /const selectAutomation = useCallback[\s\S]*?requestEditorNavigation/);
  assert.match(app, /const openGitDiff = useCallback[\s\S]*?requestEditorNavigation/);
  assert.doesNotMatch(app, /expandInspectorView|renderExpandedView/);
  assert.match(app, /diffFile \? \(\s*<div className="dashboard-workspace__editor">/);
  assert.match(app, /onDirtyChange=\{handleEditorDirtyChange\}/);
  assert.match(app, /onDirtyChange=\{handleAutomationDirtyChange\}/);
  assert.match(app, /onNew=\{handleNewAutomation\}/);
  assert.match(app, /automationSubmitStillOwnsDraft\(originatingDraft/);
  assert.match(app, /automationSelectionIsCurrent\([\s\S]*?return Promise\.resolve\(false\)/);
});
